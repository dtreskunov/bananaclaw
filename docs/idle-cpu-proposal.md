# Reducing idle host CPU consumption

Status: implemented. Host deployment requires a rebuild and restart; no data
migration or container rebuild is needed.

## Summary

Idle CPU usage currently scales with the number of accumulated sessions, even
when no containers are running and no messages need processing or delivery.
The host repeatedly opens historical session databases, replays completion
acknowledgements, and publishes change notifications for unchanged state.

Address this in two independently reviewable stages:

1. Remove false invalidations and redundant database opens while
   retaining the existing recovery scans.
2. Keep the existing event-driven workers and 60-second timers, but filter out
   quiet or not-yet-due sessions using an in-memory candidate map rebuilt from
   durable host databases at startup.

The second stage is necessary to make steady-state idle cost independent of
historical session count. Neither stage should archive conversations, weaken
recovery, change task semantics, or require persistent connections to every
session database.

Scope decision: minimize implementation and operational complexity. Stage 2
adds candidate filtering, not a new scheduler. A one-time
O(total sessions) discovery pass is an acceptable tradeoff; eliminating it is
not a goal. A durable queue, central work table, new outbox protocol, and storage
migrations are out of scope.

The implementation reuses the existing workers, timers, and host-change bus.
[Candidate filtering](../src/session-candidates.ts) retains cached eligibility
for pending work and invalidates it on committed session, runtime, configuration,
or access changes. Access invalidation also handles the existing bus's
superseding of specific session notices. Archive restoration publishes its
session changes, and committed input mutations flush the existing host-event
journal without relying on a no-op sweep notification.

## Evidence

Measurements were taken on November 10, 2026, without restarting or modifying
the live service. Isolated replays used the actual compiled host functions
against private SQLite backups; the temporary backups were removed.

### Live process

- 764 sessions were marked `active`; all containers were stopped.
- Over 140.1 seconds, the host consumed 15.44 CPU-seconds: approximately 11% of
  one logical CPU.
- Two observed bursts occupied approximately one core for seven seconds each.
- Process read traffic was approximately 774 MiB, with no recorded physical
  disk reads. The dominant sampled hotspot in isolated replay was SQLite
  statement preparation.

The timers wait 60 seconds after completing a pass, so the bursts need not
align with wall-clock minute boundaries.

### One maintenance pass plus one delivery pass

| Work                                                        | Observed count |
| ----------------------------------------------------------- | -------------: |
| SQLite connections opened and closed                        |          7,640 |
| Historical acknowledgement UPDATE attempts                  |         27,944 |
| Rows changed by those UPDATE attempts                       |              0 |
| Session-change notifications from maintenance               |          1,528 |
| Messages due for delivery                                   |              0 |
| Due inbound work, unsettled turns, or dirty summary markers |              0 |

In repeated, unprofiled A/B replays, median maintenance CPU time was about
2.7 seconds without the summary listener and 4.7 seconds with it. This
attributes approximately two CPU-seconds per maintenance pass to redundant
summary refreshes. Disabling the listener is an experiment, not a proposed
production fix: real changes still require projection.

Replay timings vary with host contention, instrumentation, and cache state.
The operation counts are the more useful regression assertions. Linux load
average is not CPU utilization and is not an acceptance criterion.

### Implementation comparison

After implementation, both versions ran their actual maintenance, delivery, and
summary-projection code against separate copies of the same 764-session idle
snapshot. Startup discovery was excluded. Over 140 seconds per version:

| Steady-state measurement                       | Baseline | Candidate filtering |
| ---------------------------------------------- | -------: | ------------------: |
| CPU time                                       | 13.467 s |             0.059 s |
| Average CPU, one logical core                  |   9.612% |              0.042% |
| Session database connections opened and closed |   15,280 |                   0 |

This two-cycle isolated comparison measured approximately 99.6% lower
housekeeping CPU. It did not start channel adapters, the UI, or providers and
does not substitute for the planned ten-minute live acceptance measurement
after deployment. The isolated comparison did not modify the live service.

Focused regressions cover ten idle intervals, future input and output,
recurrence, edits and pause/resume, deletion and archive restoration, restart
reconstruction, delivery and recovery retries, missing stores, running-session
liveness, host-event flushing, and concurrent or superseding invalidations.

## Current amplification

The relevant paths are:

- [Maintenance](../src/host-sweep.ts) visits every session whose status is
  `active`, including stopped conversations with no outstanding work.
- [Acknowledgement synchronization](../src/db/session-db.ts) loads every
  completed or failed processing acknowledgement, attempts an UPDATE for each,
  and records a database change even when no row transitioned.
- Maintenance also calls `notifySessionHostState` unconditionally in its
  `finally` block.
- [Host change publication](../src/host-changes.ts) distinguishes otherwise
  equivalent notices with and without `groupId`, so the two maintenance
  notices are not deduplicated.
- Each notice invokes [thread-summary refresh](../src/thread-summaries.ts),
  opening both session databases even when their dirty-marker tables are empty.
- [Stopped-runner recovery checks](../src/session-recovery.ts) reopen an
  outbound database already held by maintenance. Stopped-session cleanup also
  opens a writable handle when there are no processing claims to remove.
- [Delivery recovery](../src/delivery.ts) independently opens both databases
  for every active session to discover that nothing needs delivery.

For the measured idle sessions, maintenance opens four connections per session.
Its two notices cause four more opens through summary refreshes, and delivery
opens another two: ten connections per session per pair of passes.

## Goals and constraints

- Idle host CPU and session-database activity must not grow with the number of
  quiet historical conversations.
- Preserve prompt event-driven delivery and existing scheduled-work,
  retry/backoff, recurrence, and stuck-container behavior.
- Preserve commit-before-ACK and durable replay semantics in the
  [session link](session-link.md).
- Retain provider-free recovery of stopped runners with unsettled work, even
  when no inbound message is pending.
- Preserve session privacy, database ownership, journal modes, and delivery
  receipts. The host must not inspect the container-owned runner-state database.
- Errors must remain logged and retryable; failed reads must never classify
  a session as idle.
- Add no dependencies, periodic profiling service, or new operator setting.

Non-goals include conversation retention changes, deleting old acknowledgements,
changing the current failed-acknowledgement mapping, changing delivery guarantees,
and optimizing model-provider or container CPU.

## Stage 1: remove unnecessary work

### 1. Publish changes only after actual mutations

Have acknowledgement synchronization record a session change only when its
existing `transitioned` result is nonempty. Keep the notification associated
with the successful transaction using the existing
[transaction helper](../src/db/transaction.ts); do not publish on rollback.

Remove the sweep's unconditional change publication. Audit the sweep's
mutation paths first: retries, permanent failures, orphan-claim cleanup,
recurrence insertion, and recovery outcomes must still publish their real
committed effects. Keep failure reporting separate from state invalidation.

`notifySessionHostState` currently combines UI invalidation and socket flushing.
Do not accidentally stop flushing newly queued host events when suppressing
false UI notifications. Invoke flushing from actual journal producers and
reconnect/retry paths; separate it from UI invalidation where necessary.

Leave shared notification deduplication, the summary listener, and browser
authorization behavior unchanged. Fix the false publishers rather than
canonicalizing events across the application.

Retain existing historical acknowledgement reconciliation and its
`batch.persisted` boundary, including the handling of missing input rows and
failed acknowledgements. Per-input event tracking and acknowledgement query
rewrites are deferred unless profiling genuine, non-idle work justifies them.
Stage 2 removes this reconciliation from quiet sessions' periodic activity.

### 2. Reuse handles within an operation

- Let the stopped-runner recovery predicate use maintenance's existing
  read-only outbound handle.
- Open a writable outbound handle for orphan cleanup only when actual claims
  or failure bounces require it.
- Reuse prepared statements within that connection's lifetime.

Keep handles short-lived and preserve ownership and pragma checks. Do not
introduce an unbounded connection cache or carry a transaction across network
delivery or container recovery.

### Stage 1 exit criteria

An unchanged maintenance pass emits zero session-change notifications and opens
no writable outbound handle merely to discover an empty claim set. Existing
no-op acknowledgement UPDATE attempts may remain, but must not publish changes.

Record operation-count improvements without a fixed intermediate CPU reduction
target. All-session scans still exist at this stage, so it is not the final
idle-CPU solution.

## Stage 2: schedule work, not historical sessions

### Filter the existing loops with a rebuildable candidate map

Keep session databases authoritative. Introduce a small process-local candidate map,
keyed by session ID, containing only:

- dirty maintenance or delivery work;
- the next inbound or outbound eligibility timestamp;
- pending retry or stopped-runner recovery work;
- running-container liveness checks.

A session with none of these leaves the map. A future task or delayed outbound
message retains its eligibility timestamp without keeping its database open.

Keep the existing maintenance and delivery timers at their 60-second cadence.
Each loop selects its candidates and checks cached eligibility against the
current time before opening databases. A quiet timer tick may inspect the map
in memory; it must not reopen quiet or not-yet-due sessions.

Keep immediate event-driven processing, per-session serialization, dirty-bit
coalescing, and running-container liveness checks in their existing workers.
Do not merge the workers, introduce nearest-deadline timer rearming, or add a
general-purpose scheduler, job framework, or heap.

This avoids a new durable central work index and its cross-database commit
problem. It also avoids adding storage migrations or changing session status
to mean "currently has work."

### Reconstruct once at startup

Before enabling candidate-filtered periodic scans, enumerate the active sessions and
reconcile their host-owned stores once. Discover pending input and output,
processing acknowledgements, unsettled turns, recurrence work, dirty projection
markers, and recovery requirements.

Subscribe to producers before reconstruction and merge concurrent changes;
an older startup snapshot must not overwrite newly queued work. Include
containers adopted across host restart in liveness monitoring.

Process startup discovery in bounded batches, yielding between sessions after
a short time budget, rather than blocking the event loop for several seconds.
Expose discovery progress and failures through existing logs. A failed
inspection remains retryable and prevents that session from being declared idle.
Handle a genuinely uninitialized new session distinctly from a missing or
unreadable established store.

Startup remains O(total sessions). Periodic ticks examine only candidates,
including known future work, not all historical sessions. Open session databases
only for changed, due, retrying, or running work.

### Wire every work producer

| Producer                                                                                      | Required scheduling effect                                                                                  |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Committed inbound messages, input edits/cancellations, task create/update/pause/resume/cancel | Recompute inbound eligibility and affected projections                                                      |
| Completed processing batch                                                                    | Run existing acknowledgement reconciliation, recurrence, and any newly due input                            |
| Committed outbound message or turn settlement                                                 | Recompute delivery eligibility without bypassing the settlement barrier                                     |
| Delivery success, terminal failure, or delivery-failure bounce                                | Update receipts, remaining work, and any resulting inbound work                                             |
| Transient delivery or spawn failure, unavailable adapter/runtime/gateway                      | Retain work and schedule retry at no worse than the existing recovery cadence                               |
| Runner start, exit, adoption, or recovery completion/failure                                  | Update liveness, recovery, and pending-work membership                                                      |
| Session creation, deletion, or relevant configuration change                                  | Initialize, remove, or invalidate the affected schedule                                                     |
| Host-event journal insertion or session-link reconnect                                        | Preserve flushing through the existing acknowledged transport; do not move transport into the candidate map |

Use the existing commit paths and typed durable effects rather than a second
generic notification bus. UI invalidation alone is not proof of runnable work.
Unclassified committed mutations should conservatively queue a session for
inspection rather than silently dropping potential work.

### Preserve recovery without a recurring full scan

The candidate map is an optimization, not a durable queue:

1. Commit source state before publishing its scheduling effects.
2. Mark a session dirty before attempting fallible inspection. Retain the dirty
   entry until inspection succeeds.
3. If an event arrives during a drain, leave the session dirty for another pass.
4. On an in-process read, callback, or delivery failure, retain work and retry
   with an explicit diagnostic.
5. On process death between commit and scheduling, startup reconstruction
   rediscovers the committed state, including events already ACKed to the runner.
6. Discover already-overdue work immediately after restart. Never require a new
   user message to recover it.

Preserve the current delivery-attempt limits and receipt semantics; do not
claim exactly-once external delivery across a send/receipt crash.

Keep checking wall time on the existing periodic ticks. Producers update cached
eligibility when work is created, changed, or cancelled; future work becomes
eligible on the next appropriate tick, as with the current scans. This retains
clock-jump responsiveness without adding timer lifecycle or rearming logic.

Do not retain a hidden periodic full scan "for safety." Instead, prove producer
coverage and restart recovery before removing the old scans. Direct out-of-band
SQLite edits require an explicit reconciliation or host restart; document this
maintenance boundary rather than relying on undocumented polling behavior.

## Validation and acceptance

### Correctness

Extend the existing host tests with focused candidate-eligibility tests.

| Scenario                                                      | Required result                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Unchanged stopped session                                     | No writes, invalidations, or repeat scheduled inspections                    |
| Replayed acknowledgement or durable event                     | Idempotent state; pending work is not lost                                   |
| Completed batch and recurring task                            | Completion and next occurrence processed once, at the existing boundary      |
| Output arriving before turn settlement                        | Response not released before its delivery barrier                            |
| Future input or delayed output; host restarts before deadline | Work runs when eligible without a new inbound message                        |
| Retry/backoff, adapter outage, or spawn/recovery failure      | Work remains scheduled; errors are explicit; limits unchanged                |
| Process exits after commit but before notification or receipt | Startup rediscovers outstanding work; existing delivery guarantees preserved |
| Event during a drain or startup discovery                     | A second pass runs; newer work is not overwritten                            |
| Cancel, pause, edit, resume, or session deletion              | Deadline updates correctly; stale callbacks do not resurrect work            |
| Idle/stuck runner and long declared Bash timeout              | Existing liveness and recovery decisions preserved                           |
| Read failure or missing established store                     | Diagnostic and retry, never a successful empty result                        |
| Clock moves forward or backward                               | No early delivery; eligibility rechecked within the existing recovery bound  |
| Stable open UI and actual state changes                       | No false projection rebuilds; genuine updates remain visible                 |

Primary regression suites are
[maintenance](../src/host-sweep.test.ts),
[delivery](../src/delivery.test.ts),
[thread summaries](../src/thread-summaries.test.ts),
[host changes](../src/host-changes.test.ts), and
[session recovery](../src/session-recovery.integration.test.ts), plus the
existing session-link and scheduling suites. Run targeted selectors together,
then the host typecheck and lint checks. No runner rebuild or runner test
changes should be necessary unless implementation expands beyond host code.

### Performance

Use small synthetic fixtures containing quiet sessions and a few sessions with
pending or future work. Assert operation counts rather than CI wall-clock time.
Do not commit live conversation data or require a production database.

After startup reconstruction, with stopped containers and no pending work:

- Advancing through ten simulated maintenance intervals opens zero per-session
  SQLite connections and emits zero false session invalidations.
- Increasing historical session count does not increase idle inspections.
- One new input, one due task, or one outbound event touches only its relevant
  session, apart from genuine shared configuration effects.

Make one representative before/after comparison over ten warm-idle minutes per
version, with the same UI state and background workload. Report process CPU time
and whether the recurring housekeeping bursts disappear. The reference-host goal
is average CPU below 1% of one logical CPU, not a timing assertion in CI.

Report startup cost separately and preserve normal delivery, scheduled-work, and
recovery behavior. No 10,000-session benchmark, peak-CPU SLO, or event-loop
telemetry subsystem is required. Do not infer success from smoother load average
or merely moving the spike. Keep instrumentation bounded and content-free, and
do not leave a profiler attached to the live service.

## Delivery and rollback

1. Land Stage 1 with regression tests and record operation-count improvements.
2. Implement Stage 2 producer coverage and startup reconstruction before removing
   either full-session scan. Keep the existing timers and workers. The old scans
   may coexist only during development as a comparison aid, not as the final
   shipped design.
3. Exercise crash/restart and outage tests before deploying candidate filtering.
4. Build and restart the host in an agreed deployment window; do not silently
   change the running installation while implementing or reviewing this proposal.
5. Update [session-link recovery documentation](session-link.md) and relevant
   architecture documentation to explain candidate-filtered recovery and the
   out-of-band database-edit boundary.

The proposed implementation requires no new persistent schema, data conversion,
runner protocol, or container image. Rollback is a host-code rollback and restart:
the existing journals, receipts, and session rows remain authoritative, and the
old scans can rediscover them. If implementation requires a new persistent cursor
or work table, stop and revise this proposal with an explicit migration and
rollback plan rather than adding an implicit runtime conversion.
