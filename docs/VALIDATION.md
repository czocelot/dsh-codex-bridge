# Release validation

Release 0.8.0 uses local package checks and isolated native-host validation. Verification uses disposable profiles rather than an existing user profile. Release receipts identify the exact archive and installation source checked.

- 37 Node test-runner regressions passed, covering multi-project routing, request/result isolation, cold-session connection, tombstones, permission preservation, first-run config and loopback guards.
- All 19 shipped JavaScript modules passed syntax checks. Package metadata and internal import targets were checked.
- The packed tarball was installed through the real DSH PluginManager.installBundle service into a fresh isolated profile, with offline package management and install scripts disabled. Package installation returned exit 0, selected the bundle and parsed its patch. That startup-only fixture reported restart-required, as expected.
- The guided flow installs with enablement deferred, then offers a separate enable action. The local verification covers tarball inspection, installation with `enabled: false`, and explicit bundle enablement; an install call with its default options alone does not exercise this flow.
- The installed plugin was then loaded through DSH's official boot lifecycle with isolated native-service fixtures. Settings RPC registration, first-run local listener, empty bindings, unbound-request rejection and listener disposal passed. No real model task, permission change or live-profile edit occurred.
- The release archive was checked separately for private user paths, production session IDs, credentials and runtime state files.

Local verification receipts and archive inventories are kept outside the public source repository. They identify the checked tarball by SHA-256. Documentation changes also change that hash: earlier receipts must not be presented as evidence for a rebuilt archive. Maintainer commands and the verification setup are in [DEVELOPMENT.md](DEVELOPMENT.md).

Not performed: screen-control testing of the live DSH settings UI; a friend's physical machine; a real paid model request; experimental automatic rotation and handoff against live sessions. The ordinary connection/request logic is covered by deterministic fixtures. Published compatibility claims are limited to the tested DSH interfaces in the README.
