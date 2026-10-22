# AFClip MVP Overview

AFClip is a video editor for making game trailers and marketing videos from supplied footage, music, sound effects, text and images. Humans and agents can take over the same project at any stage. The GUI and headless CLI are equally important interfaces.

This is the agreed MVP scope, consolidated from the design discussion. It describes intended behavior, not implementation status.

## Human and agent collaboration

- Support both agent rough cuts followed by manual refinement and human rough cuts followed by agent refinement.
- Agent passes may be substantial. Changes must stay within the requested scope unless explicitly expanded.
- Agents choose whether to reuse existing tracks or create new ones. Preserve useful organization and give new tracks clear names.
- Every project action must be available through the CLI. Gesture-driven actions have explicit command equivalents, such as stretching to a duration or creating a transition.
- GUI and CLI invoke the same underlying operations. CLI inspection returns structured results with stable identifiers for clips, tracks and markers, plus Content Library identities for referenced assets and named selects.
- The CLI can edit, run and render with the GUI closed. When open, the GUI reflects CLI changes live without reloading.

### Concurrent edits

Agent passes publish coherent, atomic batches. Check each batch against changes made since the agent read the project. Reject the entire conflicting batch without silently overwriting edits; previously accepted batches remain applied. Changes to unrelated material can proceed, and manual editing remains available.

Show a brief conflict status in the GUI and actionable details through the CLI. The agent decides whether to reread and retry or ask the user about conflicting intentions. Retry policy belongs to the agent, not the app.

### Local agent conversations

Use installed Codex and Claude Code with their existing sign-ins; no AFClip account. Agents retain their native tools and permission rules and edit through the ordinary CLI. Settings holds per-provider executable, model, thinking and access defaults, captured when a conversation starts. Provider stays fixed; the steer/queue preference applies to each subsequent message.

Conversations appear as circular widgets with shadows, attached to timeline items, tracks or empty timeline positions. `A` opens the hovered item's discussion, using a containing multi-selection; outside the timeline it uses the selection or project. Annotation-style popups contain the transcript, composer, pasted-image previews and native questions/approvals. Selection and playhead are captured on submission as context, never an editing restriction.

Allow concurrent conversations, with one unsettled conversation per associated item. Expose active-discussion summaries through the CLI; existing revision checks handle conflicting edits. Item widgets follow their targets; deleted targets retain their last location. Empty-space anchors retain their track/time.

Closing the window leaves work running locally. Questions wait for the user to return. After a controller crash or computer restart, restore interrupted conversations without automatically repeating work. Capture an ordinary CLI checkpoint before each submitted agent turn. Stop and settle are distinct: settling requires finished/stopped work, removes the widget and deletes AFClip's pasted-image copies. Provider-owned transcripts remain. Settled-history browsing, conversation-navigation shortcuts and Content Library chat UI are deferred.

## Project state and history

Committed GUI and CLI edits save automatically. Recover the last committed state after a crash; unfinished drags are not committed edits.

### Ordinary undo and redo

- Share one chronological history across GUI and CLI, capped at 100 edits or batches for the current editing session.
- Undo reverses the latest committed edit or batch, regardless of who made it. New edits clear redo.
- Frame-rate changes are undoable as one project edit without altering clip timing.

### Agent checkpoints

- Capture the starting state of each agent pass. Keep the latest five checkpoints, including the latest-pass rollback, automatically removing the oldest when necessary.
- Checkpoints belong to the project and survive restarts and headless use. Expose latest-pass rollback and older history through GUI and CLI, with creation time and the associated task.
- Capture project state and editable graphic code without duplicating source media. Original media stays outside rollback.
- Restoration rolls back the whole project, including subsequent manual edits. Require confirmation explaining that later edits and newer checkpoints will be lost.
- Do not save the current state before restoration. Discard newer checkpoints and clear ordinary undo/redo; the restored state becomes the editing baseline. History remains linear.

## Media and project portability

Normal saves reference existing media. A separate Collect project action copies required media and graphic dependencies into a portable folder.

A searchable project bin contains imported media. Video and audio imports register with the standalone [Content Library](content-library-overview.md), which owns reusable tags, notes and named selects. Images and graphics remain project-owned until the library supports them. Provide source preview and temporary editorial In/Out selection in AFClip. Humans and agents author reusable annotations through the library GUI or CLI; AFClip provides read-only library browsing, preview, insertion and an "Edit in library" action.

New unorganized registrations enter the library's temporary Inbox. Removing a project-bin item withdraws that project's reference; the library removes an unpromoted Inbox item only after its last project reference is withdrawn. Closing a project or deleting a timeline instance does not withdraw that reference. Promoted assets are permanent and cannot be removed by AFClip. The library overview defines retry and undo behavior.

Library metadata updates propagate into AFClip, but range edits never move existing timeline cuts or replace their source version. New insertion uses the current selection. Keep sufficient source and timing data in the project to play and export existing edits without the library service when originals are available.

Missing files appear as placeholders. Relinking preserves cuts and settings. Block export of affected sections until the media is relinked.

## Tracks and organization

- Use universal tracks: audio, video, images and graphics can go on any track.
- Higher tracks composite over lower tracks. Audible audio mixes across tracks.
- Imported video starts as one combined picture-and-sound clip. Allow detaching audio into a separate linked clip. Linked items move, trim and stretch together unless explicitly unlinked.
- Tracks support naming, reordering, adjustable height, Disable and Lock.
- Disable hides visuals and silences audio together. Disabled tracks remain editable and participate in ripple operations unless locked.
- Lock prevents GUI and CLI edits. Reject operations that would modify a locked track, including ripple operations.
- Agents may create tracks when they judge it necessary.

### Folders

Provide one level of collapsible track folders in MVP. Folders collect adjacent tracks and preserve their internal order. Moving a folder reorders its tracks together without changing clip times; visual stacking changes accordingly.

Folders have Disable and Lock controls that apply to their children while preserving each child's individual settings. Re-enabling a folder restores those settings. A collapsed folder shows a compact, read-only overview of clip occupancy; expand it to edit clips.

### Clip display

- Audio clips display waveforms behind interactive volume and fade controls.
- Video clips display an average-frame-color barcode across the clip body, with the name overlaid. Combined video/audio clips show the barcode above the waveform.
- Barcodes follow the actual source frames after trimming and stretching. At close zoom, show one color per frame. At wider zoom, sampling every nth frame is acceptable for performance; exact averaging is not required.

## Timeline editing

- Regular edge-drag trims or untrims. Shift-drag stretches the selected source section to a new duration by changing playback speed. Still images simply change duration.
- Audio stretching changes pitch with speed in MVP.
- Ordinary trimming leaves other clips in place and may leave gaps.
- Provide split at playhead, copy/paste, duplicate and ordinary delete that leaves a gap.
- Support modifier-click and marquee selection. Group moves preserve relative timing and track spacing. Reject the whole move if a destination collides or a selected clip is locked.
- Vertical dragging preserves start time until horizontal movement exceeds a small threshold.
- Snap moves and trims to nearby clip edges, the playhead and markers. A modifier bypasses magnetic snapping while retaining the frame grid.
- Humans and agents can create and navigate named timeline markers.
- Prevent same-track clip overlap except through a transition. Layering and simultaneous audio otherwise require additional tracks. Ordinary conflicting placements do not overwrite clips.

### Ripple delete

Provide an explicit ripple-delete command for a selected gap or time range across all tracks. Remove the selected portion of spanning clips and join their remaining pieces. Shift later content and markers together; remove markers inside the deleted range. Any affected locked track blocks the operation. Ripple trimming is deferred.

## Transitions

MVP includes cross-dissolves and clip-edge fades, with Premiere-style placement around a cut. Adding a transition preserves timeline length. Dissolves default to centered on the cut, with start-at-cut and end-at-cut alignment options and adjustable duration.

Use available source frames outside the selected clip boundaries for the transition. Limit duration when footage is insufficient; show the limit rather than silently freezing frames or moving the cut.

### Push to create a transition

During one continuous drag, a clip stops when it hits its neighbor. Continued pointer movement beyond a small screen-pixel threshold creates a transition without requiring mouse release. The threshold should feel consistent across timeline zoom levels.

Attempted overlap determines transition duration while keeping the existing cut in place. Preview the result during dragging and limit it to available source frames. Moving back below the threshold removes the pending transition; releasing commits the current preview.

The gesture creates an audio crossfade for audio clips, a dissolve for visual clips, and both for combined video/audio clips. If only one side has audio, fade it to or from silence.

## Audio controls

- Provide clip volume, mute, fade-in and fade-out.
- Drag a horizontal volume line to adjust overall clip volume. Separate upper-corner handles control fade durations.
- Audio fades use fixed Ease In/Out curves. Adjustable fade shapes are deferred beyond MVP.
- Modifier-click adds volume points; dragging adjusts the line or existing points; Delete removes a selected point.
- Volume points ease in and out between each other, including temporary clip-edge anchors for a lone point.
- Fade handles remain independent of volume points. Apply fades over volume automation and display the resulting audible level.
- Stretch volume points with the audio so they follow the same sounds. Fade durations remain in timeline time and clamp if the clip becomes too short.

## Graphics and visual layout

Distinguish three concepts:

- Graphic clips contain arbitrary HTML, CSS and JavaScript, such as titles, lower thirds or full-screen graphics. Transparent backgrounds allow overlays.
- Treatments modify an existing clip, such as blur, color adjustment or masks. These are deferred beyond MVP.
- Transitions connect clips or fade clip edges. The basic transitions above are in MVP; custom transitions are deferred.

Graphic clips expose position, scale, rotation, opacity, timeline placement, trimming and stretching. Internal animation can remain entirely in code. Moving a graphic preserves its animation; trimming skips or hides part of that animation, while stretching changes its speed.

Declared plain-text fields inside graphics are editable in the GUI and CLI. In the preview, selecting a field pauses playback and selects its clip. Highlight text or place the caret and type, preserving styling and animation. Support multiline text, plain-text paste and ordinary text shortcuts. Clicking outside commits one undoable edit; Escape cancels. Keep the caret stable while editing and reject conflicting external changes.

Fields have stable IDs and HTML defaults. Store text overrides per timeline clip, so editing one instance does not change another. Copying or splitting a clip copies its values. Reset removes an override and restores the graphic's current default. Save, reopen, checkpoints, preview and export preserve the same values. Removing a parameter removes its saved values and curves from instances; undo restores the removal. Expose field discovery, setting and reset through the shared engine and CLI.

HTML clips, effects and transitions share declared number, boolean, color, text and choice parameters. Existing editable HTML text fields join that parameter list. Numbers and colors support keyframe curves in the inspector and CLI. Moving preserves timing, trimming hides animation, splitting preserves continuity, and Shift-drag stretches animation, including effects on images. Switching animation off retains the curve and holds its value at the playhead; switching back restores it. Complex animation can remain in code.

Use external editors or agents for graphic authoring. Reload saved changes in AFClip. Assets, fonts and scripts must be project-local, with no network access during preview or export. Agents can download dependencies into the project during authoring.

AFClip supplies graphic playback time. Graphics must follow that clock, including seeking and stretching, rather than elapsed real time. Rendering the same project time must produce the same animation state in preview and export.

Footage and images also have basic positioning and scaling controls for reframing. New media defaults to Fit, with a quick Fill option that crops excess content.

### Broken graphics

Show a clip error when a graphic cannot load or render, keeping the rest of the project editable. Broken graphics block export. Never silently omit them.

## Resolution and timing

Each project has an explicit resolution and frame rate. Timeline modifications, including audio placement and trimming, snap to its video-frame grid. Imported audio may retain a duration that falls between frames until trimmed.

Changing project frame rate preserves existing times in seconds for cuts, audio, animation and durations, even if they fall between new frame boundaries. Subsequent edits snap to the new grid. Repeat or drop source frames to match the project rate without changing playback speed or audio.

Changing resolution at the same aspect ratio preserves composition proportionally, including text, positions and animation paths. Graphics use a stable logical canvas scaled to the rendered output. Changing aspect ratio keeps the existing layout centered and scaled to fit, allowing empty space until explicitly reframed; do not automatically reposition individual elements.

## Preview and export

Lower-resolution previews and proxies are allowed. At the same project time, they must preserve final composition, layout, timing and graphic behavior. Export uses original media.

Under load, preview may skip displayed frames to keep audio and playback time synchronized. Pausing or seeking renders the exact requested frame. Export renders every frame.

Humans and agents can render and inspect a composited single frame or short section without exporting the whole trailer, including an explicit full-resolution frame using original media.

### Rendering behavior

- Export MP4 with H.264 video and AAC audio at project resolution and frame rate, for the full timeline or a marked range.
- Block project edits through both GUI and CLI during export. Single-frame and short-section inspection renders use the same temporary editing lock.
- GUI and CLI can cancel export, release the lock and delete incomplete output while preserving any previously completed export.

## Deferred scope

- Video treatments and ordered treatment stacks, including blur, color adjustment and masks. The future stack should support reordering, disabling and removing individual treatments.
- Custom transitions, pitch-preserving audio stretching, frame blending and generated intermediate frames.
- Nested track folders, group effects, audio buses and ripple trimming.
- Embedded code editing and rich-text formatting controls. Direct plain-text editing and exposed parameter curve editing are supported.
- Recording, multicam editing and nested timelines.
- Additional export delivery formats.

## MVP acceptance

Make one complete game trailer through an agent rough cut, manual refinement, another agent revision and final export. Include a headless CLI session, music, supplied sound effects, an animated graphic, fades and a dissolve. The finished workflow must demonstrate that either human or agent can take over the same project without losing timing, organization or edit intent.

## Sound generation

With an ElevenLabs key, hold G and drag an empty track range to describe Music, SFX or Speech. Speech adds a voice selector; Music can use a low-resolution video snapshot. Shared CLI operations own generation and credentials. Background placeholders reserve the range and retain results for review. The selected take plays and exports in context. Acceptance creates ordinary audio; alternatives survive only for session Undo. Interrupted requests require explicit retry.
