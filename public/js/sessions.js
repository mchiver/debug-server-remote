app.controller( 'SessionController', function( $scope, $http, $window, $timeout, ApiService )
{
	const ctrl = this;

	ctrl.sessions = [];
	ctrl.selected_session = null;
	ctrl.console_lines = [];
	ctrl.call_stack = [];
	ctrl.variables = [];
	ctrl.selected_frame_index = 0;
	ctrl.active_tab = 'console';
	ctrl.stdin_input = '';
	ctrl.exec_command = '';
	ctrl.exec_result = null;
	ctrl.evaluate_expression = '';
	ctrl.evaluate_result = null;
	ctrl.evaluate_error = null;
	ctrl.bp_url = '';
	ctrl.bp_line = '';
	ctrl.breakpoints = [];
	ctrl.source_lines = [];
	ctrl.current_line = null;
	ctrl.line_breakpoints = [];
	ctrl.log_entries = [];
	ctrl.log_polling = null;
	ctrl.exception_pause = 'none';

	function init()
	{
		ctrl.sessions = ApiService.sessions;
	}

	ApiService.on_session_created = function( session )
	{
		// Nothing extra needed; the session list auto-updates via shared array.
	};

	ApiService.on_session_updated = function( session )
	{
		if ( ctrl.selected_session && ctrl.selected_session.id === session.id )
		{
			ctrl.selected_session = session;
			if ( session.status === 'exited' )
			{
				ctrl.current_line = null;
				ctrl.call_stack = [];
				ctrl.variables = [];
			}
		}
	};

	ApiService.on_session_exited = function( session_id )
	{
		ctrl._stop_log_polling();
		if ( ctrl.selected_session && ctrl.selected_session.id === session_id )
		{
			ctrl.selected_session = null;
			ctrl.console_lines = [];
			ctrl.call_stack = [];
			ctrl.variables = [];
			ctrl.current_line = null;
		}
	};

	ApiService.on_output_update = function( session_id, lines )
	{
		if ( ctrl.selected_session && ctrl.selected_session.id === session_id )
		{
			for ( let i = 0; i < lines.length; i++ )
			{
				const line = lines[ i ];
				ctrl.console_lines.push( { source: line.source || 'stdout', text: line.text } );
			}
			ctrl.scroll_console();
		}
	};

	ApiService.on_debugger_paused = function( session_id, data )
	{
		if ( ctrl.selected_session && ctrl.selected_session.id === session_id )
		{
			ctrl.selected_session.status = 'paused';
			ctrl.active_tab = 'source';
			ctrl.fetch_source();
			ctrl.fetch_stack_and_variables();
		}
	};

	ApiService.on_debugger_resumed = function( session_id )
	{
		if ( ctrl.selected_session && ctrl.selected_session.id === session_id )
		{
			if ( ctrl.selected_session.status !== 'exited' )
			{
				ctrl.selected_session.status = 'running';
			}
			ctrl.call_stack = [];
			ctrl.variables = [];
			ctrl.current_line = null;
		}
	};

	ctrl.selectSession = function( session )
	{
		ctrl.selected_session = session;
		ctrl.active_tab = 'console';
		ctrl.console_lines = [];
		ctrl.call_stack = [];
		ctrl.variables = [];
		ctrl.selected_frame_index = 0;
		ctrl.log_entries = [];
		ctrl.exec_result = null;
		ctrl.exec_command = '';
		ctrl.stdin_input = '';
		ctrl.exception_pause = 'none';
		ctrl._start_log_polling();
		ctrl.fetch_output();
		ctrl.fetch_source();
		if ( session.status === 'paused' )
		{
			ctrl.fetch_stack_and_variables();
		}
	};

	ctrl._start_log_polling = function()
	{
		if ( ctrl.log_polling )
		{
			clearInterval( ctrl.log_polling );
			ctrl.log_polling = null;
		}
		if ( !ctrl.selected_session )
		{
			return;
		}
		ctrl.fetch_logs();
		ctrl.log_polling = setInterval( function()
		{
			if ( ctrl.active_tab === 'logs' )
			{
				ctrl.fetch_logs();
			}
		}, 2000 );
	};

	ctrl._stop_log_polling = function()
	{
		if ( ctrl.log_polling )
		{
			clearInterval( ctrl.log_polling );
			ctrl.log_polling = null;
		}
	};

	ctrl.updateSettings = function()
	{
		if ( !ctrl.selected_session )
		{
			return;
		}
		ApiService.update_session_settings( ctrl.selected_session.id, {
			break_on_first_line: ctrl.selected_session.break_on_first_line
		} );
	};

	ctrl.setExceptionPause = function()
	{
		if ( !ctrl.selected_session )
		{
			return;
		}
		$http.post( '/api/sessions/' + ctrl.selected_session.id + '/debug/exception-pause', {
			state: ctrl.exception_pause
		} );
	};

	ctrl.sendInput = function()
	{
		if ( !ctrl.selected_session || !ctrl.stdin_input )
		{
			return;
		}
		ApiService.send_input( ctrl.selected_session.id, ctrl.stdin_input );
		ctrl.stdin_input = '';
	};

	ctrl.runExec = function()
	{
		if ( !ctrl.selected_session || !ctrl.exec_command )
		{
			return;
		}
		ctrl.exec_result = null;
		ApiService.run_exec( ctrl.selected_session.id, ctrl.exec_command )
			.then( function( response )
			{
				ctrl.exec_result = response.data;
			} )
			.catch( function( err )
			{
				alert( 'Exec failed: ' + ( err.data ? err.data.error : err.message ) );
			} );
	};

	ctrl.fetch_logs = function()
	{
		if ( !ctrl.selected_session )
		{
			return;
		}
		$http.get( '/api/sessions/' + ctrl.selected_session.id + '/logs?offset=0&limit=500' )
			.then( function( response )
			{
				ctrl.log_entries = response.data.logs || [];
			} );
	};

	ctrl.formatBreakpointUrl = function( url )
	{
		if ( ctrl.selected_session && ctrl.selected_session.type === 'snippet' )
		{
			return '<pasted code>';
		}
		return url || '(auto)';
	};

	ctrl.formatLogData = function( data )
	{
		if ( data === null || data === undefined )
		{
			return '';
		}
		if ( typeof data === 'string' )
		{
			return data;
		}
		try
		{
			return JSON.stringify( data );
		}
		catch ( e )
		{
			return String( data );
		}
	};

	ctrl.fetch_output = function()
	{
		if ( !ctrl.selected_session )
		{
			return;
		}
		$http.get( '/api/sessions/' + ctrl.selected_session.id + '/output?offset=0&limit=1000' )
			.then( function( response )
			{
				ctrl.console_lines = response.data.lines;
				ctrl.scroll_console();
			} );
	};

	ctrl.scroll_console = function()
	{
		setTimeout( function()
		{
			const el = document.getElementById( 'console-output' );
			if ( el )
			{
				el.scrollTop = el.scrollHeight;
			}
		}, 50 );
	};

	ctrl.clearConsole = function()
	{
		ctrl.console_lines = [];
	};

	ctrl.killSession = function( id )
	{
		if ( !confirm( 'Are you sure you want to kill this session?' ) )
		{
			return;
		}
		ApiService.delete_session( id )
			.then( function()
			{
				ctrl._stop_log_polling();
				if ( ctrl.selected_session && ctrl.selected_session.id === id )
				{
					ctrl.selected_session = null;
					ctrl.console_lines = [];
					ctrl.call_stack = [];
					ctrl.variables = [];
					ctrl.current_line = null;
				}
			} );
	};

	ctrl.restartSession = function( id )
	{
		if ( !ctrl.selected_session )
		{
			return;
		}
		ApiService.restart_session( id )
			.then( function( response )
			{
				ctrl.console_lines = [];
				ctrl.call_stack = [];
				ctrl.variables = [];
				ctrl.source_lines = [];
				ctrl.current_line = null;
				ctrl.selectSession( response.data.session );
				ctrl.fetch_source();
			} );
	};

	ctrl.debugResume = function()
	{
		if ( !ctrl.selected_session )
		{
			return;
		}
		$http.post( '/api/sessions/' + ctrl.selected_session.id + '/debug/resume' );
	};

	ctrl.debugStepOver = function()
	{
		if ( !ctrl.selected_session )
		{
			return;
		}
		$http.post( '/api/sessions/' + ctrl.selected_session.id + '/debug/step_over' );
	};

	ctrl.debugStepInto = function()
	{
		if ( !ctrl.selected_session )
		{
			return;
		}
		$http.post( '/api/sessions/' + ctrl.selected_session.id + '/debug/step_into' );
	};

	ctrl.debugStepOut = function()
	{
		if ( !ctrl.selected_session )
		{
			return;
		}
		$http.post( '/api/sessions/' + ctrl.selected_session.id + '/debug/step_out' );
	};

	ctrl.fetch_stack_and_variables = function()
	{
		if ( !ctrl.selected_session )
		{
			return;
		}
		$http.get( '/api/sessions/' + ctrl.selected_session.id + '/debug/stack' )
			.then( function( response )
			{
				ctrl.call_stack = response.data.stack;
				ctrl.selected_frame_index = 0;
				ctrl.fetch_variables();
			} );
	};

	ctrl.selectFrame = function( index )
	{
		ctrl.selected_frame_index = index;
		ctrl.fetch_variables();
	};

	ctrl.fetch_variables = function()
	{
		if ( !ctrl.selected_session || ctrl.call_stack.length === 0 )
		{
			return;
		}
		$http.get( '/api/sessions/' + ctrl.selected_session.id + '/debug/variables?frame_index=' + ctrl.selected_frame_index + '&scope_type=local' )
			.then( function( response )
			{
				ctrl.variables = response.data.variables;
			} );
	};

	ctrl.runEvaluate = function()
	{
		if ( !ctrl.selected_session || !ctrl.evaluate_expression )
		{
			return;
		}
		$http.post( '/api/sessions/' + ctrl.selected_session.id + '/debug/evaluate', {
			expression: ctrl.evaluate_expression,
			frame_index: ctrl.selected_frame_index
		} ).then( function( response )
		{
			ctrl.evaluate_result = response.data.result;
			ctrl.evaluate_error = null;
		} ).catch( function( err )
		{
			ctrl.evaluate_error = ( err.data ? err.data.error : err.message );
			ctrl.evaluate_result = null;
		} );
	};

	ctrl.addBreakpoint = function()
	{
		if ( !ctrl.selected_session || !ctrl.bp_line )
		{
			return;
		}
		$http.post( '/api/sessions/' + ctrl.selected_session.id + '/debug/breakpoint', {
			url: ctrl.bp_url,
			line_number: parseInt( ctrl.bp_line, 10 )
		} ).then( function( response )
		{
			ctrl.breakpoints.push( { id: response.data.breakpoint_id, url: ctrl.bp_url, line: parseInt( ctrl.bp_line, 10 ) } );
			ctrl.bp_url = '';
			ctrl.bp_line = '';
		} );
	};

	ctrl.fetch_source = function()
	{
		if ( !ctrl.selected_session )
		{
			return;
		}
		$http.get( '/api/sessions/' + ctrl.selected_session.id + '/source' )
			.then( function( response )
			{
				ctrl.source_lines = response.data.content.split( /\r?\n/ );
				ctrl.current_line = response.data.current_line || ctrl.selected_session.current_line;
				ctrl.breakpoints = response.data.breakpoints || [];
				ctrl._update_line_breakpoints();
			} );
	};

	ctrl._update_line_breakpoints = function()
	{
		const lines = [];
		for ( let i = 0; i < ctrl.breakpoints.length; i++ )
		{
			lines.push( ctrl.breakpoints[ i ].line );
		}
		ctrl.line_breakpoints = lines;
	};

	ctrl.removeBreakpoint = function( breakpoint_id )
	{
		if ( !ctrl.selected_session )
		{
			return;
		}
		$http.delete( '/api/sessions/' + ctrl.selected_session.id + '/debug/breakpoint/' + encodeURIComponent( breakpoint_id ) )
			.then( function()
			{
				const filtered = [];
				for ( let i = 0; i < ctrl.breakpoints.length; i++ )
				{
					if ( ctrl.breakpoints[ i ].id !== breakpoint_id )
					{
						filtered.push( ctrl.breakpoints[ i ] );
					}
				}
				ctrl.breakpoints = filtered;
				ctrl._update_line_breakpoints();
			} );
	};

	ctrl.toggleBreakpoint = function( line_number, event )
	{
		if ( event )
		{
			event.stopPropagation();
		}
		if ( !ctrl.selected_session )
		{
			return;
		}
		let existing = null;
		for ( let i = 0; i < ctrl.breakpoints.length; i++ )
		{
			if ( ctrl.breakpoints[ i ].line === line_number )
			{
				existing = ctrl.breakpoints[ i ];
				break;
			}
		}
		if ( existing )
		{
			ctrl.removeBreakpoint( existing.id );
		}
		else
		{
			$http.post( '/api/sessions/' + ctrl.selected_session.id + '/debug/breakpoint', {
				url: '',
				line_number: line_number
			} ).then( function( response )
			{
				ctrl.breakpoints.push( { id: response.data.breakpoint_id, url: '', line: line_number } );
				ctrl._update_line_breakpoints();
			} );
		}
	};

	init();
} );
