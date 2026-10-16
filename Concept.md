# Reelet

## The idea

Reelet is a pared-down, local-first desktop video editor for Windows and Mac, built around indie-game marketing. Its job is to turn existing gameplay captures into clear, compelling shorts and trailers, typically up to about 60 seconds, using supplied music, sound effects, images, fonts and brand assets.

The experience should support AI-first creation and enjoyable hands-on editing. An agent can assemble a first cut from a brief, and a person can immediately inspect it, change the pacing, reposition a title or tighten a sound cue. Both should work on the same project, with predictable results and an easy way to undo a change.

## Start with the footage

The largest friction often comes before the timeline: finding useful moments in a pile of captures, remembering what each clip contains, and turning those moments into reusable material.

Reelet should make importing, organizing, searching and triaging footage straightforward. Notes, tags, selects and clear source ranges should help people and agents identify the right shot. Nondestructive subclips should be reusable across edits while retaining their connection to the original footage.

From there, the core workflow is simple: choose the strongest moments, assemble a coherent sequence, shape its rhythm, add titles and branding, and place supplied sound effects precisely against the action. Music and audio timing deserve the same care as the picture.

## CLI first, accessible to any agent

Reelet should expose its editing capabilities through a discoverable CLI that existing local agents, including Codex, Claude Code and other tools, can use directly. Agents should be able to inspect a project, understand its structure, make scoped changes and request a render without relying on computer-use automation.

Revision requests should be understandable and bounded: “shorten the opening without changing the music,” “move this impact sound onto the landing,” or “apply the title style to these three cards.” Stable identities and clear scopes should help an agent change the intended elements while preserving unrelated work.

Commands should have structured, inspectable inputs and results, reliable errors, visible job status, and reproducible operations. Long-running work should support progress reporting and cancellation. An optional MCP adapter may make integration more convenient later, but the CLI should remain useful on its own.

The core editor should work without accounts, cloud onboarding, model API keys or a mandatory per-token AI backend. External agent subscriptions remain independent choices. Manual editing should remain fully useful when no agent is connected.

## One project, two equal interfaces

The CLI and GUI should be peers over one shared persistent document and editing engine. An operation should mean the same thing whether it comes from a button, a script or an agent.

When the GUI is open, CLI edits should update the visible project. When it is closed, the CLI should still be able to inspect, edit, save and render headlessly. Stable element IDs, explicit project state and safe handling of conflicting edits should make switching between these modes dependable.

Undo and redo should support confident iteration. Failed or invalid edits should leave a recoverable project and explain what needs attention, rather than silently losing work or producing a different result in each interface.

## A timeline that feels good

Timeline navigation should be familiar and responsive: straightforward zooming, panning, scrubbing, selection, trimming and movement across multiple video, audio and overlay tracks. Common actions should be visible and easy to discover, with clear feedback about what is selected and what an edit will affect.

Direct keyframe and easing controls should make animation timing understandable. Quick manual polish—nudging a cut, adjusting a fade, changing a transition or aligning a supplied sound effect—should feel immediate. Avoid awkward hidden interaction modes and account-centered screens that get between the user and the edit.

The useful baseline includes multitrack media and audio, precise timing, volume and fades, transitions, crop and scale controls, basic color adjustments, and predictable exports for landscape and portrait marketing formats.

## Typography and 2D assets are first-class

Text and graphics should have the expressive range needed for game branding: custom fonts, mixed styles within text, outlines, shadows, reusable brand presets, scrolling cards, layered PNGs and transparency. Assets should support fades, position, scale and rotation with visible, editable easing.

Typography and 2D effects should use HTML/CSS-backed rendering so agents can work with a familiar, expressive vocabulary. A small collection of reusable effects and styles should be easy to adapt and combine, without requiring a huge preset library.

Animation should be deterministic and driven by the requested frame or timeline time. Seeking to a moment should reproduce that moment, and preview and final export should share timing, composition and appearance. React-based composition, frame-driven rendering approaches and Remotion are candidates to evaluate; they are not irrevocable dependencies or promises about licensing.

## Visual editing and code should cooperate

The canvas should provide WYSIWYG placement, resizing, rotation and snapping. An optional HTML/CSS or code panel should be scoped to the selected element, making its editable representation clear without forcing the user to navigate an entire composition's source.

Visual and agent edits should round-trip safely through stable element identity and a clearly supported editing contract. Moving a title on the canvas should be reflected in its editable representation; changing supported styling through code should appear on the canvas. Unsupported changes should be explained rather than silently discarded.

Layout and animation should remain distinct concepts: where an element belongs should be understandable separately from how it moves over time. Reusable components and styles should preserve that clarity while allowing deliberate customization.

## Responsiveness is part of the product

Excellent footage handling is a core goal. Playback, scrubbing, timeline interaction and ordinary edits should stay smooth while background work runs. Decoding, encoding and rendering should use hardware acceleration where available and appropriate.

Caches and automatic proxies should make demanding source footage practical to edit while preserving original-quality media for final export. Proxy state, background progress and missing assets should be understandable. Thumbnail generation, analysis and rendering should work efficiently without freezing the interface or making cancellation unreliable.

Performance choices should support the full editing experience, including rich overlays and audio, while maintaining preview/export consistency. These are product goals rather than claims about a particular implementation or machine.

## Build a focused product

The first useful product should complete an end-to-end edit: import and triage footage, create selects and subclips, assemble tracks, place supplied audio, add branded text or graphics, refine the result manually or through an agent, and export it reliably.

Reuse mature components where they fit, while building a coherent Reelet experience around them. Evaluate maintenance, integration costs and third-party licenses before adoption or distribution. Electron with React is a current desktop candidate; the media engine and project model should remain separable from the shell.

The initial scope excludes devlog production, footage generation, mandatory cloud collaboration, a proprietary AI service, and the breadth of a large general-purpose editor. Capture assistance can be explored later. The priority is a small, dependable tool that makes indie-game marketing edits easier to create, revise and finish.
