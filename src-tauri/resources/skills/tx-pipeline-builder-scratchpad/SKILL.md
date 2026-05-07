---
name: tx-pipeline-builder-scratchpad
description: External-memory protocol for the Builder stage of a TerminalX pipeline run. Use when an agent's role prompt instructs it to maintain a running scratchpad while executing a multi-task plan. Required for the builder role in pipeline templates that anticipate runs longer than 10 minutes or 30 plan tasks.
disable-model-invocation: true
x-tx-version: 1
---

# TerminalX Pipeline Builder Scratchpad

You are the Builder stage of a TerminalX pipeline run. Long Builder runs (20+ plan tasks across 40+ files) saturate the model's context window. By the 30th task you've forgotten the 5th task's decisions; by the 40th you're re-reading code you wrote yourself an hour ago. The cure is **structured external memory**.

You maintain `<worktree>/.tx-builder-notes.md` continuously. The file is your working memory across the run — re-read it before every task, update it on every meaningful event. The Controller treats this file as load-bearing: if it hasn't been touched in 10 minutes of activity, the run pauses with a synthetic clarification asking you to either document state or refusal-protocol.

## Format (strict — pinned by the Controller's parser)

```
# Builder notes — <run-id>

## Open task
- **id:** T<n>
- **summary:** <≤80 chars from PlanTask.summary>
- **acceptance:** <≤120 chars from PlanTask.acceptance>
- **files in scope:** <bullet list, paths only>

## Decisions made
- <one-line decision> (T<n>)
- ...

## Next concrete action
<one sentence: what you will do next, verifiably>

## Blockers
<empty | one-line summary of what's stopping you>

## Sub-agent log
<append a line per `<<<TX_SUBAGENT_DONE>>>` you receive — see `tx-pipeline-subagent`>

## Compaction summaries
<append the summary returned in each `<<<TX_COMPACTION_DONE>>>` — see rule 4>
```

The four section headers (`## Open task`, `## Decisions made`, `## Next concrete action`, `## Blockers`) are the **mandatory minimum**. The other two (`## Sub-agent log`, `## Compaction summaries`) are append-only ledgers that grow during the run.

## Rules

### 1. Update on every meaningful event

"Meaningful event" = task switch, decision, blocker hit, sub-agent return, compaction request, CI signal received. After updating:

- Re-read the entire file before continuing.
- The re-read is the load-bearing step — without it, the file is just a side-channel nobody consults.

### 2. Decisions are one line, with provenance

`- chose Map<runId, Bookkeeping> over PipelineRun field — keeps reducer pure (T7)`

Not:

```
- I'll use a Map. Actually, maybe a Set. After thinking about it, a Map.
```

The point of the file is to compress past reasoning into something re-readable in 10 seconds. If you find yourself writing prose, you're using it wrong.

### 3. "Next concrete action" is one sentence, verifiable

✅ "Add `pipeline_force_install_skill` to `lib.rs` invoke_handler."
❌ "Wire the new IPC into the rest of the system."

The first is a discrete completable step. The second is an aspiration that doesn't tell future-you what you were about to type.

### 4. Sub-agent and compaction summaries are append-only

When a sub-agent returns (`<<<TX_SUBAGENT_DONE>>>`), append a one-line entry to `## Sub-agent log`:
`- T7 sub-agent: edited 3 files, 2 commits, "added validation for empty path"`

When the Controller injects a compaction prompt and you respond (`<<<TX_COMPACTION_DONE>>>`), append the summary verbatim to `## Compaction summaries`. This becomes the long-term record of what your earlier (now-context-dropped) self did.

### 5. Pre-task checklist

Before starting any new plan task:

1. Read the entire scratchpad.
2. Update `## Open task` to the new task's metadata.
3. Set `## Next concrete action` to the literal first step of the new task.
4. Clear `## Blockers` (or carry it over if it's still relevant).

This forces task-boundary discipline. If you can't articulate the next concrete action, you don't understand the task — surface a question via `<<<TX_STAGE_QUESTION>>>` instead.

### 6. The file is gitignored

The Controller adds `.tx-builder-notes.md` to `.gitignore` at run start. You don't commit it. It's deleted on `done`. This is your private working memory, not a deliverable.

### 7. The Controller watches mtime, not content

If 10 minutes pass with PTY activity but no scratchpad write, you'll receive a synthetic clarification:

> "Builder hasn't updated `.tx-builder-notes.md` recently. Pause and document state, or refusal-protocol if blocked."

This counts against your 3-question budget. The fix is always to update the file. If you're stuck enough that you can't document state, you should be emitting `<<<TX_STAGE_FAILED>>>` with the blocker, not silently spinning.

### 8. Don't use the scratchpad as a TODO list

`## Decisions made` records what you decided, not what you intend to do. `## Next concrete action` is for the immediate next step, not a multi-task plan — the plan is the plan. The scratchpad is *retrospective state* + *one-step-ahead*, never a parallel planning system.

## Anti-patterns

- Long prose in `## Decisions made`. Each decision is one line.
- `## Next concrete action` left stale across multiple tasks.
- Mistaking the scratchpad for a journal — it's a working memory, not a diary.
- Forgetting the pre-task re-read (rule 5). If you don't read it, future-you can't either.
- Treating the synthetic-clarification as adversarial. The Controller is asking you to use the tool that exists for exactly this purpose.

## Verification

The Controller's mtime check is the enforcement; there's no honeycomb of validation. The honest test is: at the run's end, can someone reading only the scratchpad understand what was decided and why? If yes, the protocol worked.
