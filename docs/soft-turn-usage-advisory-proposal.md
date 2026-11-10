# Soft turn-usage advisory and reusable telemetry

Status: implemented for the native provider, disabled unless configured.
This design does not introduce a task ceiling or change live group settings.
See [runtime configuration and reporting](usage-efficiency.md#soft-turn-usage-advisory).

## Goal and agreed scope

Reduce unexpectedly expensive turns by informing the agent of its reported
consumption and asking it to finish promptly or stop with a progress report.
There is no special approval flow, hard token limit, or suspended-task state.
The user resumes work through an ordinary follow-up message.

Usage reporting is a standalone capability. The advisory consumes the same
structured statistics as the UI and future consumers; it must not maintain a
private usage counter or require parsing activity text.

Provider-side remaining allowance and reset times are assumed unavailable.
Reported tokens approximate consumption, not remaining subscription quota.
This is a cooperative backstop, not a guarantee against account exhaustion.

## Existing foundations

- [Turn execution](../container/agent-runner/src/turn-execution.ts) deduplicates
  model-call reports and updates cumulative usage during a logical turn.
- [Turn usage persistence](../container/agent-runner/src/db/turn-usage.ts) writes
  structured snapshots, including input, output, cache, model and timing fields.
- [Runner-state journaling](../container/agent-runner/src/db/runner-state.ts)
  projects usage inserts and updates to the host through the session link.
- [Conversation assembly](../src/ui/server/chat/conversation.ts) exposes turn
  usage alongside other conversation statistics and metadata.
- The [native provider](../container/agent-runner/src/providers/native.ts) owns
  model-step boundaries and already injects internal guidance.

Build on these paths. First verify their end-to-end live-update behavior and
repair directly related gaps, rather than inventing another telemetry store.
Existing runaway detection and bounded recovery remain independent.

## Reusable usage reporting

### Measurements and identity

Preserve the existing normalized fields: uncached input, output, cache reads,
cache writes, reasoning, model, model-call count, elapsed time, API time, and
cost where available. Keep context occupancy distinct from cumulative usage:
the same prompt can be processed many times during one turn.

Use the existing session and turn identity, with provider and agent-group
context available to consumers. Keep stable call identities during ingestion
so corrected reports replace earlier reports rather than adding consumption.
Retries, compaction, and corrective generations contribute their reported
usage to the same logical turn.

The advisory derives its consumption measure from disjoint normalized buckets:

```text
reported tokens = uncached input + cache reads + cache writes + output
```

Reasoning is already included in normalized output and must not be added again.
Verify adapter normalization before applying this formula; provider SDKs do not
all define input and cache fields identically.

Retain the individual fields, not just the derived sum. Future consumers may
weight cached tokens differently or use cost instead. Distinguish reported
cost from locally estimated cost wherever estimation is offered.

### Lifecycle and quality

- Update after every available model-call report, not only after a final reply.
- Carry the same snapshots through runner persistence, host projection,
  conversation API, live UI updates, and history reload.
- Preserve usage for failed, cancelled, silent, and partially completed turns.
- Preserve the existing provisional, partial, final, and unavailable states.
  Finality and completeness are different: an ended turn may have partial data.
- Missing provider measurements are unknown, not measured zero. Audit the
  adapters and serialization so defaults do not erase this distinction.
  Do not reinterpret legacy zero-valued records as reliably measured usage.
- Consumers replace cumulative snapshots by stable identity; they must not sum
  successive snapshots of the same turn.

Usage reporting must work when the advisory is disabled. A reporting problem
must remain visible through the existing diagnostics and quality metadata,
without fabricating a zero-cost or zero-token success.

## Soft advisory behavior

### Configuration

Use one optional positive integer threshold per agent group, expressed in
reported tokens. Leave it disabled unless explicitly configured; select an
initial value from representative successful turns rather than inventing a
universal quota or step limit.

This is runner policy, not a provider generation parameter.
`container_configs.soft_turn_token_budget` is managed through Agent Settings
and `ncl groups config update --soft-turn-token-budget`; null/empty disables it.
It materializes as `softTurnTokenBudget`, separate from `model_params`, and
requires a group restart.

### Trigger and delivery

1. Evaluate the shared cumulative usage snapshot when reports change.
2. On the first threshold crossing, queue one internal advisory for the current
   logical turn.
3. Apply it at the next safe model-step boundary, after already-started tools
   settle and before further discretionary work.
4. If the turn already has a deliverable final reply, deliver it without
   requesting another generation solely to issue the advisory.
5. Let the agent either finish promptly or report progress and end its turn.
   Continuing later uses the normal chat flow, not an approval action.

Do not abort an executing tool, repeat a completed operation, or manufacture a
new user message. The advisory must not reset usage or create a fresh allowance.
Retries and compaction do not rearm it.

### Agent instruction

```text
Turn usage advisory: this turn has consumed approximately {used} reported
tokens, meeting or exceeding its {threshold}-token soft budget. This is not a
measurement of remaining provider quota.

Wrap up now. If the task is nearly complete, finish with minimal additional
work. Otherwise, report what is completed, what remains, and any uncertain or
ongoing side effects, then end this turn and wait for the user.

Do not start new exploratory work, delegate further work, or schedule an
automatic continuation.
```

The agent's progress report is a normal final response. Ending the turn does
not imply that every external side effect or background process has stopped.
The report should identify any such outstanding work.

### Advisory metadata and visibility

Persist advisory metadata separately from raw usage, keyed by logical turn:
the configured threshold, usage snapshot at triggering, lifecycle status,
and timestamps for triggering and actual application. Record whether a queued
advisory was skipped because the turn finished.

Use the existing session journaling/projection mechanism and expose typed
metadata through the normal conversation path. Queue acceptance is not proof
the model received the instruction. Only mark it applied when incorporated
into the request. Record this at most once across recovery or replay.

Show a small activity notification when the instruction is applied. Do not
add an approval bubble or paused-task UI. Diagnostics must distinguish an
unavailable measurement or unsupported injection path from an active advisory.
Operational delivery failures must not trigger extra paid generations merely
to explain the failure.

`reported_tokens` and `cost_source` live directly on the durable `turn_usage`
record and travel with its existing journal payload and conversation API
projection. Only `usageAdvisory` belongs to turn metadata. Usage is folded once
per model-call report and reused by persistence and policy evaluation; advisory
transitions do not rewrite usage rows. Result/finalization writes still refresh
duration, model limits and output anchoring. No extra ledger or analytics
database is introduced. Expanded usage details expose the count; the compact
elapsed/cost/context summary is unchanged.

## Implementation boundary

Start with the native provider, whose runner controls step boundaries.
Other providers retain their existing reporting and behavior; do not claim
advisory support merely because they accept queued follow-up messages.
Adding another provider requires verifying timely usage and safe instruction
ingestion within the active turn.

Keep normalization and accumulation shared. Keep advisory policy separate from
measurements, with the native adapter responsible only for boundary delivery
and application acknowledgement. Internal control guidance must not be routed
through user-message steering bookkeeping with fabricated input identities.

No separate per-call analytics ledger, account-quota poller, model fallback,
credential change, hard-stop escalation, or automatic continuation is proposed.
Future uses of the structured statistics are deliberately outside this change.

## Acceptance and verification

1. With the advisory off, usage remains available live and historically through
   the same API/UI paths as other turn statistics.
2. Synthetic multi-call turns yield exact expected bucket totals. Corrected
   reports replace earlier values; retries and summaries are counted once;
   reasoning is not added twice.
3. At threshold minus one token, no advisory is queued. At exactly the
   threshold, one is queued; later reports do not queue another.
4. The injected instruction contains the actual cumulative count and configured
   threshold. It belongs to the existing turn and precedes its next eligible
   model request.
5. Existing tools finish without cancellation or replay. A ready final answer
   is delivered without an extra generation.
6. Cancellation, errors, silent results, replay, and restart retain their
   reported totals and quality states. Advisory recovery neither duplicates
   application nor claims that an undelivered instruction was applied.
7. Missing measurements remain unknown. API and UI consumers see the same
   snapshot and completeness metadata used by the advisory.
8. A provider-backed canary checks whether the model actually wraps up,
   preserves task correctness, and avoids automatic continuation. Unit tests
   alone cannot prove instruction compliance or real quota savings.

## Rollout and rollback

Implement and validate telemetry first, then enable the advisory for a small
native group with an explicit threshold. Observe usage at triggering, additional
usage afterward, and whether the agent finishes or reports incomplete work.
One long request can overshoot the threshold, and the model can ignore guidance;
report these outcomes rather than presenting a hard budget guarantee.

Disabling the policy must leave usage collection and stored history intact.
Any additive metadata should remain safe to ignore on rollback; do not delete
usage or private conversation state to disable the advisory.

Populated v2 stores require the [offline cutover](usage-efficiency.md#offline-cutover)
before deployment. Host/session/runner stores require v3 and runner links v7;
normal runtime paths have no schema upgrades, metadata backfills, or legacy
usage decoders. The one-time tool prepares verified candidates and rollback
copies, requires drained runner journals, preserves any explicit measurements,
and leaves unknown historical values null. Commit the tool before the cutover,
then retire it after successful verification while keeping its Git history and
private rollback inventory.
