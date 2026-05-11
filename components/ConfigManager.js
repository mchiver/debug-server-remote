const fs = require( 'fs' );
const path = require( 'path' );
const os = require( 'os' );


//---------------------------------------------------------------------
// ConfigManager — centralised project paths.
//
// All on-disk state lives under ~/.config/mchiver/debug-server-remote/:
//   workspaces/   — workspace directories (persistent + ephemeral)
//   registry/     — language-engine installations
//---------------------------------------------------------------------


const CONFIG_ROOT = path.join( os.homedir(), '.config', 'mchiver', 'debug-server-remote' );


//---------------------------------------------------------------------
function config_root()
{
	return CONFIG_ROOT;
}


//---------------------------------------------------------------------
function ensure_config_root()
{
	if ( !fs.existsSync( CONFIG_ROOT ) )
	{
		fs.mkdirSync( CONFIG_ROOT, { recursive: true } );
	}
}


//---------------------------------------------------------------------
function workspace_root()
{
	return path.join( CONFIG_ROOT, 'workspaces' );
}


//---------------------------------------------------------------------
function registry_root()
{
	return path.join( CONFIG_ROOT, 'registry' );
}


//---------------------------------------------------------------------
module.exports = {
	config_root:    config_root,
	ensure_config_root: ensure_config_root,
	workspace_root: workspace_root,
	registry_root:  registry_root
};
