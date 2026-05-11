const fs = require( 'fs' );
const path = require( 'path' );
const ConfigManager = require( './ConfigManager' );


//---------------------------------------------------------------------
// EnvRegistry — read/scan helpers for the debug-server-remote environment
// registry rooted at ~/.config/mchiver/debug-server-remote/registry/<engine>/v<x.y.z>/.
//
// Each environment directory is a self-contained runtime install (a
// language distribution plus any bundled tooling such as the tsx loader
// or debugpy). Per-environment metadata lives in env-registry.json and
// describes how a session child process should be configured to use it.
//
// This module is read-only: installers (env.js + components/EnvInstaller.*.js)
// are responsible for populating the registry; sessions read from it.
//---------------------------------------------------------------------


const REGISTRY_FILENAME = 'env-registry.json';


//---------------------------------------------------------------------
function registry_root()
{
	return ConfigManager.registry_root();
}


//---------------------------------------------------------------------
function engine_root( engine_base )
{
	return path.join( registry_root(), engine_base );
}


//---------------------------------------------------------------------
function environment_dir( engine_base, version_string )
{
	return path.join( engine_root( engine_base ), 'v' + version_string );
}


//---------------------------------------------------------------------
// Parse a directory name like 'v22.5.1' into [22, 5, 1]. Tolerates 1-3
// numeric segments. Returns null if the name doesn't match.
//---------------------------------------------------------------------
function parse_version_dir( name )
{
	const match = name.match( /^v(\d+)(?:\.(\d+))?(?:\.(\d+))?$/ );
	if ( !match )
	{
		return null;
	}
	const tuple = [
		parseInt( match[ 1 ], 10 ),
		match[ 2 ] !== undefined ? parseInt( match[ 2 ], 10 ) : 0,
		match[ 3 ] !== undefined ? parseInt( match[ 3 ], 10 ) : 0
	];
	const version_string = tuple.join( '.' );
	return { tuple: tuple, version_string: version_string };
}


//---------------------------------------------------------------------
// Compare two [major, minor, patch] tuples. Returns negative, zero, or
// positive (Array.sort comparator semantics).
//---------------------------------------------------------------------
function compare_version_tuples( left, right )
{
	for ( let index = 0; index < 3; index++ )
	{
		const a = left[ index ] || 0;
		const b = right[ index ] || 0;
		if ( a !== b )
		{
			return a - b;
		}
	}
	return 0;
}


//---------------------------------------------------------------------
// True if version_tuple matches version_spec ('22', '22.5', '22.5.1' or null/empty).
// A null/empty spec matches everything.
//---------------------------------------------------------------------
function version_spec_matches( version_tuple, version_spec )
{
	if ( !version_spec )
	{
		return true;
	}
	const spec_parts = version_spec.split( '.' ).map( function( segment ) { return parseInt( segment, 10 ); } );
	for ( let index = 0; index < spec_parts.length; index++ )
	{
		if ( ( version_tuple[ index ] || 0 ) !== spec_parts[ index ] )
		{
			return false;
		}
	}
	return true;
}


//---------------------------------------------------------------------
// Load the env-registry.json sitting inside a given environment directory.
// Returns null if missing or malformed (the caller decides how to flag
// broken entries — `env list` reports them, sessions skip them).
//---------------------------------------------------------------------
function load_registry_file( environment_directory )
{
	const file_path = path.join( environment_directory, REGISTRY_FILENAME );
	if ( !fs.existsSync( file_path ) )
	{
		return null;
	}
	try
	{
		const text = fs.readFileSync( file_path, 'utf-8' );
		return JSON.parse( text );
	}
	catch ( err )
	{
		return null;
	}
}


//---------------------------------------------------------------------
// Write env-registry.json into an environment directory. Used by installers.
//---------------------------------------------------------------------
function write_registry_file( environment_directory, payload )
{
	const file_path = path.join( environment_directory, REGISTRY_FILENAME );
	fs.writeFileSync( file_path, JSON.stringify( payload, null, '\t' ), 'utf-8' );
}


//---------------------------------------------------------------------
// List all installed engine bases (directory names directly under the
// registry root). Returns [] if the registry doesn't exist yet.
//---------------------------------------------------------------------
function list_engines()
{
	const root = registry_root();
	if ( !fs.existsSync( root ) )
	{
		return [];
	}
	const entries = fs.readdirSync( root, { withFileTypes: true } );
	const engines = [];
	for ( let index = 0; index < entries.length; index++ )
	{
		if ( entries[ index ].isDirectory() )
		{
			engines.push( entries[ index ].name );
		}
	}
	engines.sort();
	return engines;
}


//---------------------------------------------------------------------
// List installed versions for an engine, sorted descending (newest first).
// Each entry: { engine, version_string, version_tuple, dir, registry_data, broken }.
// `broken` is true when the directory is present but env-registry.json is missing
// or malformed; `registry_data` is null in that case.
//---------------------------------------------------------------------
function list_versions( engine_base )
{
	const root = engine_root( engine_base );
	if ( !fs.existsSync( root ) )
	{
		return [];
	}
	const entries = fs.readdirSync( root, { withFileTypes: true } );
	const versions = [];
	for ( let index = 0; index < entries.length; index++ )
	{
		const entry = entries[ index ];
		if ( !entry.isDirectory() )
		{
			continue;
		}
		const parsed = parse_version_dir( entry.name );
		if ( !parsed )
		{
			continue;
		}
		const dir = path.join( root, entry.name );
		const registry_data = load_registry_file( dir );
		versions.push( {
			engine: engine_base,
			version_string: parsed.version_string,
			version_tuple: parsed.tuple,
			dir: dir,
			registry_data: registry_data,
			broken: registry_data === null
		} );
	}
	versions.sort( function( a, b ) { return compare_version_tuples( b.version_tuple, a.version_tuple ); } );
	return versions;
}


//---------------------------------------------------------------------
// Pick the best registry entry for (engine_base, version_spec). Skips
// broken entries. Returns null if no match.
//---------------------------------------------------------------------
function resolve( engine_base, version_spec )
{
	const versions = list_versions( engine_base );
	for ( let index = 0; index < versions.length; index++ )
	{
		const candidate = versions[ index ];
		if ( candidate.broken )
		{
			continue;
		}
		if ( version_spec_matches( candidate.version_tuple, version_spec ) )
		{
			return candidate;
		}
	}
	return null;
}


//---------------------------------------------------------------------
function ensure_registry_root()
{
	const root = registry_root();
	if ( !fs.existsSync( root ) )
	{
		fs.mkdirSync( root, { recursive: true } );
	}
}


//---------------------------------------------------------------------
module.exports = {
	REGISTRY_FILENAME: REGISTRY_FILENAME,
	registry_root: registry_root,
	engine_root: engine_root,
	environment_dir: environment_dir,
	parse_version_dir: parse_version_dir,
	compare_version_tuples: compare_version_tuples,
	version_spec_matches: version_spec_matches,
	load_registry_file: load_registry_file,
	write_registry_file: write_registry_file,
	list_engines: list_engines,
	list_versions: list_versions,
	resolve: resolve,
	ensure_registry_root: ensure_registry_root
};
