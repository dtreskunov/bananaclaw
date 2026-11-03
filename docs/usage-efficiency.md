# Native runner usage efficiency

The native runner reduces the cost of each model step, not the number of steps
in a task. There is no economy mode, execution-token allowance or step ceiling.
Long tasks continue until the provider finishes, the user cancels, or a genuine
provider/context/tool failure prevents progress. Existing model selection and
generation options are unchanged; there are no new tuning settings.

## Large tool results

Aggregate text from each tool result is limited to 16 KiB, including an explicit
abbreviation notice. Complete typed results are saved in native SQLite state
and materialized privately under the session's `native-state/tool-results/`,
never the shared workspace or public Pages. Files are regenerated from a
database-only fork snapshot, whose existing size ceiling covers the archives.
Errors remain errors; media is not truncated. The model-visible history uses
the same bounded projection as subsequent requests.

Use `read({path, startLine, lineCount})` for up to 200 lines, or query a saved
JSON result with `bash` and return only relevant fields. Whole-file reads keep
their existing 256 KiB limit. Ranges support files up to 16 MiB and reject
oversized individual lines; query larger files instead of loading them whole.

## Context and quota

Compaction starts at the smaller of 100,000 context tokens and 75% of the
model's context window. Summaries preserve pending inputs, recent exchanges,
completed actions and uncertain side effects. Full transcripts remain stored.
Successful compactions can repeat throughout a task. Summaries must measurably
shrink their source; a failure is reported as a blocker with the full context
preserved. Two unresolved context/media recovery attempts are allowed per
episode, reset by a successful normal model step, not by a summary.
Quota exhaustion is terminal; ordinary transient errors retain bounded SDK
retries. No paid-credit fallback or credential changes are performed.

## Long-running versus stuck

The host never kills a task solely because its input was claimed 30 minutes
ago. A fresh validated session-link signal keeps an old task alive. Thirty
minutes without a signal still triggers idle cleanup; a claim that never
receives a subsequent signal retains its shorter startup/stuck check. Declared
Bash timeouts extend both tolerances, within the existing safety bound.
Dead-process recovery and checkpoint journals are unchanged. Recovered tool
outcomes can be uncertain; inspect completed work before repeating actions.

Actual consumption remains in the existing turn-usage records, not a second
request ledger. Raw input/cache/output token totals are not MiniMax's weighted
plan quota; reasoning tokens are already part of output. Fewer steps are not
a success metric: measure actual token use and task correctness.

## Private memory migration

Do this offline first, inside a private copy of the group's workspace:

1. Copy the complete original `CLAUDE.local.md` to `MEMORY.archive.md` beside it;
   verify byte-for-byte equality and keep the original backup.
2. Keep identity, current preferences and safety rules in the active file.
   Replace historical investigations with a topic index listing archive line
   ranges. Keep it below 20 KiB; put new detailed findings in topic notes.
   Keeping the archive beside the original preserves relative links.
3. Use bounded reads of relevant ranges, not whole-file loading. Never commit
   private memory or expose it through public Pages.
4. Verify representative memory questions and actual fresh-request input
   tokens before applying the staged copy to a live group.
5. To roll back, restore the complete original file and restart the group.

## Detect / why / fix / verify / rollback

This branch's earlier economy flag and reservation ledger were never deployed;
their migration, configuration, UI and accounting code have been removed rather
than introducing a runtime conversion. Do not deploy the superseded commits.

Native tasks no longer stop at 100 steps or a cumulative token allowance.
Detect a dependency on the old ceiling in operator workflows before deployment.
If a task should stop, cancel it explicitly rather than relying on a step cap.
Review and deploy the complete branch, then rebuild/restart through the normal
host/container paths. No live memory or service is changed by the worktree.

Verify a task beyond 100 model steps, steering, cancellation, large-result
retrieval across restart/fork, fresh signals on an old claim versus genuinely
stale signals, and memory recall. Use bounded live canaries:
removing a step cap does not guarantee account quota will last. Actual
token savings and recall quality require provider-backed verification.
Rollback is a code deployment plus restoring the original memory file.
