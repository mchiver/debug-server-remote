const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );
const WorkspaceManager = require( '../components/WorkspaceManager' );
const { create_server } = require( '../mcp' );


const TIMEOUT = { timeout: 20000 };


//---------------------------------------------------------------------
function fresh_root()
{
	return fs.mkdtempSync( path.join( os.tmpdir(), 'wb-mcp-' ) );
}


//---------------------------------------------------------------------
async function registry_has_node()
{
	try
	{
		const EnvRegistry = require( '../components/EnvRegistry' );
		const entry = EnvRegistry.resolve( 'node', null );
		return !!entry;
	}
	catch ( err )
	{
		return false;
	}
}


//---------------------------------------------------------------------
function parse_tool_text( tool_result )
{
	assert.ok( tool_result.content );
	return JSON.parse( tool_result.content[ 0 ].text );
}


//---------------------------------------------------------------------
async function wait_until( predicate, timeout_ms )
{
	const limit = timeout_ms || 10000;
	const start = Date.now();
	while ( Date.now() - start < limit )
	{
		if ( await predicate() )
		{
			return;
		}
		await new Promise( function( r ) { setTimeout( r, 50 ); } );
	}
	throw new Error( 'wait_until: timed out after ' + limit + 'ms' );
}


//---------------------------------------------------------------------
test.describe( 'WorkspaceBridge MCP — translation + cleanup', function()
{
	let root;
	let parts;
	let node_available;

	test.before( async function()
	{
		node_available = await registry_has_node();
	} );

	test.beforeEach( function()
	{
		root = fresh_root();
		const workspace_manager = new WorkspaceManager( { root: root } );
		parts = create_server( { workspace_manager: workspace_manager } );
	} );

	test.afterEach( function()
	{
		const sessions = parts.session_manager.list();
		for ( let i = 0; i < sessions.length; i++ )
		{
			try { parts.session_manager.destroy( sessions[ i ].id ); } catch ( e ) { /* ignore */ }
		}
		try { fs.rmSync( root, { recursive: true, force: true } ); } catch ( e ) { /* ignore */ }
	} );

	//---------------------------------------------------------------------
	test.it( 'tools/list exposes workspace-aware schemas on create_session', async function()
	{
		const response = await parts.server.handle_rpc( {
			jsonrpc: '2.0', id: 1, method: 'tools/list'
		} );
		const tools = response.result.tools;
		const create = tools.find( function( t ) { return t.name === 'create_session'; } );
		assert.ok( create );
		assert.ok( create.inputSchema.properties.workspace_id );
		assert.ok( create.inputSchema.properties.relative_path );
		assert.ok( create.inputSchema.properties.engine );
	} );

	//---------------------------------------------------------------------
	test.it( 'translator errors surface as tool isError results', async function()
	{
		const result = await parts.server.call_tool( 'create_session', {
			content: 'NOPE',
			language: 'cobol'
		} );
		assert.equal( result.isError, true );
		const payload = parse_tool_text( result );
		assert.match( payload.error, /No default engine for language/ );
	} );

	//---------------------------------------------------------------------
	test.it( 'create_session with workspace_id+relative_path runs', TIMEOUT, async function( t )
	{
		if ( !node_available )
		{
			t.skip( 'no node engine in local registry' );
			return;
		}
		const ws = parts.workspace_manager.create( {} );
		parts.workspace_manager.write_file( ws.id, 'main.js', 'console.log("mcp-ws");\n' );

		const result = await parts.server.call_tool( 'create_session', {
			workspace_id: ws.id,
			relative_path: 'main.js',
			break_on_first_line: false
		} );
		const payload = parse_tool_text( result );
		assert.match( payload.id, /^[0-9a-f-]{36}$/ );

		await wait_until( function()
		{
			const session = parts.session_manager.get( payload.id );
			return session && session.status === 'exited';
		}, 15000 );

		// Persistent workspace must survive.
		assert.ok( parts.workspace_manager.get( ws.id ), 'persistent workspace should survive session exit' );
	} );

	//---------------------------------------------------------------------
	test.it( 'create_session with inline content destroys the ephemeral workspace on exit', TIMEOUT, async function( t )
	{
		if ( !node_available )
		{
			t.skip( 'no node engine in local registry' );
			return;
		}
		const before = parts.workspace_manager.list( { include_ephemeral: true } ).length;

		const result = await parts.server.call_tool( 'create_session', {
			content: 'console.log("mcp-inline");\n',
			language: 'javascript',
			break_on_first_line: false
		} );
		const payload = parse_tool_text( result );

		// Wait for exit, then explicitly kill (kill triggers session_exited
		// broadcast which is what the binder listens for).
		await wait_until( function()
		{
			const session = parts.session_manager.get( payload.id );
			return session && session.status === 'exited';
		}, 15000 );

		await parts.server.call_tool( 'kill_session', { id: payload.id } );

		await wait_until( function()
		{
			const after = parts.workspace_manager.list( { include_ephemeral: true } ).length;
			return after === before;
		}, 5000 );
	} );

	//---------------------------------------------------------------------
	test.it( 'run_and_report cleans up its ephemeral workspace synchronously', TIMEOUT, async function( t )
	{
		if ( !node_available )
		{
			t.skip( 'no node engine in local registry' );
			return;
		}
		const before = parts.workspace_manager.list( { include_ephemeral: true } ).length;

		const result = await parts.server.call_tool( 'run_and_report', {
			content: 'throw new Error("boom");\n',
			language: 'javascript'
		} );
		const report = parse_tool_text( result );
		assert.equal( report.kind, 'exception' );

		const after = parts.workspace_manager.list( { include_ephemeral: true } ).length;
		assert.equal( after, before, 'ephemeral workspace should be gone immediately after triage' );
	} );
} );
