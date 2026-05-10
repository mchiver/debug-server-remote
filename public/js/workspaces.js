app.controller( 'WorkspaceController', function( $scope, $http, ApiService )
{
	const ws = this;

	ws.workspaces = [];
	ws.selected_workspace = null;
	ws.files = [];
	ws.selected_file = null;
	ws.file_content = '';
	ws.is_text_file = true;
	ws.show_create_modal = false;
	ws.new_workspace_name = '';
	ws.show_new_file_modal = false;
	ws.new_file_path = '';

	function refresh()
	{
		ApiService.fetch_workspaces().then( function( list )
		{
			ws.workspaces = list;
			for ( let i = 0; i < ws.workspaces.length; i++ )
			{
				// Count will be fetched when selected.
				ws.workspaces[ i ].file_count = 0;
			}
			if ( ws.selected_workspace )
			{
				let found = false;
				for ( let i = 0; i < ws.workspaces.length; i++ )
				{
					if ( ws.workspaces[ i ].id === ws.selected_workspace.id )
					{
						ws.selected_workspace = ws.workspaces[ i ];
						found = true;
						break;
					}
				}
				if ( !found )
				{
					ws.selected_workspace = null;
					ws.files = [];
					ws.selected_file = null;
				}
			}
		} );
	}

	refresh();

	ws.selectWorkspace = function( w )
	{
		ws.selected_workspace = w;
		ws.selected_file = null;
		ws.file_content = '';
		ws.refreshFiles();
	};

	ws.refreshFiles = function()
	{
		if ( !ws.selected_workspace )
		{
			return;
		}
		ApiService.get_workspace( ws.selected_workspace.id ).then( function( data )
		{
			ws.files = data.files || [];
			ws.selected_workspace.file_count = ws.files.length;
		} );
	};

	ws.selectFile = function( f )
	{
		ws.selected_file = f;
		ws.is_text_file = false;
		ws.file_content = '';
		ApiService.read_file( ws.selected_workspace.id, f.path ).then( function( result )
		{
			ws.is_text_file = result.binary === false;
			if ( ws.is_text_file )
			{
				ws.file_content = result.text;
			}
		} );
	};

	ws.saveFile = function()
	{
		if ( !ws.selected_workspace || !ws.selected_file )
		{
			return;
		}
		ApiService.write_file( ws.selected_workspace.id, ws.selected_file.path, ws.file_content )
			.then( function()
			{
				alert( 'Saved.' );
				ws.refreshFiles();
			} )
			.catch( function( err )
			{
				alert( 'Save failed: ' + ( err.data ? err.data.error : err.message ) );
			} );
	};

	ws.openCreateModal = function()
	{
		ws.show_create_modal = true;
		ws.new_workspace_name = '';
	};

	ws.closeCreateModal = function( event )
	{
		if ( !event || event.target === event.currentTarget )
		{
			ws.show_create_modal = false;
		}
	};

	ws.createWorkspace = function()
	{
		ApiService.create_workspace( ws.new_workspace_name ).then( function( w )
		{
			ws.show_create_modal = false;
			refresh();
			ws.selectWorkspace( w );
		} );
	};

	ws.deleteWorkspace = function( id, event )
	{
		if ( event )
		{
			event.stopPropagation();
		}
		if ( !confirm( 'Delete this workspace?' ) )
		{
			return;
		}
		ApiService.delete_workspace( id )
			.then( function()
			{
				refresh();
			} )
			.catch( function( err )
			{
				alert( 'Delete failed: ' + ( err.data ? err.data.error : err.message ) );
			} );
	};

	ws.openNewFileModal = function()
	{
		ws.show_new_file_modal = true;
		ws.new_file_path = '';
	};

	ws.closeNewFileModal = function( event )
	{
		if ( !event || event.target === event.currentTarget )
		{
			ws.show_new_file_modal = false;
		}
	};

	ws.createNewFile = function()
	{
		if ( !ws.new_file_path )
		{
			return;
		}
		ApiService.write_file( ws.selected_workspace.id, ws.new_file_path, '' )
			.then( function()
			{
				ws.show_new_file_modal = false;
				ws.refreshFiles();
				// Select the new file.
				for ( let i = 0; i < ws.files.length; i++ )
				{
					if ( ws.files[ i ].path === ws.new_file_path )
					{
						ws.selectFile( ws.files[ i ] );
						break;
					}
				}
			} )
			.catch( function( err )
			{
				alert( 'Create failed: ' + ( err.data ? err.data.error : err.message ) );
			} );
	};

	ws.triggerUpload = function()
	{
		const el = document.getElementById( 'ws-upload-input' );
		if ( el )
		{
			el.click();
		}
	};

	ws.handleUpload = function( input_element )
	{
		if ( !input_element.files || input_element.files.length === 0 )
		{
			return;
		}
		const file = input_element.files[ 0 ];
		const reader = new FileReader();
		reader.onload = function( e )
		{
			const data = e.target.result;
			ApiService.write_file( ws.selected_workspace.id, file.name, data )
				.then( function()
				{
					ws.refreshFiles();
					// Select the uploaded file.
					for ( let i = 0; i < ws.files.length; i++ )
					{
						if ( ws.files[ i ].path === file.name )
						{
							ws.selectFile( ws.files[ i ] );
							break;
						}
					}
				} )
				.catch( function( err )
				{
					alert( 'Upload failed: ' + ( err.data ? err.data.error : err.message ) );
				} );
		};
		reader.readAsArrayBuffer( file );
		input_element.value = '';
	};

	ws.deleteFile = function( rel_path, event )
	{
		if ( event )
		{
			event.stopPropagation();
		}
		if ( !confirm( 'Delete ' + rel_path + '?' ) )
		{
			return;
		}
		ApiService.delete_file( ws.selected_workspace.id, rel_path )
			.then( function()
			{
				if ( ws.selected_file && ws.selected_file.path === rel_path )
				{
					ws.selected_file = null;
					ws.file_content = '';
				}
				ws.refreshFiles();
			} )
			.catch( function( err )
			{
				alert( 'Delete failed: ' + ( err.data ? err.data.error : err.message ) );
			} );
	};
} );
