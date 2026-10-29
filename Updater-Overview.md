# Updater Overview

Agreed target, October 18, 2026. Windows installation implementation started October 29; macOS packaging and public distribution remain pending.

This document records the update flow AFClip should support when it is ready for distribution. Use it when changing process ownership, runtime dependencies, storage, or project formats to identify changes that would make that flow harder to deliver.

Rapid development takes priority today. Temporary shortcuts are allowed; record what must replace them before distribution. Backward compatibility is not a development blocker. Jonathan will decide when to distribute after using AFClip locally and finding that it supports meaningful project work.

## Installation and release model

- Initially support macOS Apple Silicon and Windows x64. Defer Linux and other architectures.
- Ship a self-contained desktop app through a conventional downloaded installer. Users need no Git, Node, npm, terminal, or account to install or update it.
- Keep source-based development working separately from installed-app updates.
- After choosing a license and making the AFClip repository public, publish installers and update feeds in that same repository. License selection and making the repository public are deferred.
- Default to stable releases, published through an explicit promotion. Merging code alone must not ship stable updates.
- Offer an opt-in nightly channel for frequent builds.
- Include signing and macOS notarization in the eventual release pipeline. Credential setup is deferred.

The editor, library, engine, render workers, and bundled tools form one release and update together. Avoid independent component updates and the resulting interop version mismatches. Projects, source media, and library data live outside the replaceable application installation.

## Normal update flow

1. Discover updates and download them in the background.
2. Offer an explicit restart to install. Downloading an update does not authorize a restart.
3. Wait until affected exports, library operations, and other active work can stop safely. Coordinate every affected window and CLI operation using shared processes.
4. Stop the installation's processes and replace the complete application.
5. Restart with matching component versions and reopen the previous projects and windows.

Never reconnect a newly installed app to an old engine or library process. Restore the workspace without automatically rerunning interrupted jobs; offer to retry them instead. Apply the same coordination to downgrades.

## Formats and compatible releases

Project and library formats carry version identifiers. Check compatibility before modifying data. Each published release declares which project and library formats it supports.

Supporting older formats and writing conversion tools are optional. When the installed app cannot use a project, explain the incompatibility and offer a compatible app release. Recommend the newest published release compatible with both the project and its shared library. Keep published installers and compatibility metadata available for this purpose.

If no release supports both, explain the conflict without changing data. An older app that understands a project must not connect to an unsupported shared library or silently rewrite it into an older format. Offer switching releases where that resolves the conflict.

Switching to an older release replaces the whole installation. Maintain one installed version; defer side-by-side installations. Explain that switching can make other projects incompatible until the user switches back. Reopening those projects must respect the same compatibility checks.

After a deliberate downgrade, pin the selected release and pause automatic updates until the user chooses to resume them. Keep a manual update action available.

## Optional conversion

When AFClip offers a project conversion, include a "Keep original" checkbox, checked by default. If checked, convert a copy or retain a recoverable snapshot. The user may explicitly uncheck it.

Installing an older application does not reverse changes already made to project or library data. Do not present an application downgrade as a data rollback. No automatic library downgrade is promised.

## Failure behavior

A failed download or installation should preserve the current usable installation wherever possible. Report failures and offer retry and a manual installer link. Detect when a restart did not actually apply the requested release rather than reporting success.

Automatic rollback after the new application has modified data is out of scope. Recovery must respect the formats that the available app releases can read.

## Proposed implementation

Use `electron-builder` for packaging, `electron-updater` for installed-app updates, and GitHub Releases for hosting installers and update metadata. This is the stack found in T3 Code during the initial investigation; it is a proposed implementation, not a requirement to preserve a particular library forever.

T3's relevant references:

- [Release pipeline](https://github.com/pingdotgg/t3code/blob/main/docs/operations/release.md)
- [Desktop updater](https://github.com/pingdotgg/t3code/blob/main/apps/desktop/src/updates/DesktopUpdates.ts)

AFClip intentionally differs from the inspected T3 behavior by targeting automatic background downloads followed by an explicit installation action. Do not copy T3's download policy accidentally.

Exact polling intervals, release metadata schema, signing configuration, and installer mechanics remain implementation choices.

## Current gaps to address before distribution

Windows now has a self-contained NSIS build, packaged launch paths, bundled Node and media tools, a prebuilt native encoder, first-launch New/Open dialogs, release-aware service connections, coordinated update shutdown, and format compatibility metadata. The manually dispatched workflow retains private artifacts by default. Apple Silicon now has self-contained DMG/ZIP builds, Applications-folder installation, bundled terminal commands and software export defaults. See [README](README.md) for build commands and [macOS installation](docs/macos-installation.md) for platform details.

Before public distribution:

- Complete native Windows installer/update acceptance on a clean user profile, including active work and failed replacement.
- Complete Mac Developer ID signing, notarization and clean-profile Gatekeeper acceptance. Local Mac builds use ad-hoc signing.
- Set up signing credentials, choose the license, and make the repository public before publishing installers/update feeds.
- Add compatible-release discovery and selection for project/library format conflicts. Current checks reject unsupported formats; they do not yet recommend a specific compatible installer.
- Verify downgrade pinning and workspace restoration on both platforms. Conversion remains optional and is not implemented.

## Check future changes against this flow

When a change touches these areas, ask:

- Does it add a dependency on tools installed globally, a compiler, or paths inside a source checkout? Record how the installed app will supply or replace it.
- Does it add a process that can outlive the GUI or serve multiple clients? Preserve a way to identify its release, detect active work, and coordinate its restart.
- Does it store user data inside the application directory? Keep that data outside the directory replaced during updates.
- Does it change a persistent format? Give it an identifiable format version and reject unsupported data before writing. Supporting the previous format is optional.
- Does it convert data? Preserve the user's choice to keep the original and avoid implying that installing an older app reverses conversion.
- Does it introduce separately updated components? Keep the complete installation on one release or revisit this agreed design explicitly.
- Does it remove older installers or compatibility metadata? Preserve the ability to find and install compatible releases.
- Does it automatically restart, reconnect to an arbitrary existing backend, or resume jobs? Preserve explicit installation, matching process versions, and user-controlled job retries.

## Implementation starting point

Validate a real installed version updating to a second release on Windows first. Include the backend restart and reopening the same project in that first working path, then extend it to the other platform and release channels.

Use practical checks for update, downgrade, incompatible data, active work, and installation failure as the implementation develops. This is implementation guidance, not a feature-completeness gate or a requirement for a broad automated test suite.
