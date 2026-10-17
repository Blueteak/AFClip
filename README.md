# Reelet

Reelet is a desktop video editor for short gamedev marketing videos. It brings footage/audio management, multitrack editing, and expressive 2D typography and overlays into a focused workflow that both people and coding agents can control.

## What this does

- Quickly and fluidly edit gameplay footage, music, sound effects, and 2D assets.
- Manage clips, triage footage, mark selects, create subclips, arrange multiple tracks, preview, and export.
- Overlay rich typography, custom fonts, effects, 2D animation, and reusable branding.
- CLI as a primary input method - anything in GUI can be done via CLI, and GUI doesn't need to be open to function.
- Remain local-first and agent-agnostic - bring your own agent into the workflow, no account needed.

## What this does not

- Video post processing (color grading, greenscreen, masking, etc)
- Complex VFX 
- Special formats
- Export platform integrations
- Handle an account

## Planning

See the [design brief](docs/design-brief.md) for requirements, proposed system boundaries, open decisions, and milestone acceptance criteria. Implementation and dependency selection should follow those investigations.

No runtime dependencies, paid services, generated media, bundled fonts, or third-party editor components are included in this initial repository. Project licensing and dependency licensing remain to be decided.

## Repository contents

- `README.md` — project overview and status.
- `docs/design-brief.md` — product requirements and implementation planning.
