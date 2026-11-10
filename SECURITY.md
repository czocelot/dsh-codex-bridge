# Security and privacy

This plugin runs as host code in DSH. Installing any host plugin grants it access available to that host; workspace sandbox settings do not isolate the plugin itself. Install only packages you trust and verify their source/checksum.

The bridge binds IPv4 loopback only, validates Host and remote address, rejects browser Origin headers, and pins each explicitly connected session's ID and project directory. Permission changes use the native service with exact confirmation. A new install has no bound session and cannot auto-select a project or submit a model task.

The HTTP API has **no independent authentication token**. Local processes running as the same user can reach it and may submit work to sessions the user has connected. The security boundary is the local OS account and DSH's native permission system. Do not expose, port-forward, reverse-proxy or tunnel it to a network, and do not describe the custom control header as authentication.

Private runtime state can contain project paths, session IDs, request text digests/results and permission audit records. It stays in DSH Home/plugin-data/dsh-codex-bridge and is not part of the release. Diagnostic redaction is best effort; inspect logs before sharing them. Do not share the DSH profile, credentials, plugin-data, request ledger, bindings or model-provider settings.

To report a bug privately, send the maintainer the package/DSH version, a minimal reproduction and a manually redacted error. Do not attach credentials or full conversation history. A public reporting URL is supplied only after the maintainer chooses a repository.
