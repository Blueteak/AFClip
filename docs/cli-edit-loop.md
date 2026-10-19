# Repeated AI editing commands

The first audit's fixes were pushed as `3a94c30`. This pass prioritizes work repeated throughout an editing session, rather than service startup or final export.

The expected frequent tasks are library search and source inspection, focused timeline inspection, clip modifications through `apply`, marker and text edits, and review images. This is a workflow-based prioritization, not a measured distribution of AI tool calls. An editor should retain returned IDs and revisions and use edit responses to update its working state instead of inspecting the entire project after every change.

## Measured changes

The disposable fixture has 1,000 timeline clips and 10,000 library records. Each repeated command ran ten times, serially, with services already running. Catalog records share a source file; this measures metadata scale. Hardware is unchanged from the [command audit](cli-command-audit.md).

| Repeated task | Before median | After median | Reduction |
|---|---:|---:|---:|
| Inspect one clip | 139 ms | 90 ms | 36% |
| Apply a clip volume edit | 164 ms | 111 ms | 32% |
| Check changes since current revision | 146 ms | 94 ms | 36% |
| Add a marker | 153 ms | 111 ms | 27% |
| Search library | 142 ms | 95 ms | 33% |
| Inspect library item | 133 ms | 93 ms | 30% |

The total for ten iterations of those six commands fell from 8.78 to 6.04 seconds, a 31% reduction. These are local CLI timings, excluding model reasoning and tool orchestration. The loop intentionally includes inspection after an edit to measure that command; an agent can usually skip it when it already has the returned changes.

Direct inspection through an already-running HTTP client took about 2 ms. Most of the CLI cost was loading command code and initializing the client, not reading the timeline. The changes are:

- Use Node's HTTP client for the local services instead of initializing fetch for each process. Authentication, JSON errors, request deadlines and the exception for long-running collection remain. Mutations are never automatically retried.
- Enable Node's module compile cache before dynamically loading command modules. Existing entry points and syntax remain. The first invocation can pay cache creation cost; subsequent invocations reuse compiled code. This caches code, not project data or responses. Cache failures fall back to ordinary execution, and `NODE_DISABLE_COMPILE_CACHE=1` opts out. See the [Node module API](https://nodejs.org/download/release/v24.15.0/docs/api/module.html#moduleenablecompilecacheoptions).
- Load project-creation dependencies only for `create`.
- Read only markers and their relevant revisions for marker commands, instead of transferring the entire timeline.
- Skip the preliminary text-field request when both `--revision` and `--media-revision` are supplied. The service still validates both revisions before changing text.

## Optimize the task as well as the command

Twenty separate volume-edit commands took 2.31 seconds. One existing atomic `apply` batch containing twenty volume edits took 0.11 seconds, about 21 times faster. This is a single task sample on the same 1,000-clip project, after the code changes. Batching already existed; it is not a newly implemented engine feature. A batch also creates one undo step. Group edits only when they represent one decision and do not require reviewing intermediate results.

Use `inspect --id` or `--collection` for needed objects, then submit related operations in one `apply`. Merge returned revisions and changes into the current working state. Use `inspect --since` when another actor might have changed the project. Stale preconditions still reject the entire batch; reread the reported conflicting revisions before retrying.

For source selection, prefer cached library artifacts and contact sheets when one image can answer several candidate-frame questions. Timeline review still needs the compositor. This pass does not claim to accelerate image decoding or composition; its shared client improvements reduce command overhead. Export and rendering remain a separate bottleneck.

## Validation and reproduction

The noninteractive command suite passed, including source operations, edits, history, collection, rendering and cancellation. Startup failure and simultaneous-client checks passed. Targeted checks covered multibyte JSON split across network chunks, byte lengths, typed conflicts, malformed responses, broken connections without retry, explicit text revisions, stale text edits, and cache opt-out. Replaying a stale clip batch left the project revision unchanged. Output schemas are unchanged.

```sh
node benchmarks/cli/edit-loop.mjs .cache/commands-scale-2 .cache/new-edit-loop
node benchmarks/cli/verify-client.mjs
node benchmarks/cli/startup.mjs .cache/new-startup-check
node benchmarks/cli/commands.mjs .cache/new-command-check
```

The editing benchmark accepts a completed scale fixture from `benchmarks/cli/scale.mjs` and a new output directory. See [raw measurements](cli-edit-loop.json). Baseline is `3a94c30`; timings exclude startup and setup from the editing-loop comparison. This pass does not repeat the GUI window benchmark.
