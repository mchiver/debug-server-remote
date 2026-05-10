const fs = require( 'fs' );
const path = require( 'path' );
const os = require( 'os' );
const https = require( 'https' );
const EnvRegistry = require( './EnvRegistry' );
const Archive = require( './Archive' );


//---------------------------------------------------------------------
// EnvInstaller.Node — installs an official Node.js distribution into the
// LlmDebugBridge environment registry.
//
// Distributions come from https://nodejs.org/dist/. Latest stable is
// resolved by querying the dist index. Each install produces a self
// contained directory with a working node executable plus npm.
//
// This installer is invoked by env.js (the CLI) as well as the
// node-tsx installer (which composes a node install and then layers
// tsx on top).
//---------------------------------------------------------------------


const NODE_DIST_INDEX_URL = 'https://nodejs.org/dist/index.json';


//---------------------------------------------------------------------
function fetch_url( url )
{
	return new Promise( function( resolve, reject )
	{
		const request = https.get( url, function( response )
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
		const request = https.get( url, function( response )
		{
			if ( response.statusCode === 301 || response.statusCode === 302 )
			{
				file.close();
				fs.unlinkSync( output_path );
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
// Resolve "latest" by querying nodejs.org/dist/index.json. The index is
// ordered newest-first. We pick the first entry that is an LTS line so
// fresh installs are stable by default.
//---------------------------------------------------------------------
async function resolve_latest_version()
{
	const buffer = await fetch_url( NODE_DIST_INDEX_URL );
	const releases = JSON.parse( buffer.toString( 'utf-8' ) );
	for ( let index = 0; index < releases.length; index++ )
	{
		const release = releases[ index ];
		if ( release.lts )
		{
			return release.version.replace( /^v/, '' );
		}
	}
	// Fallback: newest entry, LTS or not.
	return releases[ 0 ].version.replace( /^v/, '' );
}


//---------------------------------------------------------------------
// Resolve a partial version spec ('22' or '20.10') to a full x.y.z by
// scanning the dist index. Exact x.y.z specs pass through unchanged.
//---------------------------------------------------------------------
async function resolve_full_version( version_spec )
{
	if ( /^\d+\.\d+\.\d+$/.test( version_spec ) )
	{
		return version_spec;
	}
	const buffer = await fetch_url( NODE_DIST_INDEX_URL );
	const releases = JSON.parse( buffer.toString( 'utf-8' ) );
	const prefix = version_spec + '.';
	for ( let index = 0; index < releases.length; index++ )
	{
		const candidate = releases[ index ].version.replace( /^v/, '' );
		if ( candidate === version_spec || candidate.startsWith( prefix ) )
		{
			return candidate;
		}
	}
	throw new Error( 'No node release matches version spec: ' + version_spec );
}


//---------------------------------------------------------------------
// Build the canonical archive name and url for the host platform.
//---------------------------------------------------------------------
function platform_archive( version_string )
{
	const arch = process.arch === 'arm64' ? 'arm64' : ( process.arch === 'x64' ? 'x64' : process.arch );
	if ( process.platform === 'win32' )
	{
		const name = 'node-v' + version_string + '-win-' + arch;
		return {
			archive_name: name + '.zip',
			archive_url: 'https://nodejs.org/dist/v' + version_string + '/' + name + '.zip',
			extracted_root: name,
			format: 'zip'
		};
	}
	if ( process.platform === 'darwin' )
	{
		const name = 'node-v' + version_string + '-darwin-' + arch;
		return {
			archive_name: name + '.tar.gz',
			archive_url: 'https://nodejs.org/dist/v' + version_string + '/' + name + '.tar.gz',
			extracted_root: name,
			format: 'tar.gz'
		};
	}
	const name = 'node-v' + version_string + '-linux-' + arch;
	return {
		archive_name: name + '.tar.xz',
		archive_url: 'https://nodejs.org/dist/v' + version_string + '/' + name + '.tar.xz',
		extracted_root: name,
		format: 'tar.xz'
	};
}


//---------------------------------------------------------------------
// Extract an archive (zip or tar.*) into a target directory, then move
// the inner extracted-root directory's contents up one level so the
// final structure is <target>/<bin|node.exe>... rather than
// <target>/node-vX.Y.Z-<plat>-<arch>/...
//---------------------------------------------------------------------
function extract_archive( archive_path, target_dir, info )
{
	Archive.extract( archive_path, target_dir, info.format );

	// Promote contents of <target>/<extracted_root>/ up to <target>/.
	const inner_dir = path.join( target_dir, info.extracted_root );
	if ( !fs.existsSync( inner_dir ) )
	{
		// Some archives may already be flat; nothing to do.
		return;
	}
	const inner_entries = fs.readdirSync( inner_dir );
	for ( let index = 0; index < inner_entries.length; index++ )
	{
		const source = path.join( inner_dir, inner_entries[ index ] );
		const destination = path.join( target_dir, inner_entries[ index ] );
		fs.renameSync( source, destination );
	}
	fs.rmdirSync( inner_dir );
}


//---------------------------------------------------------------------
// Returns absolute paths to node and npm binaries inside an extracted
// node distribution, plus the directory that should be prepended to PATH
// so subprocesses (npm, npx, package binaries) resolve correctly.
//---------------------------------------------------------------------
function locate_binaries( environment_directory )
{
	if ( process.platform === 'win32' )
	{
		return {
			executable_path: path.join( environment_directory, 'node.exe' ),
			npm_command: path.join( environment_directory, 'npm.cmd' ),
			path_prepend: [ environment_directory ]
		};
	}
	return {
		executable_path: path.join( environment_directory, 'bin', 'node' ),
		npm_command: path.join( environment_directory, 'bin', 'npm' ),
		path_prepend: [ path.join( environment_directory, 'bin' ) ]
	};
}


//---------------------------------------------------------------------
// Install a node distribution into the registry. Returns the absolute
// path of the new environment directory.
//
// Options:
//   version       — partial or full version spec, or null for latest LTS.
//   force         — if true, replaces an existing environment of the same version.
//   on_progress   — optional function( message ) for status output.
//---------------------------------------------------------------------
async function install( options )
{
	const on_progress = options.on_progress || function() {};

	const version_string = options.version
		? await resolve_full_version( options.version )
		: await resolve_latest_version();

	on_progress( 'Resolved node version: ' + version_string );

	const environment_directory = EnvRegistry.environment_dir( 'node', version_string );

	if ( fs.existsSync( environment_directory ) )
	{
		if ( !options.force )
		{
			throw new Error( 'node v' + version_string + ' is already installed at ' + environment_directory + ' (use --force to replace)' );
		}
		on_progress( 'Removing existing install at ' + environment_directory );
		fs.rmSync( environment_directory, { recursive: true, force: true } );
	}

	const platform_info = platform_archive( version_string );
	const temp_archive = path.join( os.tmpdir(), 'ldb-' + Date.now() + '-' + platform_info.archive_name );

	on_progress( 'Downloading ' + platform_info.archive_url );
	await download_to_file( platform_info.archive_url, temp_archive );

	on_progress( 'Extracting into ' + environment_directory );
	EnvRegistry.ensure_registry_root();
	fs.mkdirSync( EnvRegistry.engine_root( 'node' ), { recursive: true } );
	try
	{
		extract_archive( temp_archive, environment_directory, platform_info );
	}
	finally
	{
		try { fs.unlinkSync( temp_archive ); } catch ( e ) { /* ignore */ }
	}

	const binaries = locate_binaries( environment_directory );

	if ( !fs.existsSync( binaries.executable_path ) )
	{
		throw new Error( 'Install completed but node binary missing at: ' + binaries.executable_path );
	}

	const payload = {
		engine: 'node',
		version: version_string,
		installed_at: new Date().toISOString(),
		executable_path: binaries.executable_path,
		path_prepend: binaries.path_prepend,
		env_vars: {},
		extras: {
			npm_command: binaries.npm_command
		}
	};
	EnvRegistry.write_registry_file( environment_directory, payload );

	on_progress( 'Installed node v' + version_string );
	return environment_directory;
}


//---------------------------------------------------------------------
module.exports = {
	install: install,
	resolve_latest_version: resolve_latest_version,
	resolve_full_version: resolve_full_version,
	locate_binaries: locate_binaries,
	platform_archive: platform_archive,
	download_to_file: download_to_file,
	extract_archive: extract_archive
};
