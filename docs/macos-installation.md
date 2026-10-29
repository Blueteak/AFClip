# macOS installation

Apple Silicon only. Open the DMG, drag AFClip to Applications, then open it. Opening AFClip directly from the DMG also offers **Install** and relaunches from Applications. Choose **New project**, **Open project**, or **Content Library**. New projects default to 1080p60 and a unique Untitled folder in Movies/AFClip Projects. No AFClip account, terminal, Homebrew, or separate runtime is required.

Allow macOS folder access when opening projects or media in Documents, Desktop or Downloads. Until that permission is answered, macOS can hold file reads and preview preparation.

The app bundles Node, Electron, FFmpeg and native arm64 ffprobe. Preview uses GPU acceleration; exports default to software. Existing agent tools and their credentials are optional. Finder launches search common user and Homebrew command locations.

**Window > Content Library** opens the standalone library. **Help > Updates** controls release updates. Private development builds disable automatic checks.

## Terminal commands

First launch from Applications registers `af-clip` and `af-lib` in `~/.local/bin`. Existing commands are preserved. **Help > Install terminal commands…** retries registration. Shell users need that directory on PATH; agents launched by AFClip receive bundled runtime paths automatically. Apple's `/usr/bin/afclip` is untouched.

## Build

On Apple Silicon with Node 24 or newer:

```sh
npm ci
npm run dist:mac
```

Output: `dist/AFClip-<version>-macos-arm64.dmg` and `.zip`. The ZIP supports future updater distribution. `npm run pack:mac` builds only the app bundle. The manually dispatched **macOS installer** workflow retains private artifacts. Its `macos-15` runner uses [Apple Silicon](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

Local builds use an ad-hoc signature. Downloaded builds are not ready for frictionless Gatekeeper installation on other Macs. Public distribution requires a Developer ID Application certificate, hardened runtime, notarization and stapling. Set `AFCLIP_RELEASE_UPDATES=1` only for signed release preparation; `electron-builder.cjs` then requires signing and enables notarization. Supply `CSC_LINK` / `CSC_KEY_PASSWORD` and Apple's notarization credentials through CI secrets. The current private-artifact workflow deliberately does not publish releases. License and public release hosting remain undecided.

## Data and replacement

Projects and original media remain in their chosen locations. Existing catalogs and agent data remain under `~/.local/share/AFClip`; explicit `AFCLIP_LIBRARY_HOME` and `AFCLIP_AGENT_HOME` overrides are preserved. Preferences, installed process registration and updater state use `~/Library/Application Support/AFClip`. Removing the app preserves user data.

Installed services advertise their release identity. Close development services before opening the same project/catalog with an installed app. Updates wait for active work, close registered processes and restore windows; interrupted jobs are not retried automatically. See the reviewed [updater contract](../Updater-Overview.md).

## Distribution checks still needed

- Developer ID signing, notarization, stapling and a clean-profile downloaded-DMG launch.
- A signed release updating to a second release, including active work, failed replacement, workspace restoration and downgrade pinning.
- Compatible-release recommendations for unsupported project/library formats. Current checks reject unsupported formats before writes.

Keep these checks manual. Record build-specific results in commit messages.
