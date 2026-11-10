# Settings API

See [docs/API.md](docs/API.md) for the public HTTP and settings RPC contract. The current `codexBridgeConnection` namespace has nine methods: list, presets, listener, snapshot, prepare, confirm, cancel, savePort and unbind. Explicit confirmation uses native permission services. A read never acts as permission to submit a task.
