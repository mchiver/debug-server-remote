const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocket } = require('ws');
const { create_app } = require('../server');

let test_workspaces_root_counter = 0;
function fresh_workspaces_root()
{
	test_workspaces_root_counter = test_workspaces_root_counter + 1;
	return path.join(os.tmpdir(), 'dsr-test-' + process.pid + '-' + Date.now() + '-' + test_workspaces_root_counter);
}

//---------------------------------------------------------------------
function start_server()
{
	return new Promise(function(resolve)
	{
		const workspaces_root = fresh_workspaces_root();
		const parts = create_app({ workspace_options: { root: workspaces_root } });
		parts.server.listen(0, '127.0.0.1', function()
		{
			const address = parts.server.address();
			const base_url = 'http://127.0.0.1:' + address.port;
			const ws_url = 'ws://127.0.0.1:' + address.port;

			function close()
			{
				return new Promise(function(done)
				{
					const sessions = parts.session_manager.list();
					for (let i = 0; i < sessions.length; i++)
					{
						parts.session_manager.destroy(sessions[i].id);
					}
					parts.wss.close();
					parts.server.close(function()
					{
						try { fs.rmSync(workspaces_root, { recursive: true, force: true }); } catch (e) { /* ignore */ }
						done();
					});
				});
			}

			resolve({
				base_url: base_url,
				ws_url: ws_url,
				server: parts.server,
				session_manager: parts.session_manager,
				workspace_manager: parts.workspace_manager,
				close: close
			});
		});
	});
}

//---------------------------------------------------------------------
function http_request(method, url, body)
{
	return new Promise(function(resolve, reject)
	{
		const parsed = new URL(url);
		const options = {
			hostname: parsed.hostname,
			port: parsed.port,
			path: parsed.pathname + parsed.search,
			method: method,
			headers: { 'Content-Type': 'application/json' }
		};

		const req = http.request(options, function(res)
		{
			let data = '';
			res.on('data', function(chunk) { data += chunk; });
			res.on('end', function()
			{
				let parsed_body = null;
				if (data.length > 0)
				{
					try { parsed_body = JSON.parse(data); }
					catch (e) { parsed_body = data; }
				}
				resolve({ status: res.statusCode, body: parsed_body });
			});
		});

		req.on('error', reject);

		if (body !== undefined && body !== null)
		{
			req.write(JSON.stringify(body));
		}
		req.end();
	});
}

//---------------------------------------------------------------------
async function wait_until(predicate, timeout_ms)
{
	const limit = timeout_ms || 5000;
	const start = Date.now();
	while (Date.now() - start < limit)
	{
		const result = await predicate();
		if (result)
		{
			return result;
		}
		await new Promise(function(r) { setTimeout(r, 50); });
	}
	throw new Error('wait_until: timed out after ' + limit + 'ms');
}

//---------------------------------------------------------------------
function ws_connect(ws_url)
{
	return new Promise(function(resolve, reject)
	{
		const socket = new WebSocket(ws_url);
		const messages = [];
		const waiters = [];

		socket.on('message', function(data)
		{
			const msg = JSON.parse(data.toString());
			messages.push(msg);
			for (let i = waiters.length - 1; i >= 0; i--)
			{
				const w = waiters[i];
				if (w.match(msg))
				{
					waiters.splice(i, 1);
					w.resolve(msg);
				}
			}
		});

		socket.on('error', function(err)
		{
			reject(err);
		});

		socket.on('open', function()
		{
			resolve({
				socket: socket,
				messages: messages,
				wait_for: function(event_name, timeout_ms)
				{
					return new Promise(function(res, rej)
					{
						// Check existing messages first.
						for (let i = 0; i < messages.length; i++)
						{
							if (messages[i].event === event_name)
							{
								return res(messages[i]);
							}
						}
						const waiter = {
							match: function(m) { return m.event === event_name; },
							resolve: res
						};
						waiters.push(waiter);
						const t = setTimeout(function()
						{
							const ndx = waiters.indexOf(waiter);
							if (ndx >= 0) { waiters.splice(ndx, 1); }
							rej(new Error('Timeout waiting for ws event: ' + event_name));
						}, timeout_ms || 5000);
						const original_resolve = waiter.resolve;
						waiter.resolve = function(msg) { clearTimeout(t); original_resolve(msg); };
					});
				},
				close: function()
				{
					return new Promise(function(done)
					{
						socket.on('close', done);
						socket.close();
					});
				}
			});
		});
	});
}

//---------------------------------------------------------------------
function fixture_path(name)
{
	return path.join(__dirname, 'fixtures', name);
}

//---------------------------------------------------------------------
function snippet_payload(content, options)
{
	const opts = options || {};
	return {
		content: content,
		break_on_first_line: opts.break_on_first_line || false
	};
}

//---------------------------------------------------------------------
// Reads the fixture file off disk and emits an inline-content payload.
// The server is workspace-only; tests that previously pointed at an
// absolute path now ship the contents through the inline shape.
function file_payload(file_path, options)
{
	const opts = options || {};
	const content = fs.readFileSync(file_path, 'utf-8');
	return {
		content: content,
		break_on_first_line: opts.break_on_first_line || false
	};
}

module.exports = {
	start_server: start_server,
	http_request: http_request,
	wait_until: wait_until,
	ws_connect: ws_connect,
	fixture_path: fixture_path,
	snippet_payload: snippet_payload,
	file_payload: file_payload
};
