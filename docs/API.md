# Local HTTP API

Base: `http://127.0.0.1:19491`, or the port explicitly saved in the Bridge panel. This is not an MCP server and does not automatically register Codex tools. Use an HTTP-capable local client with the user's permission. Browser-origin requests and non-loopback requests are rejected. Responses are JSON and are not cached.

## Read endpoints

- `GET /status`: package version, listener/default-session status. A fresh install has no default bound session.
- `GET /sessions`: currently bound accessible sessions.
- `GET /sessions/status?session_id=...`: exact bound session status.
- `GET /requests/status?session_id=...&request_id=...&after_seq=-1`: owned request progress.
- `GET /requests/results?session_id=...&request_id=...&after_seq=-1`: owned request result frames. Continue from the returned sequence cursor; never combine another request's frames.

## Submit

`POST /v1/prompt` with Content-Type: application/json:

~~~json
{"session_id":"session-11111111-1111-4111-8111-111111111111","request_id":"codex-example-001","text":"Summarize this project's current goal.","mode":"queue"}
~~~

Replace the synthetic session ID with the explicitly connected session. text is limited to 6,500 characters and the JSON body to 24,000 bytes. mode is queue or steer. request_id uses `codex-` followed by 1–100 letters, digits, underscores or hyphens. A duplicate ID cannot be reused for different content or a different session. If a response is lost, query the original ID before retrying. The legacy `/prompt` alias only has a default target if a maintainer explicitly configured one.

## Cancel one queued request

`POST /requests/cancel` with Content-Type: application/json:

~~~json
{"session_id":"session-11111111-1111-4111-8111-111111111111","request_id":"codex-example-001"}
~~~

This removes only a queued inbox item owned by this bridge, not an arbitrary user message or the entire active session. Read the returned state; cancellation may be too late.

## Settings and permissions

Prefer the Bridge settings panel. The connection endpoints are `/sessions/connection` (GET) and `/sessions/connection/prepare`, `/confirm`, `/cancel` (POST). Control POSTs require `x-codex-bridge-control: bridge-connection-v1`. Native permission changes use `/sessions/permissions` with `x-codex-bridge-control: native-permission-preset-v1` and exact from/to/revision confirmation. A custom header is an intent guard, not a password.

The public DSH settings RPC namespace is `codexBridgeConnection`: list, presets, listener, snapshot, prepare, confirm, cancel, savePort and unbind. Reads do not silently change permissions. An empty preset (null) retains the current native configuration.

Errors use `{"error":"CODE"}` with an HTTP status. Examples: SESSION_NOT_BOUND (bind explicitly), SESSION_SCOPE_MISMATCH (verify project), REQUEST_CONTENT_MISMATCH / REQUEST_SESSION_MISMATCH (query the original ID), LOOPBACK_ONLY (use a local non-browser client). Do not retry an uncertain action with a new ID.
