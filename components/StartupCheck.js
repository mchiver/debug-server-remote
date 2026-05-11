const fs = require( 'fs' );
const ConfigManager = require( './ConfigManager' );
const EnvRegistry = require( './EnvRegistry' );
const NodeInstaller = require( './EnvInstaller.Node' );


//---------------------------------------------------------------------
// StartupCheck — ensures the config directory tree exists and auto-installs
// the latest Node runtime when the registry is completely empty.
//---------------------------------------------------------------------


//---------------------------------------------------------------------
async function run()
{
	ConfigManager.ensure_config_root();
	fs.mkdirSync( ConfigManager.workspace_root(), { recursive: true } );
	fs.mkdirSync( ConfigManager.registry_root(), { recursive: true } );

	const engines = EnvRegistry.list_engines();
	if ( engines.length === 0 )
	{
		await NodeInstaller.install( {
			version: null,
			on_progress: function( message ) { console.error( '[startup] ' + message ); }
		} );
	}
}


//---------------------------------------------------------------------
module.exports = { run: run };
