# Advanced configuration

The normal bundle installs one host and one settings client. Its default config is port 19491, member compaction off, provider control off. No legacy session or project is required. Static legacy configuration may specify sessionId and an absolute workspace together; leave both empty for panel-only binding. sessionBindings can contain at most eight additional explicit objects with session_id, expected_title and workspace. Each additional binding needs an absolute workspace unless a legacy workspace was explicitly configured as its fallback. The title is display metadata, not routing authority.

## Optional rotation entry

`dsh-codex-bridge/rotation` preserves the pre-existing experimental layer-rotation APIs. It is **not enabled by the one-click bundle**. Do not load it alongside the ordinary host on the same port or register two settings services. It requires an explicit legacy sessionId, workspace and rotationLayers, DSH workspace/session control APIs, and separately authorized creation and handoff of sessions. It may create handoff files inside the configured project, preserve native model selection, and stop/rotate at its configured-in-code step bounds (soft trigger 650, hard guard before step 691, rotation ceiling 700). It is not part of the ordinary connection UI.

Its rotationLayers require explicit layer/sourceSessionId/prefix/handoffFile configuration. Prefixes currently supported by that experimental implementation are 调研层使用 and 执行层使用. No IDs or layer config are supplied with this release. Existing users should review their settings, keep their native history, and test this opt-in feature separately before relying on it. Automatic rotation must not be used to evade approvals or a user's stop instruction.

Member compaction is also off by default and uses DSH native services for an explicitly configured resident root/team. Provider control is disabled; the ordinary plugin does not rewrite provider credentials or global model defaults.

## Runtime state

On the new panel-only entry, state files are keyed by profile name and a panel marker under the official DSH Home path. Legacy roots also include a hash of their configured session ID. Release 0.8.0 deliberately does not import a previous user's package-local session-bindings.json or request-ledger.jsonl. For an existing installation, keep a private backup and reconnect explicitly; do not publish those files. Different profiles do not inherit each other's saved grants.
