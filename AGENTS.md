# CLI output

Optimize `af-clip` and `af-lib` for the fewest tokens per completed task.

- Omit predictable defaults and unchanged state. Do not explain normal success in command output.
- Preserve actionable IDs, revisions, exact timing, pagination, warnings and errors.
- Keep raw diagnostics and complete data available through `--full`. Use bounded queries for large arrays and focused command help.
- Prefer useful summaries over cryptic field names. Avoid extra round trips that erase the token savings.
- Update the [output contract](benchmarks/cli/README.md#output-tokens) when changing omissions or response shapes, and measure representative output with a named tokenizer.

Keep validation lightweight. Add tests only for critical behavior; prefer a working end-to-end change over broad scaffolding.
