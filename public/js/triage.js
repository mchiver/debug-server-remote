app.controller( 'TriageController', function( $scope, $http, ApiService )
{
	const triage = this;

	triage.snippet = '';
	triage.registry = [];
	triage.versions = [];
	triage.selected_engine_base = '';
	triage.selected_version = '';
	triage.break_on_first_line = false;
	triage.exception_pause = 'none';
	triage.running = false;
	triage.result = null;

	function init()
	{
		ApiService.fetch_registry().then( function( engines )
		{
			triage.registry = engines;
			if ( engines.length > 0 )
			{
				triage.selected_engine_base = engines[ 0 ].base;
				triage.onEngineChange();
			}
		} );
	}

	triage.onEngineChange = function()
	{
		triage.versions = [];
		triage.selected_version = '';
		for ( let i = 0; i < triage.registry.length; i++ )
		{
			if ( triage.registry[ i ].base === triage.selected_engine_base )
			{
				triage.versions = triage.registry[ i ].versions;
				if ( triage.versions.length > 0 )
				{
					triage.selected_version = triage.versions[ 0 ].version_string;
				}
				break;
			}
		}
	};

	triage.run = function()
	{
		if ( !triage.snippet )
		{
			alert( 'Enter a code snippet.' );
			return;
		}
		triage.running = true;
		triage.result = null;

		const engine = triage.selected_engine_base + ( triage.selected_version ? '@' + triage.selected_version : '' );

		ApiService.triage( {
			content: triage.snippet,
			engine: engine,
			break_on_first_line: triage.break_on_first_line,
			exception_pause: triage.exception_pause
		} )
			.then( function( response )
			{
				triage.result = response.data;
				triage.running = false;
			} )
			.catch( function( err )
			{
				alert( 'Triage failed: ' + ( err.data ? err.data.error : err.message ) );
				triage.running = false;
			} );
	};

	init();
} );
