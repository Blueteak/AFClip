# Framewright

Framewright is a planned Windows desktop video editor for short-form gameplay marketing videos, typically up to roughly 60 seconds. It brings footage selection, multitrack editing, precise sound placement, and expressive 2D typography and overlays into a local workflow that both people and existing coding agents can control.

**Status:** private project setup and planning. There is no application, runnable CLI, or selected implementation stack yet.

## Product direction

- Edit existing gameplay footage, music, supplied sound effects, and 2D assets. Generated footage and devlog production are outside the initial focus.
- Manage clips, triage footage, mark selects, create subclips, arrange multiple tracks, preview, and export.
- Use rich typography, custom fonts, outlines, shadows, scrolling 2D overlays, and reusable branding.
- Combine visual positioning with a code panel scoped to the selected element, using stable element IDs and predictable visual/code round-tripping.
- Support React, HTML, and CSS composition with frame-driven animation. Remotion is a candidate requiring licensing and embedding evaluation.
- Share one persistent editing engine and document between the desktop GUI and headless CLI. CLI commands update the live GUI when it is open and work without it when closed.
- Remain local-first and agent-agnostic: existing Codex or Claude Code agents can use the CLI without a mandatory metered AI backend.

## Planning

See the [design brief](docs/design-brief.md) for requirements, proposed system boundaries, open decisions, and milestone acceptance criteria. Implementation and dependency selection should follow those investigations.

No runtime dependencies, paid services, generated media, bundled fonts, or third-party editor components are included in this initial repository. Project licensing and dependency licensing remain to be decided.

## Working name

Framewright is a working name, not a cleared public brand. Prior naming research reported the `.com` as a resale domain, use of `.app` and `.live`, and similarly named GitHub projects. Those observations are context, not a current availability or trademark determination. Public branding remains unresolved; no domain purchase or public release is part of setup.

## Repository contents

- `README.md` — project overview and status.
- `docs/design-brief.md` — product requirements and implementation planning.
- `.gitignore` — common local dependencies, caches, credentials, media, and render outputs.
- `.gitattributes` — consistent text line endings.
