# DSH Codex Bridge

[中文使用说明](README.zh.md)

Connect Codex or another local HTTP client to DSH sessions you select. Keep separate project bindings, check each request's progress and results, and cancel queued requests from the bridge.

This is an independent plugin, licensed under [MIT](LICENSE). It is not an official DeepSeek or OpenAI product.

## Install

You need a working DSH installation. This version was checked with DSH Desktop **0.2.2-rc.1** and its bundled runtime. A standalone runtime must be Node.js 22 or newer.

Download the **[0.8.0 installation package](https://github.com/czocelot/dsh-codex-bridge/releases/download/v0.8.0/dsh-codex-bridge-0.8.0.tgz)** and its [SHA-256 checksum file](https://github.com/czocelot/dsh-codex-bridge/releases/download/v0.8.0/SHA256SUMS.txt). [Release notes](https://github.com/czocelot/dsh-codex-bridge/releases/tag/v0.8.0).

1. Save both files. To check the download on Windows, run the following in their folder and compare the hash with the line in the checksum file:

   ```powershell
   Get-FileHash .\dsh-codex-bridge-0.8.0.tgz -Algorithm SHA256
   Get-Content .\SHA256SUMS.txt
   ```

2. Open DSH's **Plugins → Install** page and paste the tarball's absolute local path. You can also paste the direct installation URL below.
3. Confirm installation. When it finishes, check the package name `dsh-codex-bridge` and version `0.8.0`.
4. Choose **Enable now**, or enable the bundle on the Plugins page. Restart DSH if it requests a restart.

Direct installation URL:

```text
https://github.com/czocelot/dsh-codex-bridge/releases/download/v0.8.0/dsh-codex-bridge-0.8.0.tgz
```

Use this repository's release assets: the similarly named npm package is a different project. You do not need to edit YAML, run npm commands, or create another API key.

## Connect a session

1. Open **Settings → Bridge connection permissions**.
2. Add a binding and select an existing top-level DSH session. Check its project directory, especially when sessions share a title.
3. Keep **Use current native permissions** unless you intend to change the permission preset, then save the binding.

A fresh installation has no bound sessions. If the list is empty, create a project session in DSH first. Browsing the list does not submit a model task; connecting may load the selected session. Changing a native permission preset requires a separate confirmation.

## Use from a local client

The default address is `http://127.0.0.1:19491`. Check that the bridge is running:

```powershell
Invoke-RestMethod http://127.0.0.1:19491/status
Invoke-RestMethod http://127.0.0.1:19491/sessions
```

Configure your HTTP client to send requests to `POST /v1/prompt` using an explicitly bound `session_id` and a unique `request_id`. The [API guide](docs/API.md) includes a complete request example, progress/results endpoints, and queued cancellation. The bridge does not automatically register tools in Codex.

If a submission times out, check its original request ID before retrying. Queued cancellation applies to that bridge request; it does not stop the whole DSH session.

## Troubleshooting and data

- **Listener unavailable or port in use:** choose an unused port in the Bridge panel and save it. Update your client's address to match.
- **Session not bound:** save a binding for that session in the panel.
- **Project directory changed:** verify the directory, remove the old binding, and reconnect.
- **Host services unavailable:** check your DSH version, let DSH finish loading, and refresh the panel. See [compatibility and validation](docs/VALIDATION.md) for what has been checked.

Private bindings and request/audit records live in DSH Home's `plugin-data/dsh-codex-bridge/`. Keep them private and retain your own backup before upgrading. Update or uninstall through DSH's plugin manager; uninstalling the package does not automatically erase these records.

The bridge is available only on the local machine and has no separate authentication token. Local processes can access sessions you bind. Keep it on loopback and read the [security notes](SECURITY.md) before use.

More: [advanced settings](docs/ADVANCED.md) · [development guide](docs/DEVELOPMENT.md) · [changelog](CHANGELOG.md) · [third-party notices](THIRD_PARTY_NOTICES.md).
