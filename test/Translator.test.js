const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );
const WorkspaceManager = require( '../components/WorkspaceManager' );
const Translator = require( '../components/Translator' );


//---------------------------------------------------------------------
function fresh_root()
{
	return fs.mkdtempSync( path.join( os.tmpdir(), 'wb-translator-' ) );
}


//---------------------------------------------------------------------
test.describe( 'Translator — file materialization', function()
{
	let root;
	let workspace_manager;
	let translator;

	test.beforeEach( function()
	{
		root = fresh_root();
		workspace_manager = new WorkspaceManager( { root: root } );
		translator = new Translator( { workspace_manager: workspace_manager } );
	} );

	test.afterEach( function()
	{
		fs.rmSync( root, { recursive: true, force: true } );
	} );

	//---------------------------------------------------------------------
	test.it( 'passes through an absolute file_path', async function()
	{
		const tmp = path.join( root, 'standalone.js' );
		fs.writeFileSync( tmp, 'console.log("x");\n' );
		const result = await translator.translate_session_body( {
			file_path: tmp,
			engine: 'node'
		} );
		assert.equal( result.body.file_path, tmp );
		assert.equal( result.body.language, 'javascript' );
		assert.equal( result.ephemeral_workspace_id, null );
	} );

	//---------------------------------------------------------------------
	test.it( 'resolves workspace_id + relative_path against the workspace', async function()
	{
		const ws = workspace_manager.create( {} );
		workspace_manager.write_file( ws.id, 'main.js', 'console.log("ws");\n' );
		const result = await translator.translate_session_body( {
			workspace_id: ws.id,
			relative_path: 'main.js',
			engine: 'node'
		} );
		assert.ok( result.body.file_path.startsWith( ws.root ) );
		assert.ok( result.body.file_path.endsWith( 'main.js' ) );
		assert.equal( result.ephemeral_workspace_id, null );
	} );

	//---------------------------------------------------------------------
	test.it( 'inline content materializes an ephemeral workspace', async function()
	{
		const result = await translator.translate_session_body( {
			content: 'console.log("snip");\n',
			language: 'javascript',
			engine: 'node'
		} );
		assert.ok( result.ephemeral_workspace_id, 'should bind an ephemeral workspace id' );
		const ws = workspace_manager.get( result.ephemeral_workspace_id );
		assert.equal( ws.lifecycle, 'ephemeral' );
		assert.ok( result.body.file_path.startsWith( ws.root ) );
		assert.ok( result.body.file_path.endsWith( 'main.js' ) );
	} );

	//---------------------------------------------------------------------
	test.it( 'files+entry materializes a multi-file ephemeral workspace', async function()
	{
		const result = await translator.translate_session_body( {
			files: {
				'main.js':    'require("./helper");\n',
				'helper.js': 'console.log("h");\n'
			},
			entry: 'main.js',
			engine: 'node'
		} );
		const ws = workspace_manager.get( result.ephemeral_workspace_id );
		const names = workspace_manager.list_files( ws.id ).map( function( f ) { return f.path; } ).sort();
		assert.deepEqual( names, [ 'helper.js', 'main.js' ] );
		assert.ok( result.body.file_path.endsWith( 'main.js' ) );
	} );

	//---------------------------------------------------------------------
	test.it( 'files without entry throws', async function()
	{
		await assert.rejects(
			translator.translate_session_body( { files: { 'a.js': 'x' }, engine: 'node' } ),
			/files requires an entry/
		);
	} );

	//---------------------------------------------------------------------
	test.it( 'files with entry not in keys throws', async function()
	{
		await assert.rejects(
			translator.translate_session_body( { files: { 'a.js': 'x' }, entry: 'nope.js', engine: 'node' } ),
			/entry must be one of/
		);
	} );

	//---------------------------------------------------------------------
	test.it( 'no source supplied throws cleanly', async function()
	{
		await assert.rejects(
			translator.translate_session_body( { engine: 'node' } ),
			/No session source supplied/
		);
	} );

	//---------------------------------------------------------------------
	test.it( 'mixing workspace_id (with relative_path) and content throws', async function()
	{
		const ws = workspace_manager.create( {} );
		await assert.rejects(
			translator.translate_session_body( {
				workspace_id: ws.id,
				relative_path: 'a.js',
				content: 'x',
				engine: 'node'
			} ),
			/exactly one of/
		);
	} );

	//---------------------------------------------------------------------
	test.it( 'workspace_id without relative_path or content throws', async function()
	{
		const ws = workspace_manager.create( {} );
		await assert.rejects(
			translator.translate_session_body( { workspace_id: ws.id, engine: 'node' } ),
			/requires relative_path/
		);
	} );
} );


//---------------------------------------------------------------------
test.describe( 'Translator — engine id parsing', function()
{
	let root;
	let translator;

	test.beforeEach( function()
	{
		root = fresh_root();
		translator = new Translator( { workspace_manager: new WorkspaceManager( { root: root } ) } );
	} );

	test.afterEach( function()
	{
		fs.rmSync( root, { recursive: true, force: true } );
	} );

	//---------------------------------------------------------------------
	test.it( 'rejects unknown engine ids', async function()
	{
		await assert.rejects(
			translator.translate_session_body( { content: 'x', engine: 'cobol' } ),
			/Unknown engine: cobol/
		);
	} );

	//---------------------------------------------------------------------
	test.it( 'rejects unsupported language without an explicit engine', async function()
	{
		await assert.rejects(
			translator.translate_session_body( { content: 'x', language: 'cobol' } ),
			/No default engine for language/
		);
	} );

	//---------------------------------------------------------------------
	test.it( 'reports a helpful error when the engine is not installed in the registry', async function()
	{
		// We intentionally pin a version that is almost certainly not installed
		// so we exercise the build_not_installed_error path without depending
		// on the host machine's installed engines.
		await assert.rejects(
			translator.translate_session_body( { content: 'x', engine: 'node@99.99.99' } ),
			/is not installed in the registry/
		);
	} );
} );
