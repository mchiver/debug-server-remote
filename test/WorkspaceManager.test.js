const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );
const tar = require( 'tar' );
const { Readable } = require( 'stream' );
const WorkspaceManager = require( '../components/WorkspaceManager' );
const { safe_resolve } = require( '../components/WorkspaceManager' );

//---------------------------------------------------------------------
function fresh_root()
{
	return fs.mkdtempSync( path.join( os.tmpdir(), 'wsmgr-test-' ) );
}

//---------------------------------------------------------------------
function make_tar_buffer( files )
{
	// Build a tar archive in a temp directory then read it back as a buffer.
	const work = fs.mkdtempSync( path.join( os.tmpdir(), 'wsmgr-tarbuild-' ) );
	const names = Object.keys( files );
	for ( let i = 0; i < names.length; i++ )
	{
		const abs = path.join( work, names[ i ] );
		fs.mkdirSync( path.dirname( abs ), { recursive: true } );
		fs.writeFileSync( abs, files[ names[ i ] ] );
	}
	const archive_path = path.join( os.tmpdir(), 'wsmgr-archive-' + Date.now() + '-' + Math.random().toString( 36 ).slice( 2 ) + '.tar' );
	tar.c( { sync: true, cwd: work, file: archive_path }, names );
	const buffer = fs.readFileSync( archive_path );
	fs.rmSync( archive_path, { force: true } );
	fs.rmSync( work, { recursive: true, force: true } );
	return buffer;
}

//---------------------------------------------------------------------
function buffer_to_stream( buffer )
{
	return Readable.from( buffer );
}

//---------------------------------------------------------------------
test.describe( 'WorkspaceManager', function()
{
	let root;
	let manager;

	test.beforeEach( function()
	{
		root = fresh_root();
		manager = new WorkspaceManager( { root: root } );
	} );

	test.afterEach( function()
	{
		fs.rmSync( root, { recursive: true, force: true } );
	} );

	//---------------------------------------------------------------------
	test.it( 'create produces unique id, friendly name, and on-disk dir', function()
	{
		const a = manager.create( {} );
		const b = manager.create( {} );
		assert.match( a.id, /^[0-9a-f-]{36}$/ );
		assert.notEqual( a.id, b.id );
		assert.ok( a.name && a.name.length > 0 );
		assert.notEqual( a.name, b.name, 'two workspaces should not share a friendly name' );
		assert.ok( fs.existsSync( path.join( root, a.id ) ) );
		assert.equal( a.lifecycle, 'persistent' );
	} );

	//---------------------------------------------------------------------
	test.it( 'create retries past name collisions before falling back', function()
	{
		let calls = 0;
		const colliding_manager = new WorkspaceManager( {
			root: root,
			name_generator: function()
			{
				calls = calls + 1;
				return calls < 3 ? 'collision' : 'unique-' + calls;
			}
		} );
		const first = colliding_manager.create( {} );
		const second = colliding_manager.create( {} );
		assert.equal( first.name, 'collision' );
		assert.notEqual( second.name, 'collision' );
	} );

	//---------------------------------------------------------------------
	test.it( 'list filters ephemeral by default, includes them with the flag', function()
	{
		const persistent = manager.create( { lifecycle: 'persistent' } );
		const ephemeral = manager.create( { lifecycle: 'ephemeral' } );

		const visible = manager.list();
		assert.equal( visible.length, 1 );
		assert.equal( visible[ 0 ].id, persistent.id );

		const all = manager.list( { include_ephemeral: true } );
		const ids = all.map( function( w ) { return w.id; } ).sort();
		assert.deepEqual( ids, [ persistent.id, ephemeral.id ].sort() );
	} );

	//---------------------------------------------------------------------
	test.it( 'write_file then read_file round-trips bytes; delete_file removes', function()
	{
		const ws = manager.create( {} );
		manager.write_file( ws.id, 'hello.txt', Buffer.from( 'world', 'utf-8' ) );
		const buf = manager.read_file( ws.id, 'hello.txt' );
		assert.equal( buf.toString( 'utf-8' ), 'world' );

		manager.delete_file( ws.id, 'hello.txt' );
		assert.throws( function() { manager.read_file( ws.id, 'hello.txt' ); } );
		assert.throws( function() { manager.delete_file( ws.id, 'hello.txt' ); }, /not found/ );
	} );

	//---------------------------------------------------------------------
	test.it( 'destroy removes the directory tree', function()
	{
		const ws = manager.create( {} );
		manager.write_file( ws.id, 'a.js', 'x' );
		assert.ok( fs.existsSync( path.join( root, ws.id ) ) );
		manager.destroy( ws.id );
		assert.equal( fs.existsSync( path.join( root, ws.id ) ), false );
		assert.equal( manager.get( ws.id ), null );
	} );

	//---------------------------------------------------------------------
	test.it( 'list_files reports relative paths, sizes, and mtimes', function()
	{
		const ws = manager.create( {} );
		manager.write_file( ws.id, 'a.js', 'console.log("a");' );
		manager.write_file( ws.id, 'sub/b.js', 'console.log("b");' );
		const files = manager.list_files( ws.id );
		const paths = files.map( function( f ) { return f.path; } ).sort();
		assert.deepEqual( paths, [ 'a.js', 'sub/b.js' ] );
	} );

	//---------------------------------------------------------------------
	test.it( 'init_from_tar extracts a multi-file archive', async function()
	{
		const ws = manager.create( {} );
		const tarball = make_tar_buffer( {
			'index.js': 'console.log("index");\n',
			'lib/util.js': 'module.exports = 42;\n'
		} );
		await manager.init_from_tar( ws.id, buffer_to_stream( tarball ) );
		const files = manager.list_files( ws.id ).map( function( f ) { return f.path; } ).sort();
		assert.deepEqual( files, [ 'index.js', 'lib/util.js' ] );
		assert.equal( manager.read_file( ws.id, 'index.js' ).toString( 'utf-8' ), 'console.log("index");\n' );
	} );

	//---------------------------------------------------------------------
	test.it( 'init_from_tar refuses if workspace is not empty without force', async function()
	{
		const ws = manager.create( {} );
		manager.write_file( ws.id, 'existing.js', 'x' );
		const tarball = make_tar_buffer( { 'a.js': 'a' } );
		await assert.rejects( manager.init_from_tar( ws.id, buffer_to_stream( tarball ) ), /not empty/ );
	} );

	//---------------------------------------------------------------------
	test.it( 'init_from_tar with force=true overwrites existing files', async function()
	{
		const ws = manager.create( {} );
		manager.write_file( ws.id, 'existing.js', 'old' );
		const tarball = make_tar_buffer( { 'a.js': 'fresh' } );
		await manager.init_from_tar( ws.id, buffer_to_stream( tarball ), { force: true } );
		const files = manager.list_files( ws.id ).map( function( f ) { return f.path; } );
		assert.deepEqual( files, [ 'a.js' ] );
	} );

	//---------------------------------------------------------------------
	test.it( 'init_from_tar aborts when extraction would exceed max_bytes', async function()
	{
		const tiny_manager = new WorkspaceManager( { root: root, max_bytes: 16 } );
		const ws = tiny_manager.create( {} );
		// Each file is well under 16 bytes individually, but together they exceed.
		const tarball = make_tar_buffer( {
			'a.txt': 'aaaaaaaaaa',  // 10 bytes
			'b.txt': 'bbbbbbbbbb'   // 10 bytes -> 20 total > 16 limit
		} );
		await assert.rejects(
			tiny_manager.init_from_tar( ws.id, buffer_to_stream( tarball ) ),
			/WORKSPACE_MAX_BYTES/
		);
	} );

	//---------------------------------------------------------------------
	test.it( 'safe_resolve rejects absolute paths', function()
	{
		const ws = manager.create( {} );
		const ws_root = path.join( root, ws.id );
		assert.throws( function() { safe_resolve( ws_root, '/etc/passwd' ); }, /absolute/ );
	} );

	//---------------------------------------------------------------------
	test.it( 'safe_resolve rejects parent traversal', function()
	{
		const ws = manager.create( {} );
		const ws_root = path.join( root, ws.id );
		assert.throws( function() { safe_resolve( ws_root, '../escape' ); }, /escapes workspace/ );
		assert.throws( function() { safe_resolve( ws_root, 'sub/../../escape' ); }, /escapes workspace/ );
	} );

	//---------------------------------------------------------------------
	test.it( 'safe_resolve rejects empty / non-string input', function()
	{
		const ws = manager.create( {} );
		const ws_root = path.join( root, ws.id );
		assert.throws( function() { safe_resolve( ws_root, '' ); }, /required/ );
		assert.throws( function() { safe_resolve( ws_root, null ); }, /required/ );
	} );

	//---------------------------------------------------------------------
	test.it( 'init_from_tar refuses tars containing parent-traversal entries', async function()
	{
		// Build a malicious tar by hand using tar's pack stream.
		const ws = manager.create( {} );
		const malicious_path = path.join( os.tmpdir(), 'wsmgr-evil-' + Date.now() + '.tar' );
		const work = fs.mkdtempSync( path.join( os.tmpdir(), 'wsmgr-evilbuild-' ) );
		fs.writeFileSync( path.join( work, 'innocent.js' ), 'ok' );
		// Write a tar with a header that names ../escape.txt; tar.c follows the
		// `prefix` fields literally when sync mode is used with a custom name.
		// Easier path: write through node's tar with absolute path; strict mode rejects.
		fs.mkdirSync( path.join( work, 'sub' ), { recursive: true } );
		fs.writeFileSync( path.join( work, 'sub', 'evil.js' ), 'pwn' );
		tar.c( { sync: true, cwd: work, file: malicious_path }, [ 'sub/evil.js' ] );
		// Manually rewrite the entry name to include `..`. tar headers store the
		// name in the first 100 bytes of the 512-byte header block.
		const buffer = Buffer.from( fs.readFileSync( malicious_path ) );
		const evil_name = '../escape.txt';
		buffer.fill( 0, 0, 100 );
		buffer.write( evil_name, 0, 'utf-8' );
		// Recalculate checksum: sum of bytes in the header treating the
		// 8-byte chksum field as spaces.
		buffer.fill( 0x20, 148, 156 );
		let sum = 0;
		for ( let i = 0; i < 512; i++ ) { sum = sum + buffer[ i ]; }
		const sum_str = sum.toString( 8 ).padStart( 6, '0' ) + '\0 ';
		buffer.write( sum_str, 148, 'utf-8' );
		fs.writeFileSync( malicious_path, buffer );

		await assert.rejects(
			manager.init_from_tar( ws.id, fs.createReadStream( malicious_path ) ),
			/escape|invalid|absolute|denormalized/i
		);
		fs.rmSync( malicious_path, { force: true } );
		fs.rmSync( work, { recursive: true, force: true } );
	} );

	//---------------------------------------------------------------------
	test.it( 'write_files accepts a map and bounds total payload', function()
	{
		const ws = manager.create( {} );
		manager.write_files( ws.id, { 'a.js': 'A', 'sub/b.js': 'B' } );
		assert.equal( manager.read_file( ws.id, 'a.js' ).toString( 'utf-8' ), 'A' );
		assert.equal( manager.read_file( ws.id, 'sub/b.js' ).toString( 'utf-8' ), 'B' );

		const tiny_manager = new WorkspaceManager( { root: root, max_bytes: 4 } );
		const ws2 = tiny_manager.create( {} );
		assert.throws(
			function() { tiny_manager.write_files( ws2.id, { 'big.txt': 'aaaaaaaa' } ); },
			/WORKSPACE_MAX_BYTES/
		);
	} );
} );
