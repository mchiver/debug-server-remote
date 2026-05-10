//---------------------------------------------------------------------
// SessionWorkspaceBinder owns the session_id -> workspace association
// for WorkspaceBridge. Two responsibilities:
//
//   1. Lookup: /api/sessions/:id/exec needs to know whether a session
//      was created against a workspace so it can use the workspace
//      root as cwd instead of path.dirname(file_path).
//
//   2. Cleanup: when DebugBridge fires 'session_exited' through its
//      broadcast handler, ephemeral workspaces created by the
//      Translator must be destroyed. Persistent workspaces are kept.
//
// attach( session_manager ) installs a broadcast handler that runs
// before any pre-existing handler so the WS-broadcast wiring in
// server.js continues to work. The previously-installed handler is
// chained — both run, in original-then-new order is irrelevant; the
// only contract is that neither one is dropped.
//---------------------------------------------------------------------
class SessionWorkspaceBinder
{
	constructor( options )
	{
		const opts = options || {};
		this.workspace_manager = opts.workspace_manager;
		if ( !this.workspace_manager )
		{
			throw new Error( 'SessionWorkspaceBinder: workspace_manager is required' );
		}
		this.bindings = new Map();
	}

	//---------------------------------------------------------------------
	bind( session_id, workspace_id, lifecycle )
	{
		if ( !session_id || !workspace_id )
		{
			return;
		}
		if ( lifecycle !== 'ephemeral' && lifecycle !== 'persistent' )
		{
			throw new Error( 'lifecycle must be ephemeral or persistent' );
		}
		this.bindings.set( session_id, { workspace_id: workspace_id, lifecycle: lifecycle } );
	}

	//---------------------------------------------------------------------
	get_workspace_id( session_id )
	{
		const entry = this.bindings.get( session_id );
		return entry ? entry.workspace_id : null;
	}

	//---------------------------------------------------------------------
	get_workspace_root( session_id )
	{
		const ws_id = this.get_workspace_id( session_id );
		if ( !ws_id )
		{
			return null;
		}
		const meta = this.workspace_manager.get( ws_id );
		return meta ? meta.root : null;
	}

	//---------------------------------------------------------------------
	unbind( session_id )
	{
		this.bindings.delete( session_id );
	}

	//---------------------------------------------------------------------
	// Destroy the binding's workspace if (and only if) the binding is
	// ephemeral. Used by handlers that destroy a session synchronously
	// (e.g. the triage path) and want to clean up immediately rather
	// than going through the broadcast.
	//---------------------------------------------------------------------
	destroy_if_ephemeral( session_id )
	{
		const entry = this.bindings.get( session_id );
		if ( !entry )
		{
			return;
		}
		this.bindings.delete( session_id );
		if ( entry.lifecycle !== 'ephemeral' )
		{
			return;
		}
		try { this.workspace_manager.destroy( entry.workspace_id ); }
		catch ( e ) { /* ignore */ }
	}

	//---------------------------------------------------------------------
	// Install a broadcast handler that fires our cleanup on session_exited
	// and forwards every event to any previously-installed handler. Safe
	// to call multiple times; each call composes with whatever is currently
	// installed.
	//---------------------------------------------------------------------
	attach( session_manager )
	{
		const self = this;
		const previous = session_manager.broadcast || null;

		function chained_handler( event, data )
		{
			if ( event === 'session_exited' && data && data.session_id )
			{
				self.destroy_if_ephemeral( data.session_id );
			}
			if ( previous )
			{
				try { previous( event, data ); }
				catch ( e ) { /* ignore */ }
			}
		}

		session_manager.set_broadcast_handler( chained_handler );
	}
}


module.exports = SessionWorkspaceBinder;
