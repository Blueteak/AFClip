# Content Library Overview

This is the agreed design for a standalone, local content library for video and audio. It supports choosing footage for Reelet and finding sound effects for game development. It must remain useful without Reelet installed.

This document owns library behavior and its integration contract. The [Reelet MVP](Reelet-MVP-Overview.md) and [technical overview](Reelet-Technical-Overview.md) own editing behavior and project architecture. This is planned work, not a description of an implemented library.

## Applications and ownership

Keep both applications in this repository. Each has its own GUI, CLI, authoritative state, operations and history. Share media processing and useful UI components as real workflows need them. Do not build a general application framework before delivering the first workflow.

Every library GUI action has a CLI equivalent, including inspection, organization, annotation, history and background-job control. External agents use that CLI. The library contains no embedded AI provider, credentials or autonomous annotation pipeline.

The first release is single-user and local-first, with concurrent human GUI and agent CLI access. Target Windows first while keeping portable boundaries. Use one active catalog with a stable library identity and media locations across multiple roots or drives.

| Data or action | Owner |
| --- | --- |
| Asset identity, source versions and known file locations | Content Library |
| Asset names, tags, notes and reusable named ranges | Content Library |
| Nested library folders, collections and tag vocabulary | Content Library |
| Reusable source metadata, thumbnails, waveforms, indexes and suitable seek proxies | Content Library |
| Project bin membership and temporary editorial In/Out selection | Reelet |
| Timeline instances, cut points, effects, mixing and project settings | Reelet |
| Timeline compositions, mixed audio and exports | Reelet |
| Decoding, playback and artifact-generation implementation | Shared code, with jobs and cache lifecycle controlled by the owning application |

Reelet cannot author library annotations or organization. Its narrow write permissions are source registration and Inbox reference/lifetime operations. "Edit in library" opens the standalone library at the selected asset or range.

## Assets, originals and source versions

Initially support video and standalone audio. Whole-file SFX are first-class assets; an asset never needs a range to be useful. Images, graphics templates and other media types remain outside library scope for now.

An asset has a stable logical identity, a current source version, known locations, a name, tags and one freeform notes field. A source version identifies particular media bytes and carries technical metadata. Keep locations separate from identity so moving a file does not destroy its annotations.

Recognize exact duplicates and relocated files using verified content identity. Hash in the background so registration can return promptly with identity verification pending. Paths, size and modification time may help detect changes but are not authoritative content identity. When duplicate verification finishes, resolve provisional registrations to a stable identity without dropping project references or annotations.

The library references existing files. It never deletes original media files, including during catalog deletion, undo, cleanup or cache eviction. It also does not implicitly move or rename originals. Managed-copy import is deferred.

A re-encode or any changed bytes represent a different source version. If a file is overwritten, preserve the old version record and annotation history, and show that its bytes may no longer be available. Catalog history is not a backup of media files.

Offer an explicit action to accept replacement media under the same logical asset and clear its active annotations. This resets tags, notes and ranges while preserving folder placement and retaining old state in history. Existing Reelet clips remain pinned to their old source version until explicitly relinked. Undo can restore metadata, but cannot restore overwritten bytes.

Missing files remain searchable with an unavailable status. Removing an asset from the catalog is recoverable and leaves files and existing Reelet project snapshots intact. Expose permanent catalog purge as a separate explicit operation. Propagate deleted-library status to consumers.

Optional watched source folders discover new files while the library is running. Provide explicit import and rescan commands as well. Source-folder mappings can place discoveries into logical library folders. Missing paths or disconnected drives never erase annotations.

## Folders, collections and import

Use nested logical folders that the CLI can browse and address. They need not mirror the filesystem. One catalog can hold footage for several games in separate folders and a shared SFX library across them.

Each permanent asset has one home folder; ranges belong beneath their asset. Directory import can seed a matching logical folder hierarchy. Named collections reference assets or ranges across folders, with multiple collection memberships allowed. Deleting a collection does not delete its contents. Smart collections are deferred.

Direct GUI drag-and-drop or CLI import into the library creates permanent items without passing through Inbox. Dropping onto a folder imports there; otherwise use the library root. Re-importing an existing asset reuses its identity without overwriting annotations or folder placement.

Reelet registration uses Inbox for new assets unless a source-folder mapping places them in the permanent library. Existing library assets retain their current placement.

## Inbox lifetime

Inbox is a temporary intake queue. It supports preview, technical metadata inspection and temporary analysis artifacts. Tags, notes and range annotations are forbidden there through both GUI and CLI. Promote an item into a real library folder before annotating it.

Promotion makes the asset permanent, independent of Reelet references. There is no ordinary move from the main library back into Inbox. Undoing promotion can restore the prior state through history.

| Event | Result |
| --- | --- |
| Reelet imports a new video/audio asset into its project bin | Register the asset and retain a durable reference for that project |
| Another project imports the same asset | Reuse its identity and add that project's reference |
| A timeline instance is deleted | No change to project-bin reference or Inbox lifetime |
| A project closes, its engine exits, or its path is unavailable | Keep the reference |
| The asset is removed from a project bin | Withdraw that project's reference |
| The last project-bin reference is withdrawn from an unpromoted item | Recoverably remove it from Inbox browsing, leaving its file untouched |
| Reelet undoes that removal | Restore the same asset identity and recoverable Inbox record |
| An item is promoted before the last reference is withdrawn | Keep the permanent asset |

Key durable references by stable project identity. They are not process leases and do not expire because a project or drive is temporarily missing. Provide manual inspection and cleanup for abandoned references.

Registration and project insertion remain separate transactions. Make their coordination durable, idempotent and retryable. Failed or cancelled project insertion must reconcile any tentative Inbox reference; it must not roll back permanent library assets. Repeated import, withdrawal or undo requests must not create duplicate records or references.

The library checks whether an item is still in Inbox when a withdrawal executes. This prevents a delayed Reelet operation from deleting an asset that the user has since promoted. This narrow lifecycle coordination does not merge the two applications' undo histories.

## Annotation and Tag Manager

Assets and optional ranges share a small annotation model: name, compact tags and one freeform notes field. Notes provide context for agents and humans, such as what happened in a take or why a sound is useful. Do not introduce a general custom-field schema in the first version.

Ranges have stable IDs and may overlap. They need not divide the whole asset into a canonical segmentation. Most SFX may have no ranges at all. Range inspection includes parent asset context while distinguishing inherited context from the range's own tags and notes.

Store boundaries in source-native time, independent of Reelet project settings. Preserve exact source frames and presentation timestamps for video, including variable-frame-rate media, and sample-accurate audio boundaries. Project frame-rate changes never rewrite library ranges.

Tag Manager owns the vocabulary. Assets and ranges can only receive tags defined there. Offer editable starter tags such as high-energy, low-energy, impact, ambience, dialogue, music, gameplay and cinematic. No mandatory tagging checklist or arbitrary per-item tag cap is needed.

Support explicit tag rename and merge operations. Deleting an in-use tag requires confirmation and clears its assignments everywhere. The CLI provides an equivalent explicit confirmation. Deletion is undoable; it does not leave retired tags attached to content.

Humans and agents have equal editing authority. Record author type as human or agent, with timestamps, ordering and revisions needed for history. Do not require author accounts, agent IDs, batch descriptions or a review queue. Author type does not protect human annotations from agent edits.

## Operations, concurrency and history

Run a headless library service that starts automatically when the GUI, CLI or Reelet needs it. Communicate through versioned local operation contracts and structured responses. Neither application reads or writes the other's database internals.

GUI and CLI invoke the same validated operations. Publish coherent batches atomically and check revisions of affected objects and relationships. Reject an entire stale conflicting batch with actionable details. Unrelated changes should not invalidate otherwise valid work; retry policy belongs to the agent or caller.

Library GUI and CLI share a library undo history. Keep it separate from Reelet project undo and checkpoints. Use bounded undo and checkpoint conventions consistent with Reelet, without adding an account-based audit system. Original media bytes remain outside rollback.

The contract must cover registration and identity resolution; project reference retention and withdrawal; browsing and search; source/range inspection; annotation and organization; tag management; history; artifact requests and jobs; and change subscriptions. Select concrete command names and storage layout during implementation rather than treating this overview as an already available CLI specification.

Consumers receive committed metadata and availability changes. Reconnecting consumers must be able to resynchronize after missed events. Return stable library, asset, source-version and range identities, revision information, exact times and processing status in structured CLI results.

## Reelet integration

Every video/audio item in Reelet's project bin has a library identity. Existing Reelet images and graphics stay project-owned until library support expands to those types. Reelet's local import action invokes library registration, so users do not need to open a second GUI merely to import footage.

Provide a read-only library browser in Reelet with folder navigation, search, preview and asset/range insertion. Reelet can create a temporary editorial In/Out selection, but saving a reusable named range or changing library notes requires the library application or CLI.

Metadata changes appear live in Reelet. Inserting a named range uses its current source version and boundaries. A later range edit never changes existing timeline cuts; an existing use can indicate that its library range has changed. Reelet adapts placement and duration to its project grid without rewriting the source-native library boundary.

Persist source-version identity, selected source timing, usable source locations and library provenance in the project. Existing edits must play and export without the library service when their original bytes remain available. Regenerate missing disposable artifacts or fall back to original decoding. Library availability may limit new browsing/import operations, but cannot become a requirement for rendering an existing edit.

Project settings, effects, clip timing and exports have no authority over library data. Collect project may copy required media as a Reelet portability operation; it does not transfer ownership of reusable annotations or permit the library to modify original files.

## Artifacts and background work

Share existing playback, decoding, indexing, waveform and proxy implementation where practical. The library owns reusable source-derived artifacts; Reelet owns project-specific output. Extract code as these workflows need it instead of moving the entire rendering pipeline up front.

Generate cheap browsing data in the background after registration. Request expensive inspection frames, contact sheets, bounded audio/video excerpts and suitable seek proxies on demand. Keep lightweight inspection artifacts reusable so an agent does not repeatedly regenerate the same source evidence.

Provide a "prepare for review" operation for selected assets or folders through GUI and CLI. Report progress, errors and cancellation. Browsing, annotation and project editing do not wait for preparation to finish. Background failures must not lose catalog changes.

Use a configurable disk budget for disposable library artifacts. Protect active readers and evict unused entries. Keep identities, annotations and history outside that budget. Expose cache usage, clearing and job controls through both interfaces. Cache keys include verified source version and relevant generation settings; metadata-only edits should not regenerate source pictures or waveforms.

The library has no permanent trimmed/transcoded export feature. Temporary analysis excerpts are permitted and remain disposable artifacts, not new catalog assets or user exports.

Native drag-out hands another application the original file, as a convenience over revealing it in Explorer. A compatible application such as Reelet also receives structured asset, source-version and range data. A generic destination receives the whole original file even when the user drags a range. Use copy/reference behavior that does not remove or move originals. Validate this with another Windows application.

## Search and responsiveness

Start with folder, media type, duration and tag filters plus keyword search across names and notes. Defer embeddings and semantic ranking. Search assets and ranges without requiring artificial full-length range records.

Target a catalog of 100,000 assets and up to one million ranges. Aim for 50 ms from input or query submission to the first useful results on the development machine. A spinner or request acknowledgement does not satisfy that target. These are acceptance targets, not measured achievements.

Allow asynchronous retrieval and incremental results. Clearly indicate incomplete results, paginate large sets and supersede stale work when the query changes. Do not present an incomplete empty result as an exhaustive answer. The CLI exposes pagination and completion status as well as identities, source times and parent context.

Measure warm and cold queries separately. Record catalog size, query, hardware and background workload. Scanning, hashing and artifact preparation are separate visible background costs, not reasons to block the catalog interface. Measure them too so preparation cost does not disappear behind the responsiveness target.

Reuse Reelet's measured playback and seeking work, but validate library preview independently. Existing editor measurements do not prove that a large catalog or uncached source meets those targets.

## Delivery order

Build an audio/SFX tracer bullet first: import a file, preview it, place it in a folder, annotate it, find it and drag its original into another application. Exercise the same flow through CLI with the GUI closed, then verify the GUI reflects CLI edits.

Include Reelet registration, Inbox promotion, reference withdrawal and undo in that first integration path. This proves the application boundary before expanding annotation tools. Deliver usable whole-file audio selection without waiting for video range tooling.

Next add video preview and optional range annotation, exact source timing, range search and Reelet insertion. Reuse the shared media pipeline as needed. Video and audio are both part of the agreed scope; the order is an implementation sequence.

Defer multi-user collaboration, cloud sync, additional asset types, smart collections, semantic search, custom annotation schemas, managed-copy imports and modified-media exports. Defer non-Windows packaging and validation while preserving portable interfaces.

### Manual acceptance checks

- Direct GUI/CLI imports create permanent assets; Reelet imports create Inbox items where appropriate. Inbox rejects annotations until promotion.
- Two projects share an asset. Removing one bin reference retains it; removing the last removes an unpromoted item. Undo restores its identity. Closing a project does neither.
- Promotion racing with withdrawal preserves the permanent item. Failed imports and retried commands leave no duplicate or abandoned tentative references.
- Exact duplicates and relocated sources retain identity and annotations. Missing files remain searchable. Replacement clears active annotations only through the explicit action and leaves existing edits pinned to their prior version.
- An in-use tag deletion confirms, clears assignments and can be undone. Concurrent conflicting batches reject atomically while unrelated edits proceed.
- Library range edits update Reelet browsing without moving existing cuts. Video frame boundaries and audio sample boundaries survive insertion into projects with different frame rates.
- An existing Reelet edit plays and exports with the library service unavailable and originals present.
- Cancel preparation, clear eligible caches and evict unused artifacts without losing annotations or breaking active readers. No operation deletes original media.
- Measure first useful search results and completion at the target catalog scale. Check query replacement, pagination and incomplete-result status.
- Drag an asset or range to a generic Windows application and verify it receives the original file. Verify compatible Reelet insertion also receives the selected range context.

Use lightweight manual verification for each delivered tracer bullet; add automated coverage only where a failure warrants it.
