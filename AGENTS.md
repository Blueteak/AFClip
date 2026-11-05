## Source Control
- Just push to main
- Commit and push without asking unless there are huge changes with unknown value

## Releases
- Follow T3 Code's release presentation: `AFClip v<version>` for stable versions, `AFClip Nightly <version> (<12-character commit>)` for nightly builds.
- Before publishing, write `release-notes/<version>.md`: up to seven short user-facing highlights, formatted `- **Feature.** What users can do.` Lead with capabilities; skip implementation details and routine fixes. Include material prerelease limitations.
- Run `node scripts/generate-release-notes.cjs <version> <release-commit> [previous-tag]`. Publish using `build/release-title.txt` and `--notes-file build/release-notes.md`. The script adds counts and a collapsed commit changelog. Use the actual built commit, not the current HEAD when publishing older artifacts.
- Reference: https://github.com/pingdotgg/t3code/blob/main/scripts/generate-release-notes.ts. AFClip keeps highlights in Markdown instead of requiring an AI API key during publication.

## Tests
- No always-run test suite.
- No test-driven development.
- If you think an automated test is needed, ask before adding it.
- If a test was required for a change and passed, delete the test before pushing

## GUI Restarts
- After changes that require an GUI restart, close and reopen it on the same project automatically.

## UI Design
- If you are a GPT Model and your task requires creating a new UI Element/Style instead of reusing an existing one, spin up a Claude Opus 5.5 Sub-Agent for that task.
- Professional, sleek, Dark Mode
- Style reference: Unity 6 Editor dark skin. Keep new UI consistent with it
    - Colors: #383838 panels on #191919 dock gaps, #2A2A2A inset fields, #585858 bevelled buttons, #46607C checked, #2C5D87 selection, #3A79BB focus
    - Shape: 3px radii, dark tab strip with active tab merging into panel, toolbar bars, bold full-width inspector section headers, compact 20px fields
    - Timeline: Unity Timeline clips (dark body, colored bottom bar), white playhead; video blue, audio orange, graphic purple, image green
    - Font: Inter (system fallback), 12px
    - Use the tokens in `src/gui/styles.css` `:root`; the Content Library inherits them. No native-styled controls
- Keybindings over buttons
- Minimal text, no explanations in base UI, leave that for tooltips
- Re-use component layout styling whenever possible

## Documentation
- Overview.md files have gone through human review, keep them in mind when proposing changes/additions
    - Do not create new Overview.md files without having first worked through the /grill-me skill
- When docs are transient, put them in commit messages not files
- Liberally remove docs that are out of date or no longer needed
- Use minimal text to describe outputs and results, full sentences not required

# CLI output

Optimize `af-clip` and `af-lib` for the fewest tokens per completed task.

- Omit predictable defaults and unchanged state. Do not explain normal success in command output.
- Preserve actionable IDs, revisions, exact timing, pagination, warnings and errors.
- Keep raw diagnostics and complete data available through `--full`. Use bounded queries for large arrays and focused command help.
- Prefer useful summaries over cryptic field names. Avoid extra round trips that erase the token savings.
- Update the [output contract](benchmarks/cli/README.md#output-tokens) when changing omissions or response shapes, and measure representative output with a named tokenizer.

Keep validation lightweight. Add tests only for critical behavior; prefer a working end-to-end change over broad scaffolding.
