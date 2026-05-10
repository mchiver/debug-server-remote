const express = require( 'express' );
const http = require( 'http' );
const path = require( 'path' );
const { exec } = require( 'child_process' );
const { WebSocketServer } = require( 'ws' );

const DebugBridge = require( 'debug-bridge' );
const WorkspaceManager = require( './components/WorkspaceManager' );
const EnvRegistry = require( './components/EnvRegistry' );
const Translator = require( './components/Translator' );
const SessionWorkspaceBinder = require( './components/SessionWorkspaceBinder' );

const PORT = 4200;


//---------------------------------------------------------------------
// WorkspaceBridge build_app: assembles the full host system around
// DebugBridge.
//
//   - Workspace + registry routes are owned here.
//   - The three creation routes that take workspace-shaped bodies are
//     handled here, calling DebugBridge.SessionManager programmatically
//     after running input through the Translator.
//   - DebugBridge.create_router() is mounted at /api after the overrides;
//     Express's first-match wins, so the mount serves every other route.
//   - SessionWorkspaceBinder owns the session_id -> workspace map and
//     destroys ephemeral workspaces when their session exits.
//---------------------------------------------------------------------
function create_app( options )
{
	const opts = options || {};
	const workspace_manager = opts.workspace_manager || new WorkspaceManager( opts.workspace_options || {} );
	const translator = opts.translator || new Translator( { workspace_manager: workspace_manager } );
	const session_manager = opts.session_manager || new DebugBridge.SessionManager();
	const binder = opts.binder || new SessionWorkspaceBinder( { workspace_manager: workspace_manager } );

	const app = express();
	const server = http.createServer( app );
	const wss = new WebSocketServer( { server: server } );

	app.use( express.json( { limit: workspace_manager.max_bytes } ) );
	app.use( express.static( path.join( __dirname, 'public' ) ) );

	const clients = new Set();

	function ws_broadcast( event, data )
	{
		const message = JSON.stringify( { event: event, data: data } );
		for ( const client of clients )
		{
			if ( client.readyState === 1 )
			{
				client.send( message );
			}
		}
	}

	// Install the WS broadcast first, then chain the binder's cleanup
	// in front of it. Both run on every event.
	session_manager.set_broadcast_handler( ws_broadcast );
	binder.attach( session_manager );

	wss.on( 'connection', function( ws )
	{
		clients.add( ws );
		ws.send( JSON.stringify( {
			event: 'session_list',
			data: { sessions: session_manager.list() }
		} ) );
		ws.on( 'close', function()
		{
			clients.delete( ws );
		} );
	} );

	//---------------------------------------------------------------------
	// Workspace routes (owned by WorkspaceBridge).
	//---------------------------------------------------------------------
	app.post( '/api/workspaces', function( req, res )
	{
		try
		{
			const ws = workspace_manager.create( {
				lifecycle: 'persistent',
				name: ( req.body && req.body.name ) || undefined
			} );
			res.status( 201 ).json( { workspace: ws } );
		}
		catch ( err )
		{
			res.status( 400 ).json( { error: err.message } );
		}
	} );

	app.get( '/api/workspaces', function( req, res )
	{
		const include_ephemeral = req.query.include_ephemeral === '1' || req.query.include_ephemeral === 'true';
		res.json( { workspaces: workspace_manager.list( { include_ephemeral: include_ephemeral } ) } );
	} );

	app.get( '/api/workspaces/:id', function( req, res )
	{
		const ws = workspace_manager.get( req.params.id );
		if ( !ws )
		{
			return res.status( 404 ).json( { error: 'Workspace not found' } );
		}
		try
		{
			const files = workspace_manager.list_files( req.params.id );
			res.json( { workspace: ws, files: files } );
		}
		catch ( err )
		{
			res.status( 500 ).json( { error: err.message } );
		}
	} );

	app.delete( '/api/workspaces/:id', function( req, res )
	{
		const ws = workspace_manager.get( req.params.id );
		if ( !ws )
		{
			return res.status( 404 ).json( { error: 'Workspace not found' } );
		}
		if ( ws.lifecycle === 'ephemeral' )
		{
			return res.status( 409 ).json( { error: 'Ephemeral workspaces are deleted via their owning session' } );
		}
		const sessions = session_manager.list();
		for ( let i = 0; i < sessions.length; i++ )
		{
			if ( sessions[ i ].file_path && sessions[ i ].file_path.startsWith( ws.root + path.sep ) )
			{
				return res.status( 409 ).json( { error: 'Workspace is in use by an active session' } );
			}
		}
		workspace_manager.destroy( req.params.id );
		res.json( { success: true } );
	} );

	app.post( '/api/workspaces/:id/init', async function( req, res )
	{
		const ws = workspace_manager.get( req.params.id );
		if ( !ws )
		{
			return res.status( 404 ).json( { error: 'Workspace not found' } );
		}
		const force = req.query.force === '1' || req.query.force === 'true';
		const content_type = ( req.headers[ 'content-type' ] || '' ).toLowerCase();
		const stream = needs_gunzip( content_type ) ? gunzip_stream( req ) : req;
		try
		{
			await workspace_manager.init_from_tar( req.params.id, stream, { force: force } );
			res.json( { workspace: workspace_manager.get( req.params.id ), files: workspace_manager.list_files( req.params.id ) } );
		}
		catch ( err )
		{
			res.status( 400 ).json( { error: err.message } );
		}
	} );

	app.get( '/api/workspaces/:id/files/*', function( req, res )
	{
		const ws = workspace_manager.get( req.params.id );
		if ( !ws )
		{
			return res.status( 404 ).json( { error: 'Workspace not found' } );
		}
		const rel = req.params[ 0 ];
		try
		{
			const buffer = workspace_manager.read_file( req.params.id, rel );
			res.type( 'application/octet-stream' );
			res.send( buffer );
		}
		catch ( err )
		{
			res.status( 404 ).json( { error: err.message } );
		}
	} );

	app.put( '/api/workspaces/:id/files/*', express.raw( { type: '*/*', limit: workspace_manager.max_bytes } ), function( req, res )
	{
		const ws = workspace_manager.get( req.params.id );
		if ( !ws )
		{
			return res.status( 404 ).json( { error: 'Workspace not found' } );
		}
		const rel = req.params[ 0 ];
		try
		{
			const buf = Buffer.isBuffer( req.body ) ? req.body : Buffer.from( req.body || '' );
			workspace_manager.write_file( req.params.id, rel, buf );
			res.json( { success: true, path: rel, size: buf.length } );
		}
		catch ( err )
		{
			res.status( 400 ).json( { error: err.message } );
		}
	} );

	app.delete( '/api/workspaces/:id/files/*', function( req, res )
	{
		const ws = workspace_manager.get( req.params.id );
		if ( !ws )
		{
			return res.status( 404 ).json( { error: 'Workspace not found' } );
		}
		const rel = req.params[ 0 ];
		try
		{
			workspace_manager.delete_file( req.params.id, rel );
			res.json( { success: true } );
		}
		catch ( err )
		{
			res.status( 404 ).json( { error: err.message } );
		}
	} );

	//---------------------------------------------------------------------
	// Registry route.
	//---------------------------------------------------------------------
	app.get( '/api/registry', function( req, res )
	{
		const engines = EnvRegistry.list_engines();
		const out = [];
		for ( let i = 0; i < engines.length; i++ )
		{
			const base = engines[ i ];
			const versions = EnvRegistry.list_versions( base );
			const version_list = [];
			for ( let j = 0; j < versions.length; j++ )
			{
				const v = versions[ j ];
				version_list.push( {
					version_string: v.version_string,
					executable_path: v.registry_data ? v.registry_data.executable_path : null,
					broken: v.broken
				} );
			}
			out.push( { base: base, versions: version_list } );
		}
		res.json( { engines: out } );
	} );

	//---------------------------------------------------------------------
	// Translated session-creation routes. Registered BEFORE the DebugBridge
	// mount so Express's first-match wins. Each handler runs the body
	// through the Translator and then calls SessionManager directly,
	// binding any resulting workspace through SessionWorkspaceBinder.
	//---------------------------------------------------------------------

	app.post( '/api/sessions', async function( req, res )
	{
		let translated;
		try
		{
			translated = await translator.translate_session_body( req.body || {} );
		}
		catch ( err )
		{
			return res.status( 400 ).json( { error: err.message } );
		}
		try
		{
			const session = await session_manager.create( translated.body );
			const lifecycle_workspace_id = translated.ephemeral_workspace_id || ( req.body && req.body.workspace_id ) || null;
			if ( lifecycle_workspace_id )
			{
				const lifecycle = translated.ephemeral_workspace_id ? 'ephemeral' : 'persistent';
				binder.bind( session.id, lifecycle_workspace_id, lifecycle );
			}
			res.status( 201 ).json( { id: session.id, session: session.get_info() } );
		}
		catch ( err )
		{
			// Session never started; clean up any ephemeral workspace we
			// just materialized so it doesn't leak.
			if ( translated && translated.ephemeral_workspace_id )
			{
				try { workspace_manager.destroy( translated.ephemeral_workspace_id ); }
				catch ( e ) { /* ignore */ }
			}
			res.status( 500 ).json( { error: err.message } );
		}
	} );

	app.post( '/api/triage', async function( req, res )
	{
		let translated;
		try
		{
			translated = await translator.translate_session_body( req.body || {} );
		}
		catch ( err )
		{
			return res.status( 400 ).json( { error: err.message } );
		}
		try
		{
			const report = await session_manager.triage( translated.body );
			res.json( report );
		}
		catch ( err )
		{
			res.status( 500 ).json( { error: err.message } );
		}
		finally
		{
			// triage destroys its own session before returning; the binder
			// never had a chance to see it, so destroy the ephemeral
			// workspace synchronously here.
			if ( translated.ephemeral_workspace_id )
			{
				try { workspace_manager.destroy( translated.ephemeral_workspace_id ); }
				catch ( e ) { /* ignore */ }
			}
		}
	} );

	//---------------------------------------------------------------------
	// /sessions/:id/exec — same shape as DebugBridge's exec handler but
	// uses the workspace root (when known) as cwd. This is the one route
	// where workspace knowledge improves behavior even after creation.
	//---------------------------------------------------------------------
	app.post( '/api/sessions/:id/exec', async function( req, res )
	{
		const session = session_manager.get( req.params.id );
		if ( !session )
		{
			return res.status( 404 ).json( { error: 'Session not found' } );
		}
		const command = req.body.command;
		if ( !command )
		{
			return res.status( 400 ).json( { error: 'command is required' } );
		}

		const workspace_root = binder.get_workspace_root( session.id );
		const cwd = req.body.cwd
			|| workspace_root
			|| ( session.file_path ? path.dirname( session.file_path ) : process.cwd() );

		const env = Object.assign( {}, process.env );
		if ( session.path_prepend && session.path_prepend.length > 0 )
		{
			const existing = env.PATH || env.Path || '';
			const new_path = session.path_prepend.join( path.delimiter )
				+ ( existing ? path.delimiter + existing : '' );
			env.PATH = new_path;
			if ( 'Path' in env )
			{
				env.Path = new_path;
			}
		}
		Object.assign( env, session.user_env_vars );
		if ( req.body.env_vars && typeof req.body.env_vars === 'object' )
		{
			Object.assign( env, req.body.env_vars );
		}

		exec( command, { cwd: cwd, env: env }, function( err, stdout, stderr )
		{
			res.json( {
				exit_code: err ? err.code : 0,
				stdout: stdout,
				stderr: stderr
			} );
		} );
	} );

	//---------------------------------------------------------------------
	// Mount DebugBridge router for every other route. Express first-match
	// dispatch means our overrides above win for the three paths they
	// register; this mount serves the rest.
	//---------------------------------------------------------------------
	const debug_router = DebugBridge.create_router( { session_manager: session_manager } );
	app.use( '/api', debug_router );

	return {
		app:               app,
		server:            server,
		session_manager:   session_manager,
		workspace_manager: workspace_manager,
		translator:        translator,
		binder:            binder,
		wss:               wss
	};
}


//---------------------------------------------------------------------
function needs_gunzip( content_type )
{
	if ( !content_type )
	{
		return false;
	}
	return content_type.indexOf( 'gzip' ) !== -1 || content_type.indexOf( 'x-gzip' ) !== -1;
}


//---------------------------------------------------------------------
function gunzip_stream( req )
{
	const zlib = require( 'zlib' );
	const gunzip = zlib.createGunzip();
	req.pipe( gunzip );
	return gunzip;
}


//---------------------------------------------------------------------
if ( require.main === module )
{
	const { server } = create_app();
	server.listen( PORT, function()
	{
		const address = server.address();
		console.log( 'WorkspaceBridge server running on http://localhost:' + address.port );
	} );
}


module.exports = { create_app: create_app, PORT: PORT };
