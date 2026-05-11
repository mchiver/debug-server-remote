const fs = require( 'fs' );
const path = require( 'path' );
const os = require( 'os' );
const https = require( 'https' );
const { spawnSync } = require( 'child_process' );
const EnvRegistry = require( './EnvRegistry' );
const Archive = require( './Archive' );


//---------------------------------------------------------------------
// EnvInstaller.Python3 — installs a self-contained CPython distribution
// into the LlmDebugBridge environment registry, then pip-installs
// debugpy so the python3 engine's DAP bridge has what it needs.
//
// Source: https://github.com/astral-sh/python-build-standalone
//
// python-build-standalone publishes pre-built CPython tarballs for
// Windows / macOS / Linux on every CPython release. Each release on
// GitHub bundles assets named like:
//
//   cpython-3.12.4+20240713-x86_64-pc-windows-msvc-install_only.tar.gz
//   cpython-3.12.4+20240713-aarch64-apple-darwin-install_only.tar.gz
//   cpython-3.12.4+20240713-x86_64-unknown-linux-gnu-install_only.tar.gz
//
// The "install_only" variant is a normal Python install layout (with
// pip and a regular site-packages) — no embeddable-zip surgery, no
// get-pip bootstrap, no _pth patching. It works the same way on every
// supported host so this installer can be platform-agnostic.
//---------------------------------------------------------------------


const STANDALONE_LATEST_URL = 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest';
const STANDALONE_RELEASES_URL = 'https://api.github.com/repos/astral-sh/python-build-standalone/releases?per_page=20';
const USER_AGENT = 'LlmDebugBridge-env-installer';


//---------------------------------------------------------------------
function fetch_url( url )
{
	return new Promise( function( resolve, reject )
	{
		const headers = {
			'User-Agent': USER_AGENT,
			'Accept': 'application/json'
		};
		const request = https.get( url, { headers: headers }, function( response )
		{
			if ( response.statusCode === 301 || response.statusCode === 302 )
			{
				resolve( fetch_url( response.headers.location ) );
				return;
			}
			if ( response.statusCode !== 200 )
			{
				reject( new Error( 'GET ' + url + ' failed with status ' + response.statusCode ) );
				return;
			}
			const chunks = [];
			response.on( 'data', function( chunk ) { chunks.push( chunk ); } );
			response.on( 'end', function() { resolve( Buffer.concat( chunks ) ); } );
			response.on( 'error', reject );
		} );
		request.on( 'error', reject );
	} );
}


//---------------------------------------------------------------------
function download_to_file( url, output_path )
{
	return new Promise( function( resolve, reject )
	{
		const file = fs.createWriteStream( output_path );
		const headers = { 'User-Agent': USER_AGENT };
		const request = https.get( url, { headers: headers }, function( response )
		{
			if ( response.statusCode === 301 || response.statusCode === 302 )
			{
				file.close();
				try { fs.unlinkSync( output_path ); } catch ( e ) { /* ignore */ }
				resolve( download_to_file( response.headers.location, output_path ) );
				return;
			}
			if ( response.statusCode !== 200 )
			{
				file.close();
				try { fs.unlinkSync( output_path ); } catch ( e ) { /* ignore */ }
				reject( new Error( 'GET ' + url + ' failed with status ' + response.statusCode ) );
				return;
			}
			response.pipe( file );
			file.on( 'finish', function() { file.close( resolve ); } );
			file.on( 'error', reject );
		} );
		request.on( 'error', reject );
	} );
}


//---------------------------------------------------------------------
// Build the host triplet used by python-build-standalone asset names.
// Throws if the host is one we don't recognise.
//---------------------------------------------------------------------
function host_triplet()
{
	const arch = process.arch === 'arm64' ? 'aarch64' : ( process.arch === 'x64' ? 'x86_64' : process.arch );
	if ( process.platform === 'win32' )
	{
		return arch + '-pc-windows-msvc';
	}
	if ( process.platform === 'darwin' )
	{
		return arch + '-apple-darwin';
	}
	if ( process.platform === 'linux' )
	{
		return arch + '-unknown-linux-gnu';
	}
	throw new Error( 'Unsupported host platform for python-build-standalone: ' + process.platform );
}


//---------------------------------------------------------------------
// Parse an install_only asset name. Asset filenames look like:
//   cpython-3.12.4+20240713-x86_64-pc-windows-msvc-install_only.tar.gz
//   cpython-3.12.4+20240713-x86_64-pc-windows-msvc-install_only_stripped.tar.gz
//
// Returns { version, build_date, triplet, stripped } or null if the
// asset isn't an install_only python tarball.
//---------------------------------------------------------------------
function parse_asset_name( asset_name )
{
	const match = asset_name.match( /^cpython-(\d+\.\d+\.\d+)\+(\d+)-(.+?)-install_only(_stripped)?\.tar\.gz$/ );
	if ( !match )
	{
		return null;
	}
	return {
		version: match[ 1 ],
		build_date: match[ 2 ],
		triplet: match[ 3 ],
		stripped: match[ 4 ] === '_stripped'
	};
}


//---------------------------------------------------------------------
// Compare two semver tuples ([major, minor, patch]) descending.
//---------------------------------------------------------------------
function compare_tuples_desc( a, b )
{
	for ( let index = 0; index < 3; index++ )
	{
		if ( a[ index ] !== b[ index ] )
		{
			return b[ index ] - a[ index ];
		}
	}
	return 0;
}


//---------------------------------------------------------------------
// Walk a python-build-standalone GitHub release's asset list, picking
// the install_only tarball whose version matches version_spec for the
// host triplet. Returns null if no asset in this release matches.
//
// Prefers the non-stripped variant to keep debug symbols available.
//---------------------------------------------------------------------
function find_matching_asset( release, triplet, version_spec )
{
	const candidates = [];
	const assets = release.assets || [];
	for ( let index = 0; index < assets.length; index++ )
	{
		const asset = assets[ index ];
		const parsed = parse_asset_name( asset.name );
		if ( !parsed )
		{
			continue;
		}
		if ( parsed.triplet !== triplet )
		{
			continue;
		}
		if ( version_spec )
		{
			const prefix = version_spec + '.';
			if ( parsed.version !== version_spec && !parsed.version.startsWith( prefix ) )
			{
				continue;
			}
		}
		candidates.push( {
			parsed: parsed,
			download_url: asset.browser_download_url,
			name: asset.name
		} );
	}
	if ( candidates.length === 0 )
	{
		return null;
	}
	candidates.sort( function( a, b )
	{
		// Prefer non-stripped, then highest version.
		if ( a.parsed.stripped !== b.parsed.stripped )
		{
			return a.parsed.stripped ? 1 : -1;
		}
		const va = a.parsed.version.split( '.' ).map( Number );
		const vb = b.parsed.version.split( '.' ).map( Number );
		return compare_tuples_desc( va, vb );
	} );
	return candidates[ 0 ];
}


//---------------------------------------------------------------------
// Resolve (version_spec, triplet) to a concrete asset by searching the
// most recent few python-build-standalone releases. version_spec may be
// null (newest available), '3', '3.12', or '3.12.4'.
//---------------------------------------------------------------------
async function find_release_asset( version_spec )
{
	const triplet = host_triplet();

	// Try the latest release first — in steady state it carries the
	// freshest assets for every supported python line.
	const latest_buffer = await fetch_url( STANDALONE_LATEST_URL );
	const latest = JSON.parse( latest_buffer.toString( 'utf-8' ) );
	const latest_match = find_matching_asset( latest, triplet, version_spec );
	if ( latest_match )
	{
		return latest_match;
	}

	// Fall back to scanning the recent releases page when the latest
	// release doesn't carry the requested line (e.g. user asked for an
	// older minor that has rolled off the most recent build).
	const releases_buffer = await fetch_url( STANDALONE_RELEASES_URL );
	const releases = JSON.parse( releases_buffer.toString( 'utf-8' ) );
	for ( let index = 0; index < releases.length; index++ )
	{
		const match = find_matching_asset( releases[ index ], triplet, version_spec );
		if ( match )
		{
			return match;
		}
	}

	throw new Error(
		'No python-build-standalone asset found for ' +
		( version_spec ? ( 'python ' + version_spec ) : 'any python version' ) +
		' on triplet "' + triplet + '". See: https://github.com/astral-sh/python-build-standalone/releases'
	);
}


//---------------------------------------------------------------------
// Locate the python interpreter inside an extracted install_only tree.
// On Windows the binary lives at <env>/python.exe; on POSIX hosts it's
// at <env>/bin/python3.
//---------------------------------------------------------------------
function locate_python( environment_directory )
{
	if ( process.platform === 'win32' )
	{
		const exe = path.join( environment_directory, 'python.exe' );
		if ( fs.existsSync( exe ) )
		{
			return {
				executable_path: exe,
				path_prepend: [ environment_directory, path.join( environment_directory, 'Scripts' ) ].filter( function( p ) { return fs.existsSync( p ); } )
			};
		}
	}
	const posix_exe = path.join( environment_directory, 'bin', 'python3' );
	if ( fs.existsSync( posix_exe ) )
	{
		return {
			executable_path: posix_exe,
			path_prepend: [ path.join( environment_directory, 'bin' ) ]
		};
	}
	const fallback_exe = path.join( environment_directory, 'bin', 'python' );
	if ( fs.existsSync( fallback_exe ) )
	{
		return {
			executable_path: fallback_exe,
			path_prepend: [ path.join( environment_directory, 'bin' ) ]
		};
	}
	return null;
}


//---------------------------------------------------------------------
// install_only tarballs unpack to a top-level "python/" directory. We
// promote that directory's contents up to environment_directory so the
// layout matches the rest of the registry.
//---------------------------------------------------------------------
function flatten_python_root( environment_directory )
{
	const inner = path.join( environment_directory, 'python' );
	if ( !fs.existsSync( inner ) )
	{
		return;
	}
	const entries = fs.readdirSync( inner );
	for ( let index = 0; index < entries.length; index++ )
	{
		fs.renameSync( path.join( inner, entries[ index ] ), path.join( environment_directory, entries[ index ] ) );
	}
	fs.rmdirSync( inner );
}


//---------------------------------------------------------------------
function install_debugpy( python_executable, on_progress )
{
	on_progress( 'Installing debugpy via pip' );
	const result = spawnSync(
		python_executable,
		[ '-m', 'pip', 'install', '--no-warn-script-location', '--disable-pip-version-check', 'debugpy' ],
		{ stdio: 'inherit' }
	);
	if ( result.status !== 0 )
	{
		throw new Error( 'pip install debugpy failed with exit code ' + result.status );
	}
}


//---------------------------------------------------------------------
async function install( options )
{
	const on_progress = options.on_progress || function() {};

	on_progress( 'Querying python-build-standalone releases' );
	const asset = await find_release_asset( options.version || null );
	const version_string = asset.parsed.version;
	on_progress( 'Selected python ' + version_string + ' (' + asset.parsed.triplet + ', build ' + asset.parsed.build_date + ')' );

	const environment_directory = EnvRegistry.environment_dir( 'python3', version_string );

	if ( fs.existsSync( environment_directory ) )
	{
		if ( !options.force )
		{
			throw new Error( 'python3 v' + version_string + ' is already installed at ' + environment_directory + ' (use --force to replace)' );
		}
		on_progress( 'Removing existing install at ' + environment_directory );
		fs.rmSync( environment_directory, { recursive: true, force: true } );
	}

	const tmp_archive = path.join( os.tmpdir(), 'dsr-py-' + Date.now() + '-' + asset.name );

	on_progress( 'Downloading ' + asset.download_url );
	await download_to_file( asset.download_url, tmp_archive );

	on_progress( 'Extracting into ' + environment_directory );
	EnvRegistry.ensure_registry_root();
	fs.mkdirSync( environment_directory, { recursive: true } );
	try
	{
		Archive.extract( tmp_archive, environment_directory, 'tar.gz' );
	}
	finally
	{
		try { fs.unlinkSync( tmp_archive ); } catch ( e ) { /* ignore */ }
	}

	flatten_python_root( environment_directory );

	const located = locate_python( environment_directory );
	if ( !located )
	{
		throw new Error( 'Install completed but no python executable was located inside ' + environment_directory );
	}

	install_debugpy( located.executable_path, on_progress );

	const payload = {
		engine: 'python3',
		version: version_string,
		installed_at: new Date().toISOString(),
		executable_path: located.executable_path,
		path_prepend: located.path_prepend,
		env_vars: {},
		extras: {
			has_debugpy: true,
			source: 'python-build-standalone',
			build_date: asset.parsed.build_date,
			triplet: asset.parsed.triplet
		}
	};
	EnvRegistry.write_registry_file( environment_directory, payload );

	on_progress( 'Installed python3 v' + version_string );
	return environment_directory;
}


//---------------------------------------------------------------------
module.exports = {
	install: install,
	host_triplet: host_triplet,
	parse_asset_name: parse_asset_name,
	find_release_asset: find_release_asset
};
