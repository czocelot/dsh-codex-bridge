# Development and release preparation

This guide is for maintainers. Installation, binding and everyday use are documented in the [English](../README.md) and [Chinese](../README.zh.md) user guides.

## Source layout

| Path | Purpose |
| --- | --- |
| `lib/index.js` | Ordinary host entry and local HTTP listener |
| `lib/client-lazy-r3.js` | DSH settings client |
| `lib/*control*.js`, `lib/*persistence*.js` | Session routing, permission confirmation and private state |
| `lib/index-session-continuation-r1.js` | Separate, opt-in experimental rotation entry |
| `cordis.patch.yml` | Default DSH bundle layer |
| `dsh-plugin.json`, `package.json` | Plugin entries, package exports and bundle metadata |
| `test/` | Deterministic Node.js fixtures |

The distributed JavaScript is ready to load; there is no compilation step or install lifecycle script. Tests use local fixtures and do not require a live DSH profile or model credentials.

## Local checks and packaging

Use Node.js 22 or newer. From the repository root:

```sh
npm test
npm pack --ignore-scripts
```

`npm pack` creates a local tarball. These commands do not publish or install into DSH. Do not run `npm publish` or push a remote as part of validation.

Inspect the actual archive after packing: compare every member with the source, scan its full contents, and record its SHA-256. `package.json.files` controls inclusion; `.gitignore` alone does not guarantee a clean tarball. Keep release audit tooling and its receipts outside the source repository and package. Check known local identifiers as well as credential patterns; do not record private values in logs or commits.

Keep DSH profiles, bindings, request ledgers, permission audits, credentials, generated verification profiles and test logs outside the repository. Current runtime state is stored through DSH's home-path API in `plugin-data/dsh-codex-bridge/`; see [advanced settings](ADVANCED.md) and [security](../SECURITY.md).

## Host compatibility

The prepared release targets DSH Desktop 0.2.2-rc.1 with host modules 0.1.7-rc.1. The ordinary host dynamically imports the host-supplied `@deepseek-ai/dsh-typert-protocol` and `@deepseek-ai/dsh-home-paths`. Both are optional peer dependencies so local packing and fixture tests do not install a second host. They are still required when DSH loads the plugin. Other host versions require separate validation.

The settings RPC namespace is `codexBridgeConnection`. Its methods, HTTP contract and confirmation requirements are described in [API.md](API.md). Client and host entry points must stay aligned across package exports and the plugin manifest.

## DSH installation contract

`package.json` declares `dsh.bundle.patch: "./cordis.patch.yml"`. That patch inserts the `dsh-codex-bridge` host with the listener on port 19491, member compaction off and provider control off. It supplies no session ID, project directory or existing grants. Experimental rotation is not part of this bundle.

The package declares a bundle; DSH owns installation, enablement and restart handling. The native guided flow offers enablement after installation. A patch row with `disabled: false` does not itself prove that a newly installed bundle is enabled in the running profile.

Upstream references: [bundle format and distribution](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md), [guided installation flow](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-09-15-guided-plugin-installation.md). These links track upstream; the local test receipts describe the exact host and archive checked.

For native installation verification, use a fresh disposable DSH Home/profile and offline package management with install scripts disabled. Check bundle selection, parsed patch, host compatibility, enablement and the restart-required result separately. Then load the installed host through DSH's boot lifecycle with fixture services, check settings registration, an empty binding list, unbound-request rejection, and listener disposal. Never use an existing profile for this check.

The local release review directory, outside this repository, retains the installation/runtime reproducers and receipts. They require `DSH_SOURCE_ROOT` (a built DSH tree), `BRIDGE_HOST_PACKAGE_ANCHOR` (an anchor resolving the host SDK), and `DSH_PNPM_ENTRY` (pnpm's JavaScript entry). Run `install-verify.mjs` in a fresh verification directory, followed by `runtime-verify.mjs`. They do not replace visual testing of the DSH settings UI or validation on another machine. See [VALIDATION.md](VALIDATION.md) for evidence limits.

## License

Retain the [MIT license](../LICENSE) and [third-party notices](../THIRD_PARTY_NOTICES.md) in source and release archives.

## Preparing an updated release

Do not rerun a prior release's one-off push, history rewrite or upload script. Its pinned commit, file count, source inventory and archive hash describe that earlier release. Keep new audit tooling and receipts in a private review directory outside this repository.

Merge reviewed behavior from local runtime repairs without copying profile data, policy contents, bindings, request ledgers or diagnostic paths. Compare the default and optional package exports with the plugin manifest. Run deterministic tests, build a fresh tarball with install scripts disabled, compare every archive member with the reviewed source, and scan source, actual archive bytes, reachable Git contents and metadata for private identifiers. Audit regular tests as public source too; use synthetic projects, sessions and policy fixtures.

Bind the release plan to the current base commit, the complete proposed source file set and SHA-256 hashes, and the exact tarball and checksum file. Recheck all hashes and the remote before a separately authorized normal push. Any file change invalidates the plan and requires a new review; old installation receipts never validate a new archive. Existing public tags/assets remain unchanged until an explicitly authorized new release is ready.
