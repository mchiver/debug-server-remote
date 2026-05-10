const { pathToFileURL } = require( 'url' );
const WorkspaceManager = require( './WorkspaceManager' );
const EnvRegistry = require( './EnvRegistry' );


//---------------------------------------------------------------------
// Translator is the single source of truth for converting WorkspaceBridge
// shaped session inputs into the file-path/env-vars shape that DebugBridge
// expects. It owns:
//   1. File materialization — workspace_id+relative_path / content / files
//      / file_path are normalized to an absolute file_path under a known
//      workspace root (or an ephemeral workspace for inline shapes).
//   2. Engine resolution — engine ids like 'node', 'node@22.5.1', or a
//      bare language are resolved against EnvRegistry to a concrete
//      executable + path_prepend + env_vars. The merged env_vars/path_prepend
//      are then handed to DebugBridge so its child process spawns under
//      the chosen engine.
//
// The dashboard, the HTTP middleware, and the MCP wrapper all share this
// component. DebugBridge itself never imports it.
//---------------------------------------------------------------------


const LANGUAGE_FILE_EXTENSIONS = {
	javascript: '.js',
	typescript: '.ts',
	python:     '.py',
	ruby:       '.rb'
};

const LANGUAGE_TO_DEFAULT_ENGINE = {
	javascript: 'node',
	typescript: 'node-tsx',
	python:     'python3'
};

const ENGINE_BASE_TO_LANGUAGE = {
	'node':     'javascript',
	'node-tsx': 'typescript',
	'python3':  'python'
};

const SNIPPET_BASENAME = 'main';


//---------------------------------------------------------------------
class Translator
{
	constructor( options )
	{
		const opts = options || {};
		this.workspace_manager = opts.workspace_manager || new WorkspaceManager();
	}

	//---------------------------------------------------------------------
	// Translate a session-creation body (POST /api/sessions or /api/triage,
	// or an MCP tool call). Returns a body object with the DebugBridge
	// shape: { file_path, language, env_vars, path_prepend,
	// break_on_first_line, ...other passthrough fields }.
	//
	// The optional second result field `ephemeral_workspace_id` lets the
	// caller bind workspace cleanup to the created session (today the
	// caller is responsible for that wiring; ephemeral workspaces leak
	// otherwise).
	//---------------------------------------------------------------------
	async translate_session_body( body )
	{
		const opts = body || {};
		validate_session_shape( opts );

		const engine_id = resolve_engine_id_from_options( opts );
		const parsed = parse_engine_id( engine_id );
		const language = opts.language || ENGINE_BASE_TO_LANGUAGE[ parsed.base ] || 'javascript';

		const file_resolution = this._materialize_file( opts, language );
		const engine_env = await this._resolve_engine_env( parsed.base, parsed.version_spec );

		const merged_env_vars = Object.assign( {}, engine_env.env_vars || {}, opts.env_vars || {} );
		const merged_path_prepend = ( engine_env.path_prepend || [] ).concat( opts.path_prepend || [] );

		const out = {
			file_path:           file_resolution.file_path,
			language:            language,
			env_vars:            merged_env_vars,
			path_prepend:        merged_path_prepend,
			break_on_first_line: !!opts.break_on_first_line
		};
		if ( opts.type )
		{
			out.type = opts.type;
		}
		if ( opts.timeout_ms )
		{
			out.timeout_ms = opts.timeout_ms;
		}
		return {
			body: out,
			ephemeral_workspace_id: file_resolution.ephemeral_workspace_id
		};
	}

	//---------------------------------------------------------------------
	// Resolve an engine reference to its executable + env. Returns
	// { executable_path, version_string, path_prepend, env_vars, language,
	//   protocol }.
	//---------------------------------------------------------------------
	async resolve_engine( engine_id )
	{
		const parsed = parse_engine_id( engine_id );
		return await this._resolve_engine_env( parsed.base, parsed.version_spec );
	}

	//---------------------------------------------------------------------
	// File materialization. Mirrors the prior SessionManager._materialize_workspace.
	// Returns { file_path, ephemeral_workspace_id|null }.
	//---------------------------------------------------------------------
	_materialize_file( opts, language )
	{
		// Shape: { file_path } — passthrough.
		if ( opts.file_path )
		{
			return { file_path: opts.file_path, ephemeral_workspace_id: null };
		}

		// Shape: { workspace_id, relative_path }.
		if ( opts.workspace_id && opts.relative_path )
		{
			const file_path = this.workspace_manager.resolve_path( opts.workspace_id, opts.relative_path );
			return { file_path: file_path, ephemeral_workspace_id: null };
		}

		// Shape: { workspace_id, content, language? } — write into the named workspace.
		if ( opts.workspace_id && typeof opts.content === 'string' )
		{
			const ext = LANGUAGE_FILE_EXTENSIONS[ language ] || '.txt';
			const relative_path = SNIPPET_BASENAME + ext;
			this.workspace_manager.write_file( opts.workspace_id, relative_path, opts.content );
			const file_path = this.workspace_manager.resolve_path( opts.workspace_id, relative_path );
			return { file_path: file_path, ephemeral_workspace_id: null };
		}

		// Shape: { files, entry, workspace_id? }.
		if ( opts.files )
		{
			if ( !opts.entry )
			{
				throw new Error( 'files requires an entry path' );
			}
			if ( typeof opts.files !== 'object' || Array.isArray( opts.files ) )
			{
				throw new Error( 'files must be a map of relative_path -> content' );
			}
			const file_names = Object.keys( opts.files );
			if ( file_names.indexOf( opts.entry ) === -1 )
			{
				throw new Error( 'entry must be one of the keys in files' );
			}
			const ws = this.workspace_manager.create( { lifecycle: 'ephemeral' } );
			try
			{
				this.workspace_manager.write_files( ws.id, opts.files );
			}
			catch ( err )
			{
				this.workspace_manager.destroy( ws.id );
				throw err;
			}
			const file_path = this.workspace_manager.resolve_path( ws.id, opts.entry );
			return { file_path: file_path, ephemeral_workspace_id: ws.id };
		}

		// Shape: { content, language? } — ephemeral workspace.
		if ( typeof opts.content === 'string' )
		{
			const ext = LANGUAGE_FILE_EXTENSIONS[ language ] || '.txt';
			const relative_path = SNIPPET_BASENAME + ext;
			const ws = this.workspace_manager.create( { lifecycle: 'ephemeral' } );
			try
			{
				this.workspace_manager.write_file( ws.id, relative_path, opts.content );
			}
			catch ( err )
			{
				this.workspace_manager.destroy( ws.id );
				throw err;
			}
			const file_path = this.workspace_manager.resolve_path( ws.id, relative_path );
			return { file_path: file_path, ephemeral_workspace_id: ws.id };
		}

		throw new Error( 'No session source supplied: provide one of { file_path, workspace_id+relative_path, content, files+entry }' );
	}

	//---------------------------------------------------------------------
	// Engine env resolution against EnvRegistry. node-tsx is special-cased
	// because the tsx loader is delivered as a NODE_OPTIONS=--import flag
	// pointed at an absolute file URL.
	//---------------------------------------------------------------------
	async _resolve_engine_env( base, version_spec )
	{
		const entry = EnvRegistry.resolve( base, version_spec );
		if ( !entry )
		{
			throw build_not_installed_error( base, version_spec );
		}
		const data = entry.registry_data;
		const env_vars = Object.assign( {}, data.env_vars || {} );
		const path_prepend = ( data.path_prepend || [] ).slice();
		const language = ENGINE_BASE_TO_LANGUAGE[ base ] || null;
		const protocol = base === 'python3' ? 'dap' : 'inspector';

		if ( base === 'node-tsx' )
		{
			const tsx_loader_path = data.extras && data.extras.tsx_loader_path;
			if ( !tsx_loader_path )
			{
				throw new Error( 'node-tsx v' + entry.version_string + ' env-registry.json is missing extras.tsx_loader_path; reinstall with: node env.js install node-tsx ' + entry.version_string + ' --force' );
			}
			const tsx_loader_url = pathToFileURL( tsx_loader_path ).href;
			const existing_node_options = env_vars.NODE_OPTIONS || '';
			const tsx_flag = '--import ' + tsx_loader_url;
			env_vars.NODE_OPTIONS = existing_node_options
				? ( existing_node_options + ' ' + tsx_flag )
				: tsx_flag;
		}

		return {
			base:            base,
			version_string:  entry.version_string,
			version_tuple:   entry.version_tuple,
			executable_path: data.executable_path,
			language:        language,
			protocol:        protocol,
			path_prepend:    path_prepend,
			env_vars:        env_vars
		};
	}
}


//---------------------------------------------------------------------
// Reject ambiguous inputs. Mirrors the old SessionManager validator but
// adds the file_path shape.
//---------------------------------------------------------------------
function validate_session_shape( opts )
{
	// "primary" signals are the fields that select a shape. workspace_id
	// is a qualifier (it pairs with relative_path or content) and does
	// not itself count.
	const has_file_path     = !!opts.file_path;
	const has_relative_path = !!opts.relative_path;
	const has_content       = typeof opts.content === 'string';
	const has_files         = !!opts.files;
	const has_workspace     = !!opts.workspace_id;

	let primary = 0;
	if ( has_file_path )     { primary++; }
	if ( has_relative_path ) { primary++; }
	if ( has_content )       { primary++; }
	if ( has_files )         { primary++; }

	if ( primary > 1 )
	{
		throw new Error( 'Specify exactly one of { file_path, workspace_id+relative_path, content, files+entry, workspace_id+content }' );
	}
	if ( has_workspace && !has_relative_path && !has_content )
	{
		throw new Error( 'workspace_id requires relative_path (or content)' );
	}
	if ( has_relative_path && !has_workspace )
	{
		throw new Error( 'relative_path requires workspace_id' );
	}
}


//---------------------------------------------------------------------
function resolve_engine_id_from_options( options )
{
	if ( options.engine )
	{
		return options.engine;
	}
	const language = options.language || 'javascript';
	const default_id = LANGUAGE_TO_DEFAULT_ENGINE[ language ];
	if ( !default_id )
	{
		throw new Error( 'No default engine for language: ' + language );
	}
	return default_id;
}


//---------------------------------------------------------------------
// Parses both 'node-v22.5.1' and 'node@22.5.1' forms. The base id may
// itself contain hyphens (e.g. 'node-tsx').
//---------------------------------------------------------------------
function parse_engine_id( engine_id )
{
	if ( typeof engine_id !== 'string' || engine_id.length === 0 )
	{
		throw new Error( 'engine_id must be a non-empty string' );
	}

	let base = engine_id;
	let version_spec = null;

	const at_match = engine_id.match( /^(.+)@v?(\d+(?:\.\d+){0,2})$/ );
	if ( at_match )
	{
		base = at_match[ 1 ];
		version_spec = at_match[ 2 ];
	}
	else
	{
		const hyphen_match = engine_id.match( /^(.+)-v(\d+(?:\.\d+){0,2})$/ );
		if ( hyphen_match )
		{
			base = hyphen_match[ 1 ];
			version_spec = hyphen_match[ 2 ];
		}
	}

	if ( !( base in ENGINE_BASE_TO_LANGUAGE ) )
	{
		const known = Object.keys( ENGINE_BASE_TO_LANGUAGE ).join( ', ' );
		throw new Error( 'Unknown engine: ' + base + ' (registered: ' + known + ')' );
	}
	return { base: base, version_spec: version_spec };
}


//---------------------------------------------------------------------
function build_not_installed_error( base, version_spec )
{
	const versions = EnvRegistry.list_versions( base );
	const installed = versions
		.filter( function( v ) { return !v.broken; } )
		.map( function( v ) { return 'v' + v.version_string; } );
	const installed_summary = installed.length === 0
		? '(none installed)'
		: 'installed: ' + installed.join( ', ' );
	const requested = version_spec ? ( base + ' v' + version_spec ) : base;
	const install_hint = version_spec
		? ( 'node env.js install ' + base + ' ' + version_spec )
		: ( 'node env.js install ' + base );
	return new Error(
		'engine ' + requested + ' is not installed in the registry; ' + installed_summary + '. ' +
		'Install with: ' + install_hint
	);
}


//---------------------------------------------------------------------
module.exports = Translator;
module.exports.Translator = Translator;
module.exports.parse_engine_id = parse_engine_id;
module.exports.resolve_engine_id_from_options = resolve_engine_id_from_options;
module.exports.LANGUAGE_TO_DEFAULT_ENGINE = LANGUAGE_TO_DEFAULT_ENGINE;
