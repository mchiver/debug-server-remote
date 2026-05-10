const DebugBridge = require( 'debug-bridge' );
const WorkspaceManager = require( './components/WorkspaceManager' );
const Translator = require( './components/Translator' );
const SessionWorkspaceBinder = require( './components/SessionWorkspaceBinder' );


//---------------------------------------------------------------------
// WorkspaceBridge MCP server. Reuses every DebugBridge tool verbatim
// except for the two whose request bodies reference workspace paths
// or engine ids. Those are owned here: the handler runs the args
// through the Translator, calls SessionManager directly, and binds
// the resulting workspace through SessionWorkspaceBinder so ephemeral
// workspaces are destroyed when the session exits.
//---------------------------------------------------------------------


const SERVER_NAME = 'workspace-bridge';
const SERVER_VERSION = '0.1.0';


//---------------------------------------------------------------------
const WORKSPACE_PROPERTIES = {
	workspace_id:  { type: 'string', description: 'Persistent or ephemeral workspace id (POST /api/workspaces). Pair with relative_path or content.' },
	relative_path: { type: 'string', description: 'Path inside the workspace.' },
	files:         { type: 'object', description: 'Map of relative_path -> content; entry must be one of the keys.', additionalProperties: { type: 'string' } },
	entry:         { type: 'string', description: 'Which key in files is the program entry point.' },
	engine:        { type: 'string', description: "Engine id, e.g. 'node', 'node@22.5.1', 'node-tsx', 'python3'. Resolved against the local registry." }
};


//---------------------------------------------------------------------
function build_translated_tools( context )
{
	const debug_tools = DebugBridge.TOOLS;
	const out = [];
	for ( let i = 0; i < debug_tools.length; i++ )
	{
		const tool = debug_tools[ i ];
		if ( tool.name === 'create_session' )
		{
			out.push( wrap_create_session( tool, context ) );
		}
		else if ( tool.name === 'run_and_report' )
		{
			out.push( wrap_run_and_report( tool, context ) );
		}
		else
		{
			out.push( tool );
		}
	}
	return out;
}


//---------------------------------------------------------------------
function widen_schema( original_tool )
{
	const merged_properties = Object.assign(
		{},
		original_tool.input_schema && original_tool.input_schema.properties,
		WORKSPACE_PROPERTIES
	);
	return Object.assign(
		{},
		original_tool.input_schema || { type: 'object' },
		{ properties: merged_properties }
	);
}


//---------------------------------------------------------------------
function wrap_create_session( original_tool, context )
{
	return {
		name:        original_tool.name,
		description: original_tool.description + ' Accepts workspace_id+relative_path, workspace_id+content, files+entry, or absolute file_path. engine ids are resolved against the local registry.',
		input_schema: widen_schema( original_tool ),
		handler: async function( session_manager, args )
		{
			const translated = await context.translator.translate_session_body( args || {} );
			let session;
			try
			{
				session = await session_manager.create( translated.body );
			}
			catch ( err )
			{
				if ( translated.ephemeral_workspace_id )
				{
					try { context.workspace_manager.destroy( translated.ephemeral_workspace_id ); }
					catch ( e ) { /* ignore */ }
				}
				throw err;
			}
			const lifecycle_workspace_id = translated.ephemeral_workspace_id || ( args && args.workspace_id ) || null;
			if ( lifecycle_workspace_id )
			{
				const lifecycle = translated.ephemeral_workspace_id ? 'ephemeral' : 'persistent';
				context.binder.bind( session.id, lifecycle_workspace_id, lifecycle );
			}
			return { id: session.id, session: session.get_info() };
		}
	};
}


//---------------------------------------------------------------------
function wrap_run_and_report( original_tool, context )
{
	return {
		name:        original_tool.name,
		description: original_tool.description + ' Accepts workspace_id+relative_path, workspace_id+content, files+entry, or absolute file_path. engine ids are resolved against the local registry.',
		input_schema: widen_schema( original_tool ),
		handler: async function( session_manager, args )
		{
			const translated = await context.translator.translate_session_body( args || {} );
			try
			{
				return await session_manager.triage( translated.body );
			}
			finally
			{
				if ( translated.ephemeral_workspace_id )
				{
					try { context.workspace_manager.destroy( translated.ephemeral_workspace_id ); }
					catch ( e ) { /* ignore */ }
				}
			}
		}
	};
}


//---------------------------------------------------------------------
function create_server( options )
{
	const opts = options || {};
	const workspace_manager = opts.workspace_manager || new WorkspaceManager( opts.workspace_options || {} );
	const translator = opts.translator || new Translator( { workspace_manager: workspace_manager } );
	const session_manager = opts.session_manager || new DebugBridge.SessionManager();
	const binder = opts.binder || new SessionWorkspaceBinder( { workspace_manager: workspace_manager } );

	binder.attach( session_manager );

	const tools = build_translated_tools( {
		translator:        translator,
		workspace_manager: workspace_manager,
		binder:            binder
	} );

	const server = new DebugBridge.MCPServer( session_manager, {
		server_name:    SERVER_NAME,
		server_version: SERVER_VERSION,
		tools:          tools
	} );

	return {
		server:            server,
		session_manager:   session_manager,
		workspace_manager: workspace_manager,
		translator:        translator,
		binder:            binder,
		tools:             tools
	};
}


//---------------------------------------------------------------------
if ( require.main === module )
{
	const { server } = create_server();
	console.error( '[mcp] WorkspaceBridge MCP server ready on stdio' );
	server.serve_stdio();
}


module.exports = { create_server: create_server, SERVER_NAME: SERVER_NAME };
