const fs = require( 'fs' );
const path = require( 'path' );
const EnvRegistry = require( './components/EnvRegistry' );


//---------------------------------------------------------------------
// env.js — LlmDebugBridge environment manager.
//
// Maintains a registry of self-contained runtime environments at
//   ~/.config/ldb-debug-bridge/env-registry/<engine>/v<x.y.z>/
// Each entry is a complete language distribution (plus any tooling like
// tsx or debugpy) that a debug session activates by manipulating the
// child process environment.
//
// Commands:
//   env list
//   env install <engine> [version] [--force]
//   env uninstall <engine> [version]
//---------------------------------------------------------------------


const SUPPORTED_ENGINES = [ 'node', 'node-tsx', 'python3' ];


//---------------------------------------------------------------------
function print_usage()
{
	process.stdout.write( 'Usage: node env.js <command> [...args]\n' );
	process.stdout.write( '\n' );
	process.stdout.write( 'Commands:\n' );
	process.stdout.write( '  list                              List installed environments\n' );
	process.stdout.write( '  install <engine> [version]        Install an engine into the registry\n' );
	process.stdout.write( '  uninstall <engine> [version]      Remove an engine from the registry\n' );
	process.stdout.write( '\n' );
	process.stdout.write( 'Engines: ' + SUPPORTED_ENGINES.join( ', ' ) + '\n' );
	process.stdout.write( 'Version forms: omit (latest stable) | "22" | "22.5" | "22.5.1"\n' );
	process.stdout.write( 'Flags: --force        Replace an existing install of the same version\n' );
}


//---------------------------------------------------------------------
function progress_logger( message )
{
	process.stdout.write( '[env] ' + message + '\n' );
}


//---------------------------------------------------------------------
function command_list()
{
	const root = EnvRegistry.registry_root();
	process.stdout.write( 'Registry: ' + root + '\n' );
	const engines = EnvRegistry.list_engines();
	if ( engines.length === 0 )
	{
		process.stdout.write( '(no environments installed)\n' );
		return 0;
	}
	for ( let engine_index = 0; engine_index < engines.length; engine_index++ )
	{
		const engine = engines[ engine_index ];
		process.stdout.write( engine + '/\n' );
		const versions = EnvRegistry.list_versions( engine );
		for ( let version_index = 0; version_index < versions.length; version_index++ )
		{
			const entry = versions[ version_index ];
			if ( entry.broken )
			{
				process.stdout.write( '  v' + entry.version_string + '  [BROKEN — missing or invalid env-registry.json]\n' );
				continue;
			}
			process.stdout.write( '  v' + entry.version_string + '  ' + entry.registry_data.executable_path + '\n' );
		}
	}
	return 0;
}


//---------------------------------------------------------------------
async function command_install( engine, version, flags )
{
	if ( !engine )
	{
		process.stderr.write( 'install: <engine> is required\n' );
		return 2;
	}
	if ( SUPPORTED_ENGINES.indexOf( engine ) === -1 )
	{
		process.stderr.write( 'install: unknown engine "' + engine + '" (supported: ' + SUPPORTED_ENGINES.join( ', ' ) + ')\n' );
		return 2;
	}

	const installer = load_installer( engine );
	const options = {
		version: version || null,
		force: flags.force === true,
		on_progress: progress_logger
	};

	const target_dir = await installer.install( options );
	process.stdout.write( 'Installed ' + engine + ' to ' + target_dir + '\n' );
	return 0;
}


//---------------------------------------------------------------------
function load_installer( engine )
{
	if ( engine === 'node' )
	{
		return require( './components/EnvInstaller.Node' );
	}
	if ( engine === 'node-tsx' )
	{
		return require( './components/EnvInstaller.NodeTsx' );
	}
	if ( engine === 'python3' )
	{
		return require( './components/EnvInstaller.Python3' );
	}
	throw new Error( 'No installer registered for engine: ' + engine );
}


//---------------------------------------------------------------------
function command_uninstall( engine, version )
{
	if ( !engine )
	{
		process.stderr.write( 'uninstall: <engine> is required\n' );
		return 2;
	}

	if ( !version )
	{
		const root = EnvRegistry.engine_root( engine );
		if ( !fs.existsSync( root ) )
		{
			process.stderr.write( 'uninstall: nothing to remove for engine "' + engine + '"\n' );
			return 1;
		}
		fs.rmSync( root, { recursive: true, force: true } );
		process.stdout.write( 'Removed all installed versions of ' + engine + '\n' );
		return 0;
	}

	// Strip an optional leading 'v' so callers can pass either form.
	const cleaned = version.replace( /^v/, '' );
	const target_dir = EnvRegistry.environment_dir( engine, cleaned );
	if ( !fs.existsSync( target_dir ) )
	{
		process.stderr.write( 'uninstall: ' + engine + ' v' + cleaned + ' is not installed\n' );
		return 1;
	}
	fs.rmSync( target_dir, { recursive: true, force: true } );
	process.stdout.write( 'Removed ' + engine + ' v' + cleaned + '\n' );

	// Clean up the engine root directory if it's now empty.
	const engine_dir = EnvRegistry.engine_root( engine );
	if ( fs.existsSync( engine_dir ) && fs.readdirSync( engine_dir ).length === 0 )
	{
		fs.rmdirSync( engine_dir );
	}
	return 0;
}


//---------------------------------------------------------------------
// Split argv into positional arguments and a small flag bag. Only --force
// is recognised; unknown flags terminate with a clear error.
//---------------------------------------------------------------------
function parse_argv( argv )
{
	const positional = [];
	const flags = { force: false };
	for ( let index = 0; index < argv.length; index++ )
	{
		const token = argv[ index ];
		if ( token === '--force' )
		{
			flags.force = true;
		}
		else if ( token === '--help' || token === '-h' )
		{
			flags.help = true;
		}
		else if ( token.startsWith( '--' ) )
		{
			throw new Error( 'Unknown flag: ' + token );
		}
		else
		{
			positional.push( token );
		}
	}
	return { positional: positional, flags: flags };
}


//---------------------------------------------------------------------
async function main( argv )
{
	let parsed;
	try
	{
		parsed = parse_argv( argv );
	}
	catch ( err )
	{
		process.stderr.write( err.message + '\n' );
		print_usage();
		return 2;
	}

	const command = parsed.positional[ 0 ];
	if ( !command || parsed.flags.help )
	{
		print_usage();
		return command ? 0 : 2;
	}

	if ( command === 'list' )
	{
		return command_list();
	}
	if ( command === 'install' )
	{
		return await command_install( parsed.positional[ 1 ], parsed.positional[ 2 ], parsed.flags );
	}
	if ( command === 'uninstall' )
	{
		return command_uninstall( parsed.positional[ 1 ], parsed.positional[ 2 ] );
	}

	process.stderr.write( 'Unknown command: ' + command + '\n' );
	print_usage();
	return 2;
}


//---------------------------------------------------------------------
if ( require.main === module )
{
	main( process.argv.slice( 2 ) ).then(
		function( exit_code ) { process.exit( exit_code || 0 ); },
		function( err )
		{
			process.stderr.write( 'env: ' + ( err && err.message ? err.message : err ) + '\n' );
			process.exit( 1 );
		}
	);
}


module.exports = { main: main };
