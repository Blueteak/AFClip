# Reelet design brief

## Purpose and scope

Build a Windows desktop editor for gameplay marketing videos, from short clips to roughly 60-second edits. The primary job is turning existing footage and supplied creative assets into polished promotional videos with fast iteration between a human editor and an external coding agent.

This repository begins with planning only. The requirements below express the intended product; proposed boundaries and milestones are starting points for evaluation, not settled implementation choices.

## Intended workflow

1. Import existing gameplay footage, music, supplied SFX, fonts, and 2D assets.
2. Review footage, tag useful moments, record selects, and create nondestructive subclips.
3. Arrange clips and audio across tracks, refine timing, and place SFX precisely against visual events.
4. Add typography, scrolling overlays, and reusable brand elements; position them visually and edit the selected element through a code panel.
5. Preview the composition, refine it through either GUI operations or agent-issued CLI commands, and export a finished video.

The user can work entirely locally. An existing Codex or Claude Code session may assist through the same CLI available to scripts and people. No particular agent provider or mandatory metered AI backend is part of the core workflow.

## Required editing capabilities

| Area | Required behavior |
| --- | --- |
| Media management | Import, identify, organize, and relink source media without destructive source edits. |
| Triage | Mark selects and source ranges, retain notes, and create reusable subclips. |
| Timeline | Arrange multiple video, audio, and overlay tracks with precise clip timing and explicit composition order. |
| Sound | Place supplied SFX precisely; trim and position music and other audio independently of video. |
| Preview and export | Preview the current saved editing state and export that same composition with consistent timing and appearance. |
| Typography | Use custom fonts, rich text styling, outlines, and shadows. |
| Graphics | Position 2D assets, create scrolling overlays, and reuse branding across projects. |
| Visual and code editing | Provide visual positioning plus a code panel for the selected element, retaining stable identity through supported edits. |
| Automation | Provide a documented, agent-agnostic CLI for inspecting and changing projects and requesting preview/export. |

React, HTML, and CSS are the intended authoring vocabulary for composition and overlays. Animation must derive from explicit frame/time inputs rather than wall-clock timers, so seeking and rendering the same frame produce predictable results.

## Shared engine and persistent document

The GUI and CLI must operate on the same persistent editing model. A separate headless implementation with different semantics would not meet the requirement.

Proposed boundaries for investigation:

- **Project document:** versioned media references, source ranges, tracks, clips, composition timing, element IDs, styles, animations, reusable branding, and export settings. Keep source media separate from the document and support relinking.
- **Editing engine:** validated operations, persistence, revision handling, undo/redo policy, and deterministic state evaluation. Both interfaces call this layer.
- **Desktop GUI:** clip browser, triage controls, timeline, preview, inspector, and selected-element code panel.
- **CLI:** project inspection and mutation, structured output/errors, and render/export requests. Its core operation must not require a model API key or a running GUI.
- **Preview/render adapter:** evaluate the same composition and time model for interactive playback and final export.

When the GUI is open, CLI operations must reach its active engine and update the visible project. When the GUI is closed, the CLI must open and edit the persisted project headlessly. Evaluate a local service versus GUI-owned engine with headless startup; do not assume either topology is selected. Define ownership, locking, stale-revision conflicts, crash recovery, and state notifications before accepting concurrent writes.

Proposed CLI contract principles include stable IDs, explicit project selection, schema-validated changes, machine-readable inspection and results, actionable exit codes, and revision-aware mutations. Concrete commands and schemas remain to be designed; no CLI examples in this brief imply an implemented interface.

## Visual and code round-tripping

Every editable element needs a stable ID that survives saving, reopening, visual changes, and supported code changes. The selected-element panel must clearly map the selection to its editable representation.

Evaluate the boundary between structured document data and React/CSS code. Arbitrary source-code rewriting is not assumed to be reliable. Define a supported editable subset or explicit component contract, preserve unrelated elements, and make unsupported constructs visible without silently discarding them. Duplication should create new identity; deletion and undo should have defined identity semantics.

Acceptance examples for a future prototype:

- Move and resize a text overlay visually, then inspect equivalent values in its code panel.
- Change text, position, font, outline, shadow, or frame-driven animation through the supported code representation and see the corresponding visual state.
- Save, close, and reopen without losing IDs, timing, styling, or supported editable structure.
- Reject invalid edits without corrupting the last valid project, and report which element failed validation.

## Open technical and licensing decisions

| Decision | Questions to resolve before selection |
| --- | --- |
| Desktop shell | Which Windows shell best supports local media access, React UI, process isolation, packaging, and acceptable resource use? |
| Rendering | Can the candidate engine meet preview/export fidelity, frame accuracy, audio synchronization, custom font, and performance requirements? |
| Remotion | Is its architecture appropriate for an embedded editor? Evaluate current terms for embedding, distribution, commercial use, and rendering before adoption; do not assume permission or pricing. |
| Reusable editor components | Identify timeline, selection, transform, media browser, and code-editor components worth reusing. Record license compatibility, maintenance, accessibility, extensibility, and integration cost. |
| Document and code model | What is canonical, how are migrations handled, and what subset can safely round-trip? |
| Engine lifecycle | How do CLI and GUI discover one shared project session and coordinate changes? |
| Timing | How are frame rate, source timestamps, variable-frame-rate footage, audio sample positions, and time conversions represented? |
| Media pipeline | Which decoding, proxy, thumbnail, waveform, caching, and export tools fit Windows? Review redistribution and codec obligations for bundled tools. |
| Export scope | Which aspect ratios, resolutions, frame rates, codecs, and quality presets are needed for the first release? |
| Fonts and assets | How are missing fonts/assets reported, and how are user-supplied assets packaged while respecting their licenses? |
| Code execution | How will composition code be validated and isolated, with explicit control over local file and network access? |
| Project licensing | Choose the project's license before distributing it. |

Keep evaluation notes and architecture decisions with their evidence and tradeoffs. Reuse components where practical, but do not commit to a framework or infer license compatibility solely from feature fit.

## Proposed milestones and acceptance criteria

### 1 Architecture and dependency investigation

Compare rendering candidates, Windows shells, reusable editing components, and shared-engine lifecycle approaches. Resolve or explicitly bound the document/code contract. Deliver a small set of decision records, licensing findings, and a scoped prototype plan before substantial implementation.

### 2 Shared project and command prototype

Implement a minimal persistent project with stable IDs and a shared command layer. Demonstrate a headless mutation surviving reopen, a CLI mutation updating an open GUI, and a defined response to conflicting or invalid edits. Use local fixture assets only.

### 3 Gameplay editing workflow

Demonstrate import, triage/selects/subclips, multitrack placement, precise supplied-SFX timing, preview, and export on a representative gameplay edit of approximately 60 seconds. Define performance targets against a documented test machine and media set before measuring acceptance.

### 4 Typography and graphics workflow

Demonstrate custom fonts, outlines/shadows, a scrolling 2D overlay, and reusable branding. Verify selected-element visual/code round-tripping and stable identity across save/reopen. Compare representative preview frames and exported frames, including typography and audio timing.

### 5 Windows usability and packaging

Validate installation, local asset relinking, recovery from interrupted work, useful CLI errors, and operation without a mandatory AI backend. Complete redistribution and licensing review before packaging third-party components.

## Initial non-goals

- Full application implementation as part of repository setup.
- Generated footage or a footage-generation service.
- Devlog-oriented production features.
- A proprietary agent integration or mandatory paid AI service.
- Cloud collaboration or hosted rendering as a prerequisite for basic editing.
- Domain registration, purchases, new credentials, public release, or final brand clearance.

## Naming context

Reelet is the selected project name. Domain selection is deferred until it is needed; setup includes no domain research, registration, purchase, or public release.
