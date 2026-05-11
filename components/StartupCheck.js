const fs = require( 'fs' );
const ConfigManager = require( './ConfigManager' );
const EnvRegistry = require( './EnvRegistry' );


//---------------------------------------------------------------------
// StartupCheck — ensures the config directory tree exists and warns when
// the engine registry is empty so the caller knows to install a runtime.
//---------------------------------------------------------------------


//---------------------------------------------------------------------
function run()
{
	ConfigManager.ensure_config_root();
	fs.mkdirSync( ConfigManager.workspace_root(), { recursive: true } );
	fs.mkdirSync( ConfigManager.registry_root(), { recursive: true } );

	const engines = EnvRegistry.list_engines();
	if ( engines.length === 0 )
	{
		console.warn( '[startup] Engine registry is empty. Run: npm run env -- install node' );
	}
}


//---------------------------------------------------------------------
module.exports = { run: run };
