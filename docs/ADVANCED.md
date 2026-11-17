# Advanced configuration

The normal bundle installs one host and one settings client. Its default config is port 19491, member compaction off, provider control off. No legacy session or project is required. Static legacy configuration may specify sessionId and an absolute workspace together; leave both empty for panel-only binding. sessionBindings can contain at most eight additional explicit objects with session_id, expected_title and workspace. Each additional binding needs an absolute workspace unless a legacy workspace was explicitly configured as its fallback. The title is display metadata, not routing authority.

## Optional rotation entry

`dsh-codex-bridge/rotation` preserves the pre-existing experimental layer-rotation APIs. It is **not enabled by the one-click bundle**. Do not load it alongside the ordinary host on the same port or register two settings services. It requires an explicit legacy sessionId, workspace and rotationLayers, DSH workspace/session control APIs, and separately authorized creation and handoff of sessions. It may create handoff files inside the configured project, preserve native model selection, and stop/rotate at its configured-in-code step bounds (soft trigger 650, hard guard before step 691, rotation ceiling 700). It is not part of the ordinary connection UI.

Its rotationLayers require explicit layer/sourceSessionId/prefix/handoffFile configuration. Prefixes currently supported by that experimental implementation are 调研层使用 and 执行层使用. No IDs or layer config are supplied with this release. Existing users should review their settings, keep their native history, and test this opt-in feature separately before relying on it. Automatic rotation must not be used to evade approvals or a user's stop instruction.

Member compaction is also off by default and uses DSH native services for an explicitly configured resident root/team. Provider control is disabled; the ordinary plugin does not rewrite provider credentials or global model defaults.

## Runtime state

On the new panel-only entry, state files are keyed by profile name and a panel marker under the official DSH Home path. Legacy roots also include a hash of their configured session ID. Release 0.8.0 deliberately does not import a previous user's package-local session-bindings.json or request-ledger.jsonl. For an existing installation, keep a private backup and reconnect explicitly; do not publish those files. Different profiles do not inherit each other's saved grants.

## Rotation permission choice (2026-11-14)
Rotation no longer requires Auto. A new request defaults to `permission_mode: "native"`, keeping the permission preset assigned by native session creation, regardless of the source session. Only explicit `permission_mode: "follow"` inherits the source session's preset, sandbox and approval policy. No source or global permission is changed.

To choose another existing native preset for the new session, explicitly pass `permission_mode: "explicit"` and `permission_preset: "<native preset id>"`. The caller must have the user's authorization for that choice. The bridge validates the native catalog and uses the existing audited, revision-checked native setter. It does not disable automatic review or cc-safety-net independently of that chosen preset.

Legacy `initialize_new_auto: true` remains an explicit Auto request for compatibility; it cannot be combined with the new options. Saved transactions retain their selected permission and commit checks it has not changed. Existing running hosts need normal plugin reload before this code is active; updating files alone does not hot-reload ESM modules. No live sessions are created by the tests.
For automatic rotation, each `rotationLayers` entry optionally accepts `permissionMode: native` (default, retain new-session settings), `permissionMode: follow`, or `permissionMode: explicit` with `permissionPreset: <native preset id>`. This setting applies only to that layer’s next newly prepared rotation; it never rewrites a saved transaction or a running source session. Configure an explicit mode only with user approval.

## Explicit session continuation

The optional rotation entry also honors an existing user-controlled policy at `tools/dsh-session-continuation-20261117-r1/POLICY.json` within its configured workspace. The policy is private runtime state and is never included in the repository or installation archive. No project or session is opted in by installation.

A policy has schema `dsh-user-session-continuation/1`, `enabled: true`, an absolute `workspace` matching this entry's workspace, an explicit `session_ids` list, and `native_permissions_review_SafetyNet_and_compaction_unchanged: true`. Only those exact IDs continue without the bridge's cumulative 650-step automatic rotation and 690-step pre-model guard. These are model steps, not training iterations. Missing, invalid, disabled or mismatched policies retain the existing bridge limits.

Continuation calls the downstream native step handler normally, including its rejection path. It does not change permission presets, native review, SafetyNet, model settings or native compaction; it does not replay, delete or unfreeze saved pending inputs. Removing an ID or disabling the policy restores bridge admission checks. The combined rotation entry retains the independent empty-session creation API described in [API.md](API.md).
