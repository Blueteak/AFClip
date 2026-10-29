# macOS installation handoff

Build and review the Apple Silicon installer using the Windows packaging implementation. Deliver a self-contained, signed and notarized DMG that opens without a terminal, Node installation, or AFClip account. Preserve the reviewed [updater contract](../Updater-Overview.md), [technical architecture](../AFClip-Technical-Overview.md), and [library ownership](../content-library-overview.md).

## Shared implementation to review

- `src/shared/runtime.cjs` resolves installed Node, Electron roles and release identity. A packaged app has `resources/app/release.json`; a checkout does not. The Mac paths already describe `Contents/Resources/runtime/node` and `Contents/MacOS/AFClip`, but require validation in a real bundle.
- `src/desktop/main.cjs` routes editor, library, render, preview and credential-worker launches. Preserve the normalized `process.argv` contract used by existing workers. Node services remain independent of Electron.
- `src/desktop/projects.cjs` reuses native dialogs for New/Open. New projects default to 1080p60, with a prefilled name and location. Cancelling returns to the choice; subsequent launches reopen the last project. Getting started remains in Help rather than opening automatically.
- `src/shared/lifecycle.cjs` registers installed processes and blocks new work during replacement. Services advertise release/build/installation identity; clients reject mismatches. Never attach the new app to a checkout's service.
- `src/desktop/updates.cjs` downloads in the background and requires an explicit restart action. It waits for active operations, stops registered processes, retains window locations, and restores them using new endpoints. Interrupted jobs are not automatically retried. A detected downgrade pins automatic updates until resumed.
- `src/library/store.ts` checks `PRAGMA user_version` before writable access. Version 0 is the existing catalog format, adopted as version 1. Project format remains 1. `release.json` declares both supported formats.
- `electron-builder.cjs`, `scripts/prepare-release.cjs`, `packaging/installer.nsh` and `.github/workflows/windows-installer.yml` implement Windows x64 packaging. The prepare script currently rejects other platforms intentionally.

## Build the Mac package

1. Add a platform argument or a Mac preparation path. Bundle the pinned Node version from `scripts/prepare-release.cjs`, using the official darwin-arm64 archive and SHA-256 verification. Include its license. Never depend on Homebrew or the user's shell PATH at runtime.
2. Add arm64 `dmg` and `zip` targets. The ZIP is needed by the Mac updater. Build an `.icns` from the existing icon. Keep the stable bundle identity `com.afclip.desktop`; separate development launchers remain unchanged.
3. Adapt the `afterPack` manifest copy to `AFClip.app/Contents/Resources/app/release.json`. Inspect the final DMG/ZIP contents; a missing manifest makes installed code follow development launch paths. Audit the builder file filters. Windows currently excludes `ffprobe-static/bin/darwin`; Mac must include the native `@ffprobe-installer/darwin-arm64/ffprobe` selected by `src/shared/ffprobe.cjs`, plus arm64 `ffmpeg-static`. Do not include the Windows encoder or invoke its compiler.
4. Sign all executable helpers, including Node, FFmpeg, ffprobe and provider SDK native dependencies. Configure hardened-runtime entitlements appropriate to Electron and the bundled Node runtime. Notarize and staple the app/DMG. Request credentials through the available secret tool when needed; do not put credentials in prompts, files tracked by Git, or logs.
5. Handle opening directly from the mounted DMG with Electron's Applications-folder installation support. Move and relaunch before starting services or registering a process. Prevent multiple copies from sharing an installed-release identity.
6. Provide `af-clip` and `af-lib` wrappers that resolve the app's bundled Node. Keep Apple's `/usr/bin/afclip` untouched. Use a user-writable command directory and expose registration/repair in existing settings or menus. Embedded agents already receive absolute bundled paths and must work without terminal registration.
7. Keep the standalone Content Library accessible without opening an editor project. Decide its Finder-launch mechanism using the existing app and role router, with one replaceable release for every component.
8. Add a manually dispatched macOS build workflow. Default to retained build artifacts. Publishing requires the agreed license/public-repository decision and signing setup. Publish matching Mac and Windows release assets together; do not make every merge a stable release.

## Mac behavior that needs special attention

- Finder does not inherit terminal PATH. Discover existing provider executables without making provider installation or login a prerequisite for editing.
- Existing development catalogs and conversations use `~/.local/share/AFClip`; installed lifecycle/update state uses `~/Library/Application Support/AFClip`. Avoid silently abandoning existing user data. Preserve explicit `AFCLIP_LIBRARY_HOME` and `AFCLIP_AGENT_HOME` overrides.
- Electron's editor and credential worker must use the same userData location for OS-encrypted ElevenLabs credentials. Library window profiles remain separate.
- Hardware export is currently Windows D3D11/NVENC only. Use software export on Mac while preserving native accelerated preview. Do not promise Mac GPU encoding based on preview support.
- Review update ownership across multiple editor windows and standalone library sessions. A closing update-owner window must not leave updates permanently unavailable in another window.
- Retained-release selection and recommending an installer compatible with both project and catalog are still future updater work. The current implementation rejects incompatible formats and provides the releases link; it does not implement conversion or data rollback.

## Practical acceptance pass

Use a disposable macOS user profile with no development tools on PATH. Install the downloaded DMG, create a project through the first-launch dialog, import local video/audio, edit and export. Launch the library independently. Run both bundled CLIs with the GUI closed. Reopen the project and verify GUI/CLI edits share the same engine.

Install a second version from a local update feed, using `AFCLIP_UPDATE_FEED` only for that validation. The override accepts HTTPS or HTTP on localhost. Check background download, Later, explicit restart, active export/library/agent work, multiple windows, failed download, failed installation, and workspace restoration. Compare service release identities after reopening. Never automatically resume interrupted agent or generation work.

Try reinstalling and downgrading through a downloaded installer. Confirm user data survives, unsupported project/library formats are rejected before writes, and deliberate downgrade pauses automatic updates. Remove the app and confirm original media, projects and catalog annotations remain intact.

Use manual checks. Do not introduce a permanent test suite. Record the actual OS, architecture, artifact path, signing/notarization result and completed checks in the final commit message. Update this handoff with remaining platform-specific work, or remove it when the Mac implementation replaces it.
