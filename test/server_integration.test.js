const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const { start_server, http_request, wait_until } = require( './helpers' );


const TIMEOUT = { timeout: 20000 };


//---------------------------------------------------------------------
// End-to-end integration: prove that WorkspaceBridge's translation
// middleware correctly hands a workspace-shaped session-create body
// to the mounted DebugBridge router.
//
// These tests skip themselves when no usable node engine is installed
// in the local registry, since spawning the child requires one. The
// translator's failure path is already covered in Translator.test.js.
//---------------------------------------------------------------------


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
test.describe( 'WorkspaceBridge server — integration', function()
{
	let parts;
	let node_available;

	test.before( async function()
	{
		node_available = await registry_has_node();
	} );

	test.beforeEach( async function()
	{
		parts = await start_server();
	} );

	test.afterEach( async function()
	{
		await parts.close();
	} );

	//---------------------------------------------------------------------
	test.it( 'POST /api/workspaces creates a persistent workspace', async function()
	{
		const res = await http_request( 'POST', parts.base_url + '/api/workspaces', {} );
		assert.equal( res.status, 201 );
		assert.ok( res.body.workspace.id );
		assert.equal( res.body.workspace.lifecycle, 'persistent' );
	} );

	//---------------------------------------------------------------------
	test.it( 'GET /api/registry returns the engine list', async function()
	{
		const res = await http_request( 'GET', parts.base_url + '/api/registry' );
		assert.equal( res.status, 200 );
		assert.ok( Array.isArray( res.body.engines ) );
	} );

	//---------------------------------------------------------------------
	test.it( 'GET /api/version is served by the mounted DebugBridge router', async function()
	{
		const res = await http_request( 'GET', parts.base_url + '/api/version' );
		assert.equal( res.status, 200 );
		assert.ok( res.body.node_version );
	} );

	//---------------------------------------------------------------------
	test.it( 'POST /api/sessions with content+language=cobol surfaces the translator error', async function()
	{
		const res = await http_request( 'POST', parts.base_url + '/api/sessions', {
			content: 'NOPE',
			language: 'cobol'
		} );
		assert.equal( res.status, 400 );
		assert.match( res.body.error, /No default engine for language/ );
	} );

	//---------------------------------------------------------------------
	test.it( 'POST /api/sessions with engine=node@99.99.99 surfaces the registry error', async function()
	{
		const res = await http_request( 'POST', parts.base_url + '/api/sessions', {
			content: 'console.log("x");\n',
			engine: 'node@99.99.99'
		} );
		assert.equal( res.status, 400 );
		assert.match( res.body.error, /not installed in the registry/ );
	} );

	//---------------------------------------------------------------------
	test.it( 'POST /api/sessions with workspace_id+relative_path runs end-to-end', TIMEOUT, async function( t )
	{
		if ( !node_available )
		{
			t.skip( 'no node engine in local registry' );
			return;
		}

		const ws_res = await http_request( 'POST', parts.base_url + '/api/workspaces', {} );
		const workspace_id = ws_res.body.workspace.id;

		// Write a file into the workspace via the file-PUT route.
		await http_request_raw_put(
			parts.base_url + '/api/workspaces/' + workspace_id + '/files/main.js',
			'console.log("from-ws");\n'
		);

		const create_res = await http_request( 'POST', parts.base_url + '/api/sessions', {
			workspace_id: workspace_id,
			relative_path: 'main.js',
			break_on_first_line: false
		} );
		assert.equal( create_res.status, 201 );
		const session_id = create_res.body.id;
		assert.match( session_id, /^[0-9a-f-]{36}$/ );

		await wait_until( async function()
		{
			const r = await http_request( 'GET', parts.base_url + '/api/sessions/' + session_id );
			return r.body.session.status === 'exited';
		}, 15000 );

		const out = await http_request( 'GET', parts.base_url + '/api/sessions/' + session_id + '/output?limit=100' );
		const has = out.body.lines.some( function( l ) { return ( l.text || '' ).indexOf( 'from-ws' ) >= 0; } );
		assert.ok( has, 'expected program stdout to appear in session output' );
	} );

	//---------------------------------------------------------------------
	test.it( 'POST /api/sessions/:id/exec uses the workspace root as cwd', TIMEOUT, async function( t )
	{
		if ( !node_available )
		{
			t.skip( 'no node engine in local registry' );
			return;
		}

		const ws_res = await http_request( 'POST', parts.base_url + '/api/workspaces', {} );
		const workspace_id = ws_res.body.workspace.id;

		await http_request_raw_put(
			parts.base_url + '/api/workspaces/' + workspace_id + '/files/main.js',
			'setTimeout(function(){}, 5000);\n'
		);
		await http_request_raw_put(
			parts.base_url + '/api/workspaces/' + workspace_id + '/files/marker.txt',
			'present'
		);

		const create_res = await http_request( 'POST', parts.base_url + '/api/sessions', {
			workspace_id: workspace_id,
			relative_path: 'main.js',
			break_on_first_line: true
		} );
		const session_id = create_res.body.id;

		// Listing the cwd should include marker.txt iff cwd === workspace root.
		const exec_res = await http_request( 'POST', parts.base_url + '/api/sessions/' + session_id + '/exec', {
			command: 'node -e "console.log(require(\'fs\').readdirSync(\'.\').sort().join(\',\'))"'
		} );
		assert.equal( exec_res.status, 200 );
		assert.match( exec_res.body.stdout, /marker\.txt/ );

		await http_request( 'DELETE', parts.base_url + '/api/sessions/' + session_id );
	} );

	//---------------------------------------------------------------------
	test.it( 'POST /api/sessions with inline content materializes an ephemeral workspace and runs', TIMEOUT, async function( t )
	{
		if ( !node_available )
		{
			t.skip( 'no node engine in local registry' );
			return;
		}

		const before = parts.workspace_manager.list( { include_ephemeral: true } ).length;
		const create_res = await http_request( 'POST', parts.base_url + '/api/sessions', {
			content: 'console.log("inline-ws");\n',
			language: 'javascript',
			break_on_first_line: false
		} );
		assert.equal( create_res.status, 201 );
		const session_id = create_res.body.id;

		await wait_until( async function()
		{
			const r = await http_request( 'GET', parts.base_url + '/api/sessions/' + session_id );
			return r.body.session.status === 'exited';
		}, 15000 );

		// Destroy the session; the ephemeral workspace should follow.
		const del = await http_request( 'DELETE', parts.base_url + '/api/sessions/' + session_id );
		assert.equal( del.status, 200 );

		await wait_until( function()
		{
			const after = parts.workspace_manager.list( { include_ephemeral: true } ).length;
			return after === before;
		}, 5000 );
	} );
} );


//---------------------------------------------------------------------
function http_request_raw_put( url, body )
{
	const http = require( 'http' );
	return new Promise( function( resolve, reject )
	{
		const parsed = new URL( url );
		const req = http.request( {
			hostname: parsed.hostname,
			port:     parsed.port,
			path:     parsed.pathname + parsed.search,
			method:   'PUT',
			headers:  { 'Content-Type': 'application/octet-stream', 'Content-Length': Buffer.byteLength( body ) }
		}, function( res )
		{
			let data = '';
			res.on( 'data', function( c ) { data += c; } );
			res.on( 'end', function() { resolve( { status: res.statusCode, body: data } ); } );
		} );
		req.on( 'error', reject );
		req.write( body );
		req.end();
	} );
}
