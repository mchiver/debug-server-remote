const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const SessionWorkspaceBinder = require( '../components/SessionWorkspaceBinder' );


//---------------------------------------------------------------------
// Stand-in WorkspaceManager: records destroy() calls so tests can assert
// what the binder did without touching the disk.
//---------------------------------------------------------------------
function fake_workspace_manager()
{
	const destroyed = [];
	const known = new Map();
	return {
		destroyed: destroyed,
		register: function( id, root )
		{
			known.set( id, { id: id, root: root } );
		},
		get: function( id )
		{
			return known.get( id ) || null;
		},
		destroy: function( id )
		{
			destroyed.push( id );
			known.delete( id );
		}
	};
}


//---------------------------------------------------------------------
// Minimal SessionManager surface that the binder cares about.
//---------------------------------------------------------------------
function fake_session_manager()
{
	const sm = {
		broadcast: null,
		set_broadcast_handler: function( handler )
		{
			sm.broadcast = handler;
		}
	};
	return sm;
}


//---------------------------------------------------------------------
test.describe( 'SessionWorkspaceBinder', function()
{
	test.it( 'requires a workspace_manager', function()
	{
		assert.throws( function() { new SessionWorkspaceBinder( {} ); }, /workspace_manager is required/ );
	} );

	//---------------------------------------------------------------------
	test.it( 'bind / get_workspace_id / unbind round-trip', function()
	{
		const wm = fake_workspace_manager();
		const binder = new SessionWorkspaceBinder( { workspace_manager: wm } );
		binder.bind( 'sess-1', 'ws-1', 'persistent' );
		assert.equal( binder.get_workspace_id( 'sess-1' ), 'ws-1' );
		binder.unbind( 'sess-1' );
		assert.equal( binder.get_workspace_id( 'sess-1' ), null );
	} );

	//---------------------------------------------------------------------
	test.it( 'rejects unknown lifecycle', function()
	{
		const wm = fake_workspace_manager();
		const binder = new SessionWorkspaceBinder( { workspace_manager: wm } );
		assert.throws( function() { binder.bind( 's', 'w', 'transient' ); }, /lifecycle/ );
	} );

	//---------------------------------------------------------------------
	test.it( 'get_workspace_root returns the workspace meta.root', function()
	{
		const wm = fake_workspace_manager();
		wm.register( 'ws-1', '/tmp/ws-1' );
		const binder = new SessionWorkspaceBinder( { workspace_manager: wm } );
		binder.bind( 'sess-1', 'ws-1', 'persistent' );
		assert.equal( binder.get_workspace_root( 'sess-1' ), '/tmp/ws-1' );
	} );

	//---------------------------------------------------------------------
	test.it( 'destroy_if_ephemeral destroys ephemeral bindings', function()
	{
		const wm = fake_workspace_manager();
		wm.register( 'ws-1', '/tmp/ws-1' );
		const binder = new SessionWorkspaceBinder( { workspace_manager: wm } );
		binder.bind( 'sess-1', 'ws-1', 'ephemeral' );
		binder.destroy_if_ephemeral( 'sess-1' );
		assert.deepEqual( wm.destroyed, [ 'ws-1' ] );
		assert.equal( binder.get_workspace_id( 'sess-1' ), null );
	} );

	//---------------------------------------------------------------------
	test.it( 'destroy_if_ephemeral leaves persistent bindings alone', function()
	{
		const wm = fake_workspace_manager();
		wm.register( 'ws-1', '/tmp/ws-1' );
		const binder = new SessionWorkspaceBinder( { workspace_manager: wm } );
		binder.bind( 'sess-1', 'ws-1', 'persistent' );
		binder.destroy_if_ephemeral( 'sess-1' );
		assert.deepEqual( wm.destroyed, [] );
		// Still unbound though, since the session is gone.
		assert.equal( binder.get_workspace_id( 'sess-1' ), null );
	} );

	//---------------------------------------------------------------------
	test.it( 'attach: session_exited fires destroy_if_ephemeral', function()
	{
		const wm = fake_workspace_manager();
		const sm = fake_session_manager();
		const binder = new SessionWorkspaceBinder( { workspace_manager: wm } );
		binder.bind( 'sess-1', 'ws-1', 'ephemeral' );
		binder.attach( sm );

		sm.broadcast( 'session_exited', { session_id: 'sess-1' } );
		assert.deepEqual( wm.destroyed, [ 'ws-1' ] );
	} );

	//---------------------------------------------------------------------
	test.it( 'attach: persistent binding survives session_exited', function()
	{
		const wm = fake_workspace_manager();
		const sm = fake_session_manager();
		const binder = new SessionWorkspaceBinder( { workspace_manager: wm } );
		binder.bind( 'sess-1', 'ws-1', 'persistent' );
		binder.attach( sm );

		sm.broadcast( 'session_exited', { session_id: 'sess-1' } );
		assert.deepEqual( wm.destroyed, [] );
	} );

	//---------------------------------------------------------------------
	test.it( 'attach composes with a previously-installed handler', function()
	{
		const wm = fake_workspace_manager();
		const sm = fake_session_manager();
		const seen = [];
		sm.set_broadcast_handler( function( event, data )
		{
			seen.push( { event: event, data: data } );
		} );

		const binder = new SessionWorkspaceBinder( { workspace_manager: wm } );
		binder.bind( 'sess-1', 'ws-1', 'ephemeral' );
		binder.attach( sm );

		sm.broadcast( 'session_exited', { session_id: 'sess-1' } );

		// Pre-existing handler still fires.
		assert.equal( seen.length, 1 );
		assert.equal( seen[ 0 ].event, 'session_exited' );
		// New handler still ran cleanup.
		assert.deepEqual( wm.destroyed, [ 'ws-1' ] );
	} );

	//---------------------------------------------------------------------
	test.it( 'attach forwards non-session_exited events untouched', function()
	{
		const wm = fake_workspace_manager();
		const sm = fake_session_manager();
		const seen = [];
		sm.set_broadcast_handler( function( event, data )
		{
			seen.push( event );
		} );

		const binder = new SessionWorkspaceBinder( { workspace_manager: wm } );
		binder.attach( sm );

		sm.broadcast( 'session_created', { session: { id: 'x' } } );
		sm.broadcast( 'output_update',   { session_id: 'x', lines: [] } );

		assert.deepEqual( seen, [ 'session_created', 'output_update' ] );
		assert.deepEqual( wm.destroyed, [] );
	} );
} );
