# Native runner economy mode

Economy mode is an opt-in, per-agent-group runtime policy, not a model output
limit. Existing groups retain their behavior. Only the native provider supports
it. No personal memory or live configuration is included in this branch.

Enable after reviewing the complete changes and staging the memory migration:

```sh
ncl groups config update --id <group-id> --economy-mode true
ncl groups restart --id <group-id>
```

Disable with `--economy-mode false` and restart. The equivalent settings API
field is the boolean `economy_mode`. These operations use existing permissions.
The native group's Settings tab exposes the same switch and existing restart
confirmation. Switching to another provider clears the switch; the server
rejects an incompatible provider change unless economy mode is disabled.

## Large tool results

Economy mode limits aggregate text from each tool result to 16 KiB, including
an explicit abbreviation notice. Complete typed results are saved privately
under the session's `native-state/tool-results/`, not the shared agent workspace
or public Pages. Errors remain errors; media is not truncated. Stored history
and subsequent requests use the same bounded projection.

Use `read({path, startLine, lineCount})` for up to 200 lines, or query a saved
JSON result with `bash` and return only relevant fields. Whole-file reads keep
their existing 256 KiB limit; ranges also reject oversized individual lines.
Ranged reads support files up to 16 MiB; use targeted queries for larger files.

## Context

Economy mode triggers compaction at the smaller of 100,000 context tokens and
75% of the model's context window. Each compaction can make at most four model
requests; existing transcript-preservation and two-proactive-attempt safeguards
remain in place. If compaction fails or reaches that limit, tools are disabled
and the runner asks for a progress handoff instead of continuing an expensive
tool loop. Other groups keep the existing policy.

## Durable request budget

Each formatted input in a native conversation has an allowance of 20 model
requests (including summaries and the final handoff) and two million cumulative
input/cache/output tokens. At 19 requests or 1.75 million tokens, the runner
stops tools and requests a handoff. A new input grants another allowance;
steering and replaying the same input after a restart do not reset it.

Before each request, `native-state.db` reserves serialized UTF-8 request bytes
plus the allowed output, with 1 KiB framing headroom. Actual reported usage
replaces that estimate; missing usage or interrupted requests retain their
reservation. Estimates are conservative safeguards, not billable token counts.
Large media may require disabling economy mode for that task. If the remaining
allowance cannot fit a request, a deterministic pause notice is delivered
without another model call. Output is capped to the remaining allowance.

The private `model_calls` table records request kind, time, actual input,
cache reads/writes, output, context and API duration without storing prompts.
It is the budget ledger as well as request-level diagnostic data; no second
accounting pipeline is introduced. Existing turn usage/UI accounting remains
the source for actual reported consumption. To inspect without model calls:

```sh
pnpm exec tsx scripts/q.ts <session>/native-state/native-state.db \
  "SELECT kind,COUNT(*),SUM(input_tokens),SUM(cache_read_tokens),SUM(output_tokens) FROM model_calls WHERE conversation_id='<continuation>' GROUP BY kind"
```

Filter by the active continuation: a native fork snapshot can contain its
parent's historical rows, which must not be billed again in cross-session audits.

Budget estimates cannot guarantee MiniMax quota availability: other clients
share the account, quota units are weighted, and an in-flight call's actual
usage can differ from its estimate. An overrun prevents subsequent calls.
The request allowance counts SDK model calls; their existing maximum of two
transient HTTP retries remains separate. Confirmed MiniMax Token/M Plan usage
exhaustion is terminal in economy mode and is not retried. Ordinary transient
429/network errors retain the SDK's bounded retry behavior; no paid-credit
fallback or credential change is performed.

## Private memory migration

Do this offline first, inside a private copy of the group's workspace:

1. Copy the complete original `CLAUDE.local.md` to `MEMORY.archive.md` in the
   same directory. Check byte-for-byte equality and keep the original backup.
2. Keep identity, current preferences and safety rules in `CLAUDE.local.md`.
   Replace historical investigations with a topic index listing archive line
   ranges. Keeping the archive beside the original preserves relative links.
3. Use bounded reads of the relevant archive ranges, not whole-file loading.
   Never commit the private files or expose them through public Pages.
4. Verify representative memory questions and measure actual fresh-request
   input tokens before applying the staged copy to a live group.
5. To roll back, restore the complete original file and restart the group.

Compare usage in the user's timezone. Raw input/cache/output token totals
are not MiniMax's weighted plan quota, and reasoning tokens are already part
of output. Use recorded successful-call usage, not estimates, for savings claims.
