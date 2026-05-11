const fs = require( 'fs' );
const path = require( 'path' );
const { spawnSync } = require( 'child_process' );
const EnvRegistry = require( './EnvRegistry' );
const NodeInstaller = require( './EnvInstaller.Node' );


//---------------------------------------------------------------------
// EnvInstaller.NodeTsx — installs a Node.js distribution PLUS the tsx
// loader package as a self-contained registry environment.
//
// The resulting environment directory is structured exactly like a node
// install (so the same `executable_path` / `path_prepend` semantics
// apply) with a top-level node_modules/tsx present so the engine
// factory can pass `--import <tsx-loader>` when spawning a child.
//---------------------------------------------------------------------


//---------------------------------------------------------------------
function find_tsx_loader( environment_directory )
{
	const candidates = [
		path.join( environment_directory, 'node_modules', 'tsx', 'dist', 'loader.mjs' ),
		path.join( environment_directory, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs' ),
		path.join( environment_directory, 'node_modules', 'tsx', 'dist', 'esm', 'index.js' ),
		path.join( environment_directory, 'node_modules', 'tsx', 'dist', 'cli.mjs' )
	];
	for ( let index = 0; index < candidates.length; index++ )
	{
		if ( fs.existsSync( candidates[ index ] ) )
		{
			return candidates[ index ];
		}
	}
	// Fall back to require.resolve from inside the new node install.
	const package_main = path.join( environment_directory, 'node_modules', 'tsx', 'package.json' );
	if ( fs.existsSync( package_main ) )
	{
		const pkg = JSON.parse( fs.readFileSync( package_main, 'utf-8' ) );
		const main_entry = pkg.module || pkg.main;
		if ( main_entry )
		{
			return path.join( environment_directory, 'node_modules', 'tsx', main_entry );
		}
	}
	return null;
}


//---------------------------------------------------------------------
function install_tsx_package( environment_directory, npm_command, on_progress )
{
	const result = spawnSync(
		npm_command,
		[ 'install', '--no-save', '--no-fund', '--no-audit', 'tsx' ],
		{
			cwd: environment_directory,
			stdio: 'inherit',
			shell: process.platform === 'win32'
		}
	);
	if ( result.status !== 0 )
	{
		throw new Error( 'npm install tsx failed with exit code ' + result.status );
	}
	on_progress( 'tsx installed into ' + environment_directory );
}


//---------------------------------------------------------------------
async function install( options )
{
	const on_progress = options.on_progress || function() {};

	const version_string = options.version
		? await NodeInstaller.resolve_full_version( options.version )
		: await NodeInstaller.resolve_latest_version();

	on_progress( 'Resolved node-tsx version: ' + version_string );

	const environment_directory = EnvRegistry.environment_dir( 'node-tsx', version_string );

	if ( fs.existsSync( environment_directory ) )
	{
		if ( !options.force )
		{
			throw new Error( 'node-tsx v' + version_string + ' is already installed at ' + environment_directory + ' (use --force to replace)' );
		}
		on_progress( 'Removing existing install at ' + environment_directory );
		fs.rmSync( environment_directory, { recursive: true, force: true } );
	}

	const platform_info = NodeInstaller.platform_archive( version_string );
	const tmp_archive = path.join( require( 'os' ).tmpdir(), 'dsr-tsx-' + Date.now() + '-' + platform_info.archive_name );

	on_progress( 'Downloading ' + platform_info.archive_url );
	await NodeInstaller.download_to_file( platform_info.archive_url, tmp_archive );

	on_progress( 'Extracting into ' + environment_directory );
	EnvRegistry.ensure_registry_root();
	fs.mkdirSync( EnvRegistry.engine_root( 'node-tsx' ), { recursive: true } );
	try
	{
		NodeInstaller.extract_archive( tmp_archive, environment_directory, platform_info );
	}
	finally
	{
		try { fs.unlinkSync( tmp_archive ); } catch ( e ) { /* ignore */ }
	}

	const binaries = NodeInstaller.locate_binaries( environment_directory );

	if ( !fs.existsSync( binaries.executable_path ) )
	{
		throw new Error( 'Install completed but node binary missing at: ' + binaries.executable_path );
	}

	on_progress( 'Installing tsx package via npm' );
	install_tsx_package( environment_directory, binaries.npm_command, on_progress );

	const tsx_loader_path = find_tsx_loader( environment_directory );
	if ( !tsx_loader_path )
	{
		throw new Error( 'tsx package was installed but no loader entry point could be located inside ' + environment_directory );
	}

	const payload = {
		engine: 'node-tsx',
		version: version_string,
		installed_at: new Date().toISOString(),
		executable_path: binaries.executable_path,
		path_prepend: binaries.path_prepend,
		env_vars: {},
		extras: {
			npm_command: binaries.npm_command,
			tsx_loader_path: tsx_loader_path
		}
	};
	EnvRegistry.write_registry_file( environment_directory, payload );

	on_progress( 'Installed node-tsx v' + version_string );
	return environment_directory;
}


//---------------------------------------------------------------------
module.exports = {
	install: install,
	find_tsx_loader: find_tsx_loader
};
