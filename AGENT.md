## Source Control
- Just push to main
- Commit and push without asking unless there are huge changes with unknown value

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
- Keybindings over buttons
- Minimal text, no explanations in base UI, leave that for tooltips
- Re-use component layout styling whenever possible

## Documentation
- Overview.md files have gone through human review, keep them in mind when proposing changes/additions
    - Do not create new Overview.md files without having first worked through the /grill-me skill
- When docs are transient, put them in commit messages not files
- Liberally remove docs that are out of date or no longer needed
- Use minimal text to describe outputs and results, full sentences not required

