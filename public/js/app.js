const app = angular.module( 'debugBridgeApp', [] );

//---------------------------------------------------------------------
// ApiService — central HTTP + WebSocket handler used by all controllers.
//---------------------------------------------------------------------
app.service( 'ApiService', function( $http, $window, $rootScope )
{
	const self = this;

	self.sessions = [];
	self.workspaces = [];
	self.registry = [];
	self.ws_connected = false;
	self.on_event = null;
	self.on_session_created = null;
	self.on_session_updated = null;
	self.on_session_exited = null;
	self.on_output_update = null;
	self.on_debugger_paused = null;
	self.on_debugger_resumed = null;

	const ws_protocol = $window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	const ws_url = ws_protocol + '//' + $window.location.host;
	let ws = null;

	function connect()
	{
		ws = new WebSocket( ws_url );
		ws.onopen = function()
		{
			self.ws_connected = true;
			$rootScope.$apply();
		};
		ws.onclose = function()
		{
			self.ws_connected = false;
			$rootScope.$apply();
			setTimeout( connect, 1000 );
		};
		ws.onmessage = function( event )
		{
			const message = JSON.parse( event.data );
			handle_message( message.event, message.data );
			$rootScope.$apply();
		};
		ws.onclose = function()
		{
			self.ws_connected = false;
			setTimeout( connect, 1000 );
		};
		ws.onerror = function()
		{
			ws.close();
		};
	}
	connect();

	function handle_message( event, data )
	{
		if ( self.on_event )
		{
			self.on_event( event, data );
		}
		switch ( event )
		{
		case 'session_list':
			self.sessions.length = 0;
			const list = data.sessions || [];
			for ( let i = 0; i < list.length; i++ )
			{
				self.sessions.push( list[ i ] );
			}
			break;
			case 'session_created':
				self.sessions.push( data.session );
				if ( self.on_session_created )
				{
					self.on_session_created( data.session );
				}
				break;
			case 'session_updated':
				update_session( data.session );
				if ( self.on_session_updated )
				{
					self.on_session_updated( data.session );
				}
				break;
			case 'session_exited':
				remove_session( data.session_id );
				if ( self.on_session_exited )
				{
					self.on_session_exited( data.session_id );
				}
				break;
			case 'output_update':
				if ( self.on_output_update )
				{
					self.on_output_update( data.session_id, data.lines );
				}
				break;
			case 'debugger_paused':
				update_session_status( data.session_id, 'paused' );
				if ( self.on_debugger_paused )
				{
					self.on_debugger_paused( data.session_id, data );
				}
				break;
			case 'debugger_resumed':
				update_session_status( data.session_id, 'running' );
				if ( self.on_debugger_resumed )
				{
					self.on_debugger_resumed( data.session_id );
				}
				break;
		}
	}

	function update_session( session )
	{
		for ( let i = 0; i < self.sessions.length; i++ )
		{
			if ( self.sessions[ i ].id === session.id )
			{
				self.sessions[ i ] = session;
				return;
			}
		}
	}

	function update_session_status( id, status )
	{
		for ( let i = 0; i < self.sessions.length; i++ )
		{
			if ( self.sessions[ i ].id === id )
			{
				if ( self.sessions[ i ].status === 'exited' )
				{
					return;
				}
				self.sessions[ i ].status = status;
				return;
			}
		}
	}

	function remove_session( id )
	{
		for ( let i = self.sessions.length - 1; i >= 0; i-- )
		{
			if ( self.sessions[ i ].id === id )
			{
				self.sessions.splice( i, 1 );
			}
		}
	}

	self.fetch_workspaces = function()
	{
		return $http.get( '/api/workspaces' )
			.then( function( response )
			{
				self.workspaces = response.data.workspaces || [];
				return self.workspaces;
			} );
	};

	self.fetch_registry = function()
	{
		return $http.get( '/api/registry' )
			.then( function( response )
			{
				self.registry = response.data.engines || [];
				return self.registry;
			} );
	};

	self.get_workspace = function( id )
	{
		return $http.get( '/api/workspaces/' + id )
			.then( function( response )
			{
				return response.data;
			} );
	};

	self.create_workspace = function( name )
	{
		return $http.post( '/api/workspaces', { name: name || undefined } )
			.then( function( response )
			{
				return response.data.workspace;
			} );
	};

	self.delete_workspace = function( id )
	{
		return $http.delete( '/api/workspaces/' + id );
	};

	self.read_file = function( workspace_id, rel_path )
	{
		return $http.get( '/api/workspaces/' + workspace_id + '/files/' + rel_path, { responseType: 'arraybuffer' } )
			.then( function( response )
			{
				const bytes = new Uint8Array( response.data );
				// Simple binary check: if any byte is zero or outside printable range heavily, treat as binary.
				let text = true;
				let non_text = 0;
				for ( let i = 0; i < bytes.length; i++ )
				{
					const b = bytes[ i ];
					if ( b === 0 )
					{
						text = false;
						break;
					}
					if ( b < 9 || ( b > 13 && b < 32 ) )
					{
						non_text++;
					}
				}
				if ( non_text > bytes.length * 0.1 )
				{
					text = false;
				}
				if ( text )
				{
					return { text: new TextDecoder().decode( bytes ), binary: false };
				}
				return { text: null, binary: true };
			} );
	};

	self.write_file = function( workspace_id, rel_path, content )
	{
		return $http.put( '/api/workspaces/' + workspace_id + '/files/' + rel_path, content, { headers: { 'Content-Type': 'text/plain' } } );
	};

	self.delete_file = function( workspace_id, rel_path )
	{
		return $http.delete( '/api/workspaces/' + workspace_id + '/files/' + rel_path );
	};

	self.create_session = function( payload )
	{
		return $http.post( '/api/sessions', payload );
	};

	self.get_session = function( id )
	{
		return $http.get( '/api/sessions/' + id );
	};

	self.delete_session = function( id )
	{
		return $http.delete( '/api/sessions/' + id );
	};

	self.restart_session = function( id )
	{
		return $http.post( '/api/sessions/' + id + '/restart' );
	};

	self.update_session_settings = function( id, settings )
	{
		return $http.post( '/api/sessions/' + id + '/settings', settings );
	};

	self.send_input = function( id, data )
	{
		return $http.post( '/api/sessions/' + id + '/input', { data: data } );
	};

	self.run_exec = function( id, command )
	{
		return $http.post( '/api/sessions/' + id + '/exec', { command: command } );
	};

	self.triage = function( payload )
	{
		return $http.post( '/api/triage', payload );
	};
} );


//---------------------------------------------------------------------
// MainController — view routing, shared modal state, registry fetch.
//---------------------------------------------------------------------
app.controller( 'MainController', function( $scope, ApiService )
{
	const main = this;

	main.current_view = 'sessions';
	main.ws_connected = false;
	main.show_session_modal = false;
	main.modal_tab = 'workspace';
	main.workspaces = [];
	main.registry = [];
	main.modal_workspace_id = '';
	main.modal_relative_path = '';
	main.modal_snippet = '';
	main.modal_files = [ { name: '', content: '' } ];
	main.modal_entry = '';
	main.modal_engine_base = '';
	main.modal_engine_version = '';
	main.modal_versions = [];
	main.modal_break_first = false;
	main.modal_exception_pause = 'none';
	main.modal_env_vars = [];

	function refresh_workspaces()
	{
		ApiService.fetch_workspaces().then( function( list )
		{
			main.workspaces = list;
			if ( list.length > 0 && !main.modal_workspace_id )
			{
				main.modal_workspace_id = list[ 0 ].id;
			}
		} );
	}

	function refresh_registry()
	{
		ApiService.fetch_registry().then( function( engines )
		{
			main.registry = engines;
			if ( engines.length > 0 )
			{
				main.modal_engine_base = engines[ 0 ].base;
				main.onModalEngineChange();
			}
		} );
	}

	refresh_workspaces();
	refresh_registry();

	$scope.$watch( function() { return ApiService.ws_connected; }, function( val )
	{
		main.ws_connected = val;
	} );

	main.openNewSessionModal = function( prefill_workspace_id )
	{
		main.show_session_modal = true;
		main.modal_tab = 'workspace';
		main.modal_snippet = '';
		main.modal_files = [ { name: '', content: '' } ];
		main.modal_entry = '';
		main.modal_break_first = false;
		main.modal_exception_pause = 'none';
		main.modal_env_vars = [];
		if ( prefill_workspace_id )
		{
			main.modal_workspace_id = prefill_workspace_id;
		}
		else if ( main.workspaces.length > 0 )
		{
			main.modal_workspace_id = main.workspaces[ 0 ].id;
		}
	};

	main.closeSessionModal = function( event )
	{
		if ( event.target.id === 'newSessionModal' )
		{
			main.show_session_modal = false;
		}
	};

	main.onModalEngineChange = function()
	{
		main.modal_versions = [];
		main.modal_engine_version = '';
		for ( let i = 0; i < main.registry.length; i++ )
		{
			if ( main.registry[ i ].base === main.modal_engine_base )
			{
				main.modal_versions = main.registry[ i ].versions;
				if ( main.modal_versions.length > 0 )
				{
					main.modal_engine_version = main.modal_versions[ 0 ].version_string;
				}
				break;
			}
		}
	};

	main.addModalFile = function()
	{
		main.modal_files.push( { name: '', content: '' } );
	};

	main.removeModalFile = function( index )
	{
		main.modal_files.splice( index, 1 );
		if ( main.modal_files.length === 0 )
		{
			main.modal_files.push( { name: '', content: '' } );
		}
	};

	main.addModalEnv = function()
	{
		main.modal_env_vars.push( { key: '', value: '' } );
	};

	main.removeModalEnv = function( index )
	{
		main.modal_env_vars.splice( index, 1 );
	};

	main.createSession = function()
	{
		let payload;
		if ( main.modal_tab === 'workspace' )
		{
			payload = {
				workspace_id: main.modal_workspace_id,
				relative_path: main.modal_relative_path
			};
		}
		else if ( main.modal_tab === 'snippet' )
		{
			payload = { content: main.modal_snippet };
		}
		else
		{
			const files_map = {};
			for ( let i = 0; i < main.modal_files.length; i++ )
			{
				const f = main.modal_files[ i ];
				if ( f.name )
				{
					files_map[ f.name ] = f.content;
				}
			}
			payload = { files: files_map, entry: main.modal_entry };
		}

		payload.engine = main.modal_engine_base + ( main.modal_engine_version ? '@' + main.modal_engine_version : '' );
		payload.break_on_first_line = main.modal_break_first;
		payload.exception_pause = main.modal_exception_pause;

		if ( main.modal_env_vars.length > 0 )
		{
			payload.env_vars = {};
			for ( let i = 0; i < main.modal_env_vars.length; i++ )
			{
				const e = main.modal_env_vars[ i ];
				if ( e.key )
				{
					payload.env_vars[ e.key ] = e.value;
				}
			}
		}

		ApiService.create_session( payload )
			.then( function( response )
			{
				main.show_session_modal = false;
				main.current_view = 'sessions';
			} )
			.catch( function( err )
			{
				alert( 'Failed to create session: ' + ( err.data ? err.data.error : err.message ) );
			} );
	};
} );
