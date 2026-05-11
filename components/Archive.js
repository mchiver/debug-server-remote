const fs = require( 'fs' );
const path = require( 'path' );
const { spawnSync } = require( 'child_process' );


//---------------------------------------------------------------------
// Archive — small extraction helper used by the environment installers.
//
// Why this exists:
//
//   - Windows ships bsdtar (which reads zip + tar.*) at
//     C:\Windows\System32\tar.exe, but a typical developer PATH often
//     resolves `tar` to GNU tar bundled with Git for Windows or MSYS,
//     which cannot read zip archives.
//   - Both flavours of tar treat absolute archive paths beginning with
//     a drive letter (`C:\Users\...`) as a remote `host:path` spec.
//
// To dodge both, we:
//
//   - Use PowerShell's Expand-Archive for zip extraction on Windows.
//   - For tar.* on Windows, invoke %SystemRoot%\System32\tar.exe directly
//     and run it from the archive's parent directory so the archive can
//     be referenced by basename.
//   - On macOS/Linux, just use the system `tar` and `unzip`.
//---------------------------------------------------------------------


//---------------------------------------------------------------------
function system_tar()
{
	if ( process.platform !== 'win32' )
	{
		return 'tar';
	}
	const system_root = process.env.SystemRoot || 'C:\\Windows';
	const candidate = path.join( system_root, 'System32', 'tar.exe' );
	if ( fs.existsSync( candidate ) )
	{
		return candidate;
	}
	return 'tar.exe';
}


//---------------------------------------------------------------------
// Extract a zip archive into target_dir. The target directory is
// created if missing. Uses PowerShell's Expand-Archive on Windows so we
// don't depend on whatever flavour of tar happens to be on PATH.
//---------------------------------------------------------------------
function extract_zip( archive_path, target_dir )
{
	fs.mkdirSync( target_dir, { recursive: true } );

	if ( process.platform === 'win32' )
	{
		const command = [
			'$ProgressPreference = \'SilentlyContinue\';',
			'Expand-Archive',
			'-LiteralPath', escape_powershell_arg( archive_path ),
			'-DestinationPath', escape_powershell_arg( target_dir ),
			'-Force'
		].join( ' ' );
		const result = spawnSync(
			'powershell.exe',
			[ '-NoProfile', '-NonInteractive', '-Command', command ],
			{ stdio: 'inherit' }
		);
		if ( result.status !== 0 )
		{
			throw new Error( 'Expand-Archive failed for ' + archive_path + ' (powershell exited ' + result.status + ')' );
		}
		return;
	}

	const result = spawnSync( 'unzip', [ '-q', '-o', archive_path, '-d', target_dir ], { stdio: 'inherit' } );
	if ( result.status !== 0 )
	{
		throw new Error( 'unzip failed for ' + archive_path + ' (exit ' + result.status + ')' );
	}
}


//---------------------------------------------------------------------
// Single-quote a string for PowerShell. Doubles any embedded single quote.
//---------------------------------------------------------------------
function escape_powershell_arg( value )
{
	return '\'' + String( value ).replace( /'/g, '\'\'' ) + '\'';
}


//---------------------------------------------------------------------
// Extract a tar.gz / tar.xz / tar archive into target_dir. The archive
// is referenced by basename so Windows tar doesn't misread the drive
// letter as a remote host.
//---------------------------------------------------------------------
function extract_tar( archive_path, target_dir, compression )
{
	fs.mkdirSync( target_dir, { recursive: true } );

	let flags;
	if ( compression === 'gz' )
	{
		flags = '-xzf';
	}
	else if ( compression === 'xz' )
	{
		flags = '-xJf';
	}
	else
	{
		flags = '-xf';
	}

	const archive_dir = path.dirname( archive_path );
	const archive_name = path.basename( archive_path );
	const result = spawnSync(
		system_tar(),
		[ flags, archive_name, '-C', target_dir ],
		{ stdio: 'inherit', cwd: archive_dir }
	);
	if ( result.status !== 0 )
	{
		throw new Error( 'tar failed for ' + archive_path + ' (exit ' + result.status + ')' );
	}
}


//---------------------------------------------------------------------
// Convenience dispatcher used by installers. format is 'zip', 'tar.gz',
// 'tar.xz', or 'tar'.
//---------------------------------------------------------------------
function extract( archive_path, target_dir, format )
{
	if ( format === 'zip' )
	{
		extract_zip( archive_path, target_dir );
		return;
	}
	if ( format === 'tar.gz' )
	{
		extract_tar( archive_path, target_dir, 'gz' );
		return;
	}
	if ( format === 'tar.xz' )
	{
		extract_tar( archive_path, target_dir, 'xz' );
		return;
	}
	if ( format === 'tar' )
	{
		extract_tar( archive_path, target_dir, null );
		return;
	}
	throw new Error( 'Unsupported archive format: ' + format );
}


//---------------------------------------------------------------------
module.exports = {
	extract: extract,
	extract_zip: extract_zip,
	extract_tar: extract_tar,
	system_tar: system_tar
};
