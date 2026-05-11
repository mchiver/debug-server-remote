const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { pipeline } = require('stream/promises');
const tar = require('tar');
const moniker = require('moniker');
const ConfigManager = require('./ConfigManager');

const METADATA_FILENAME = '.debug-server-remote.json';
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const NAME_COLLISION_RETRIES = 8;

//---------------------------------------------------------------------
// WorkspaceManager owns an on-disk root containing one subdirectory per
// workspace. Each workspace is the only place user code is allowed to live;
// every debug session resolves its file_path through this component.
//
// Persistent workspaces are explicitly created via REST and survive across
// sessions and container restarts. Ephemeral workspaces are created on the
// fly when a session is started with inline code and are destroyed when
// their owning session is destroyed.
//---------------------------------------------------------------------
class WorkspaceManager
{
	constructor( options )
	{
		const opts = options || {};
		this.root = opts.root || process.env.WORKSPACES_DIR || ConfigManager.workspace_root();
		this.max_bytes = opts.max_bytes || parseInt( process.env.WORKSPACE_MAX_BYTES || '0', 10 ) || DEFAULT_MAX_BYTES;
		this._name_generator = opts.name_generator || function() { return moniker.choose(); };
		ConfigManager.ensure_config_root();
		fs.mkdirSync( this.root, { recursive: true } );
	}

	//---------------------------------------------------------------------
	// Create a new workspace. lifecycle defaults to 'persistent'. Returns
	// the metadata record.
	//---------------------------------------------------------------------
	create( options )
	{
		const opts = options || {};
		const lifecycle = opts.lifecycle || 'persistent';
		if ( lifecycle !== 'persistent' && lifecycle !== 'ephemeral' )
		{
			throw new Error( 'Invalid workspace lifecycle: ' + lifecycle );
		}

		const id = randomUUID();
		const name = this._allocate_unique_name( opts.name );
		const workspace_root = path.join( this.root, id );
		fs.mkdirSync( workspace_root, { recursive: true } );

		const now = new Date().toISOString();
		const metadata = {
			id: id,
			name: name,
			lifecycle: lifecycle,
			root: workspace_root,
			owning_session_id: opts.owning_session_id || null,
			created_at: now,
			updated_at: now
		};
		this._write_metadata( workspace_root, metadata );
		return metadata;
	}

	//---------------------------------------------------------------------
	list( options )
	{
		const opts = options || {};
		const include_ephemeral = !!opts.include_ephemeral;
		const entries = fs.readdirSync( this.root, { withFileTypes: true } );
		const out = [];
		for ( let i = 0; i < entries.length; i++ )
		{
			const entry = entries[ i ];
			if ( !entry.isDirectory() )
			{
				continue;
			}
			const meta = this._try_read_metadata( path.join( this.root, entry.name ) );
			if ( !meta )
			{
				continue;
			}
			if ( meta.lifecycle === 'ephemeral' && !include_ephemeral )
			{
				continue;
			}
			out.push( meta );
		}
		return out;
	}

	//---------------------------------------------------------------------
	get( id )
	{
		const workspace_root = path.join( this.root, id );
		const meta = this._try_read_metadata( workspace_root );
		if ( !meta )
		{
			return null;
		}
		return meta;
	}

	//---------------------------------------------------------------------
	destroy( id )
	{
		const workspace_root = path.join( this.root, id );
		if ( !fs.existsSync( workspace_root ) )
		{
			return false;
		}
		fs.rmSync( workspace_root, { recursive: true, force: true } );
		return true;
	}

	//---------------------------------------------------------------------
	// Bulk-initialize a workspace from a tar or tar+gzip stream. Refuses if
	// the workspace already contains user files unless force=true. Aborts
	// and rolls back if the extracted size exceeds max_bytes.
	//---------------------------------------------------------------------
	async init_from_tar( id, stream, options )
	{
		const opts = options || {};
		const force = !!opts.force;
		const meta = this._require_meta( id );
		const ws_root = meta.root;

		const existing_files = this._list_files_relative( ws_root );
		if ( existing_files.length > 0 && !force )
		{
			throw new Error( 'Workspace is not empty; pass force=true to overwrite' );
		}
		if ( force )
		{
			for ( let i = 0; i < existing_files.length; i++ )
			{
				fs.rmSync( path.join( ws_root, existing_files[ i ] ), { force: true } );
			}
		}

		let total_bytes = 0;
		let violation = null;
		const max_bytes = this.max_bytes;

		const extractor = tar.x( {
			cwd: ws_root,
			strict: true,
			preservePaths: false,
			filter: function( entry_path )
			{
				if ( violation )
				{
					return false;
				}
				const resolved = path.resolve( ws_root, entry_path );
				if ( resolved !== ws_root && !resolved.startsWith( ws_root + path.sep ) )
				{
					violation = new Error( 'Tar entry escapes workspace: ' + entry_path );
					return false;
				}
				return true;
			},
			onentry: function( entry )
			{
				total_bytes = total_bytes + ( entry.size || 0 );
				if ( total_bytes > max_bytes && !violation )
				{
					violation = new Error( 'Tar extraction exceeds WORKSPACE_MAX_BYTES (' + max_bytes + ')' );
					try { stream.destroy(); } catch ( e ) { /* ignore */ }
				}
			}
		} );

		extractor.on( 'error', function( err )
		{
			if ( !violation )
			{
				violation = err;
			}
		} );

		try
		{
			await pipeline( stream, extractor );
		}
		catch ( err )
		{
			if ( !violation )
			{
				violation = err;
			}
		}

		if ( violation )
		{
			const after = this._list_files_relative( ws_root );
			for ( let i = 0; i < after.length; i++ )
			{
				try { fs.rmSync( path.join( ws_root, after[ i ] ), { force: true } ); } catch ( e ) { /* ignore */ }
			}
			throw violation;
		}

		this._touch( id );
	}

	//---------------------------------------------------------------------
	// Write multiple files at once from an in-memory map. Used by
	// SessionManager when a caller supplies an inline `files` map.
	// Total payload is bounded by max_bytes.
	//---------------------------------------------------------------------
	write_files( id, files )
	{
		const meta = this._require_meta( id );
		let total = 0;
		const names = Object.keys( files );
		for ( let i = 0; i < names.length; i++ )
		{
			const content = files[ names[ i ] ];
			total = total + Buffer.byteLength( content, 'utf-8' );
		}
		if ( total > this.max_bytes )
		{
			throw new Error( 'Inline files exceed WORKSPACE_MAX_BYTES (' + this.max_bytes + ')' );
		}
		for ( let i = 0; i < names.length; i++ )
		{
			this._write_file_internal( meta.root, names[ i ], files[ names[ i ] ] );
		}
		this._touch( id );
	}

	//---------------------------------------------------------------------
	read_file( id, relative_path )
	{
		const meta = this._require_meta( id );
		const abs = safe_resolve( meta.root, relative_path );
		return fs.readFileSync( abs );
	}

	//---------------------------------------------------------------------
	write_file( id, relative_path, content )
	{
		const meta = this._require_meta( id );
		const buffer = Buffer.isBuffer( content ) ? content : Buffer.from( content );
		if ( buffer.length > this.max_bytes )
		{
			throw new Error( 'File exceeds WORKSPACE_MAX_BYTES (' + this.max_bytes + ')' );
		}
		this._write_file_internal( meta.root, relative_path, buffer );
		this._touch( id );
	}

	//---------------------------------------------------------------------
	delete_file( id, relative_path )
	{
		const meta = this._require_meta( id );
		const abs = safe_resolve( meta.root, relative_path );
		if ( !fs.existsSync( abs ) )
		{
			throw new Error( 'File not found: ' + relative_path );
		}
		const stat = fs.statSync( abs );
		if ( stat.isDirectory() )
		{
			throw new Error( 'Refusing to delete a directory; use delete_workspace for full cleanup' );
		}
		fs.unlinkSync( abs );
		this._touch( id );
	}

	//---------------------------------------------------------------------
	list_files( id )
	{
		const meta = this._require_meta( id );
		const rels = this._list_files_relative( meta.root );
		const out = [];
		for ( let i = 0; i < rels.length; i++ )
		{
			const abs = path.join( meta.root, rels[ i ] );
			const stat = fs.statSync( abs );
			out.push( {
				path: rels[ i ].split( path.sep ).join( '/' ),
				size: stat.size,
				mtime: stat.mtime.toISOString()
			} );
		}
		return out;
	}

	//---------------------------------------------------------------------
	// Resolve a workspace-relative path to an absolute file_path that the
	// debug session can spawn against. Throws on traversal.
	//---------------------------------------------------------------------
	resolve_path( id, relative_path )
	{
		const meta = this._require_meta( id );
		return safe_resolve( meta.root, relative_path );
	}

	//---------------------------------------------------------------------
	// Internals
	//---------------------------------------------------------------------

	_require_meta( id )
	{
		const meta = this.get( id );
		if ( !meta )
		{
			throw new Error( 'Workspace not found: ' + id );
		}
		return meta;
	}

	_allocate_unique_name( provided_name )
	{
		if ( provided_name )
		{
			return provided_name;
		}
		const taken = new Set();
		const existing = this.list( { include_ephemeral: true } );
		for ( let i = 0; i < existing.length; i++ )
		{
			taken.add( existing[ i ].name );
		}
		for ( let i = 0; i < NAME_COLLISION_RETRIES; i++ )
		{
			const candidate = this._name_generator();
			if ( !taken.has( candidate ) )
			{
				return candidate;
			}
		}
		// Fall back to a name with a short uuid suffix.
		return this._name_generator() + '-' + randomUUID().slice( 0, 8 );
	}

	_write_metadata( workspace_root, metadata )
	{
		fs.writeFileSync(
			path.join( workspace_root, METADATA_FILENAME ),
			JSON.stringify( metadata, null, '\t' ),
			'utf-8'
		);
	}

	_try_read_metadata( workspace_root )
	{
		const meta_path = path.join( workspace_root, METADATA_FILENAME );
		if ( !fs.existsSync( meta_path ) )
		{
			return null;
		}
		try
		{
			const meta = JSON.parse( fs.readFileSync( meta_path, 'utf-8' ) );
			meta.root = workspace_root;
			return meta;
		}
		catch ( err )
		{
			return null;
		}
	}

	_touch( id )
	{
		const workspace_root = path.join( this.root, id );
		const meta = this._try_read_metadata( workspace_root );
		if ( !meta )
		{
			return;
		}
		meta.updated_at = new Date().toISOString();
		this._write_metadata( workspace_root, meta );
	}

	_write_file_internal( workspace_root, relative_path, content )
	{
		const abs = safe_resolve( workspace_root, relative_path );
		fs.mkdirSync( path.dirname( abs ), { recursive: true } );
		fs.writeFileSync( abs, content );
	}

	_list_files_relative( workspace_root )
	{
		const out = [];
		const stack = [ '' ];
		while ( stack.length > 0 )
		{
			const rel = stack.pop();
			const abs = path.join( workspace_root, rel );
			const entries = fs.readdirSync( abs, { withFileTypes: true } );
			for ( let i = 0; i < entries.length; i++ )
			{
				const entry = entries[ i ];
				const entry_rel = rel ? path.join( rel, entry.name ) : entry.name;
				if ( entry.isDirectory() )
				{
					stack.push( entry_rel );
				}
				else if ( entry.isFile() && entry.name !== METADATA_FILENAME )
				{
					out.push( entry_rel );
				}
			}
		}
		return out;
	}
}

//---------------------------------------------------------------------
// safe_resolve joins a workspace-relative path against the workspace root
// and verifies the result stays inside the root. Rejects absolute paths,
// `..` traversal, and symlink escapes.
//---------------------------------------------------------------------
function safe_resolve( workspace_root, relative_path )
{
	if ( typeof relative_path !== 'string' || relative_path.length === 0 )
	{
		throw new Error( 'Relative path is required' );
	}
	if ( path.isAbsolute( relative_path ) )
	{
		throw new Error( 'Relative path must not be absolute: ' + relative_path );
	}
	const resolved_root = path.resolve( workspace_root );
	const resolved = path.resolve( resolved_root, relative_path );
	if ( resolved !== resolved_root && !resolved.startsWith( resolved_root + path.sep ) )
	{
		throw new Error( 'Path escapes workspace: ' + relative_path );
	}
	// If the file already exists, also walk realpath to defeat symlink escapes.
	if ( fs.existsSync( resolved ) )
	{
		const real = fs.realpathSync( resolved );
		const real_root = fs.realpathSync( resolved_root );
		if ( real !== real_root && !real.startsWith( real_root + path.sep ) )
		{
			throw new Error( 'Path escapes workspace via symlink: ' + relative_path );
		}
	}
	return resolved;
}

module.exports = WorkspaceManager;
module.exports.safe_resolve = safe_resolve;
