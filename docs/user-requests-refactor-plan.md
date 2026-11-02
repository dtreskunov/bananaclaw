# Unified user requests: simplification and implementation plan

Date: 2026-11-01

Status: revised proposal awaiting operator approval. No runtime changes have
been implemented. Approval of this document authorizes the agreed implementation
scope, not any individual operation, account setup, or credential grant.

## 1. Executive proposal

Replace the separate question/approval coordination paths with one small,
host-owned user-request lifecycle. Keep specialized consent, private review, and
execution in their existing modules.

The common pattern is:

```text
Submit once -> Await explicit user input -> Record the response
            -> Apply if authorized -> Deliver a correlated outcome
```

Questions, operation approvals, account setup, and access requests share
identity, attempts, response receipts, history, projection, and durable result
delivery. They do not share the authority conferred by their responses.

The transcript, current-conversation dock, and cross-conversation inbox become
views of the same authorized request projection, not independent state machines.
Account setup can unblock an existing access request, but granting access always
requires a separate explicit review and consent action.

Implement the common model, UI, and response/reliability path first. Ship linked
setup/access and storage/protocol cutovers as separately verified increments.
Do not add forms, cross-thread answering, or a general workflow framework.

### Architectural simplification is a completion requirement

The end state must have:

- One host lifecycle owner and one typed response dispatcher.
- One browser-safe request model and one authorization-aware projection path.
- One durable response/attempt pattern and one result-delivery pattern.
- Module-owned operation validation, private data, execution, and reconciliation.
- One shared UI shell with specialized inputs/reviews.
- No permanent question-versus-approval handler fallthrough, duplicate lifecycle
  histories, legacy client normalization, or parallel editors.

Temporary adapters are migration tools, not the final architecture. Extract and
reuse the existing durable approval patterns rather than building a second
workflow system beside them. Physical table conversion may follow the first
release, but removal of redundant lifecycle ownership is part of the refactor.

## 2. Scope, baseline, and prior art

Scope is BananaClaw, not BananaBrowse extension approvals or browser handoffs.
Keep action-specific agent tools and host-supported operations. An agent cannot
invent executable instructions and obtain authority through a generic approval.

Source repository: `dtreskunov/bananaclaw`, local checkout
`/home/denis/nanoclaw-v2`. The original design was written from the separate
`/home/denis/bananabrowse` editor workspace; implementation targets BananaClaw.

Observed HEAD: `109f2f550` ("Retire legacy credential gateway support in favor of
Agent Vault"). The checkout contains substantial uncommitted credential,
approval, MCP configuration, UI, test, and documentation changes. This proposal
uses that working tree, not HEAD alone. Preserve those changes and recheck the
baseline before implementation; do not reset or independently reimplement them.

The motivating live chat showed MCP installation, restart, setup/access review,
and agent-written coordination instructions. It does not establish a particular
backend failure. The shared Tools settings preview was mocked, not deployed
backend evidence.

### Current implementation map

Paths are relative to this document.

| Surface | Starting points | Reuse or replace |
| --- | --- | --- |
| Questions | [interactive.ts](../container/agent-runner/src/mcp-tools/interactive.ts), [interactive module](../src/modules/interactive/index.ts) | Reuse asynchronous submission and correlated wake. Preserve one outstanding question per session. Replace answer-specific coordination with common terminal-result handling. |
| Access/setup | [access.ts](../container/agent-runner/src/mcp-tools/access.ts), [access-requests.ts](../src/modules/credentials/access-requests.ts) | Reuse private account review, exact destination/authentication checks, connection/config revisions, and grant reconciliation. |
| Approvals | [primitive.ts](../src/modules/approvals/primitive.ts), [response-handler.ts](../src/modules/approvals/response-handler.ts), [workflows.ts](../src/modules/approvals/workflows.ts) | Extract common durable claim, attempt, alias, and notification patterns. Generic approval execution currently also uses a process-local guard; that alone is not crash-safe. |
| Responses | [response-registry.ts](../src/response-registry.ts), [ask-question.ts](../src/channels/ask-question.ts), [routes.ts](../src/ui/server/chat/routes.ts) | Replace overloaded `questionId` and handler fallthrough with deterministic typed routing. Reuse channel delivery/identity infrastructure. |
| Projection/protocol | [approval.ts](../src/ui/shared/approval.ts), [conversation.ts](../src/ui/shared/conversation.ts), [conversation-protocol.ts](../src/ui/shared/conversation-protocol.ts), [approval-transcript.ts](../src/ui/server/chat/approval-transcript.ts) | Normalize legacy representations once, then expose canonical requests and typed request timeline rows. |
| Question UI | [QuestionPrompt.tsx](../src/ui/client/chat/src/components/QuestionPrompt.tsx), [question-dock.ts](../src/ui/client/chat/src/question-dock.ts), [ChatMain.tsx](../src/ui/client/chat/src/components/ChatMain.tsx) | Preserve choice/text, skip, voice, keyboard, multiline input, and timeline anchoring. |
| Approval/access UI | [ApprovalCard.tsx](../src/ui/client/chat/src/components/ApprovalCard.tsx), [ApprovalBubble.tsx](../src/ui/client/chat/src/components/ApprovalBubble.tsx), [AccessRequestCard.tsx](../src/ui/client/chat/src/components/AccessRequestCard.tsx), [AccessRequestReview.tsx](../src/ui/client/chat/src/components/AccessRequestReview.tsx) | Extract common layout/state feedback; retain exact operation and private account review. |
| History/durability | [approval-history.ts](../src/db/approval-history.ts), [session-link.md](./session-link.md), [approvals/project.md](../src/modules/approvals/project.md) | Preserve audit/import data, single-writer journals, commit acknowledgement, existing invalidation streams, and deferred restart. |

Current account setup mutates an access workflow's purpose through
`prepareAccountRequest`. Completing setup grants no access and changes no MCP
binding; the agent must submit a separate `request_access`. Replace that purpose
mutation with linked immutable kinds only in the explicitly approved linked-flow
increment.

## 3. Release invariants

1. Setup never grants agent access or changes an MCP binding.
2. Ordinary chat, answers, steering messages, navigation, voice input, and dialog
   dismissal never authorize a privileged operation.
3. The host checks authority on every read, preview, response, mutation, recovery
   action, and receipt retrieval. Client capabilities are presentation hints.
4. Identity, origin, audience, and authority derive from trusted host/session
   context. Agents cannot nominate approvers or assert user privileges.
5. Consent applies only to the exact reviewed operation and revisions. Changed
   scope, connection, or configuration requires fresh review.
6. Review shows actual grant breadth, including current/future connection URL
   patterns and MCP binding consequences; a grant is not implied to be task-only.
7. Secrets stay in private account management and the gateway. Transcripts,
   request/result envelopes, notifications, and logs contain no credential values.
8. Private selections and account libraries never leak through shared views.
   Linked requests do not transfer permissions.
9. Request origin is immutable. Unavailable legacy origin is explicit, never
   guessed from the current tab, thread, or active session.
10. Local submission, host acceptance, user decision, application, and upstream
    task verification are distinct facts.
11. Accepted responses and result-delivery intent are durable. Replay is
    idempotent; uncertain external writes are not automatically repeated.
12. Decline, skip, cancellation, expiry, and submission rejection produce explicit
    outcomes. There is no automatic approval or resubmission after refusal.
13. Existing deferred restart and single-writer DB ownership remain intact.
14. Migration does not execute imported requests, guess missing decisions, or
    silently convert live state without an approved deployment/migration step.

## 4. Small common core, specialized modules

The host request service owns submission identity, aliases, attempt lifecycle,
response receipts, terminal transitions, delivery intent, and public projection.
Use ordinary typed functions and a closed dispatch map, not a plugin framework,
workflow DSL, configurable stage graph, or generic form engine.

Existing modules retain their permission helpers, private review resources,
operation-specific revision checks, executable payloads, execution, and safe
reconciliation. Reuse their implementations; do not duplicate them in the core.

| Common concern | Specialized concern |
| --- | --- |
| Stable identity and immutable origin | Supported operation and immutable executable input |
| Current attempt, CAS claim, response receipt | Exact consent, connection/configuration revisions |
| Bounded lifecycle and attempt history | Personal account selection, OAuth, grant/binding application |
| Durable safe result delivery and invalidation | Inspection of external effects and supported recovery |
| Authorized public projection and shared shell | Kind-specific permissions and specialized review/input |

No module independently publishes a competing lifecycle or result notification
after cutover. Existing storage adapters temporarily implement the same service
contract with one authoritative writer per kind.

Unknown kinds, actions, or mismatched payloads fail closed. Once a response is
routed to its kind/action, validation or execution errors do not fall through to
another handler.

## 5. Request, attempt, and outcome contract

### Request identity and public projection

Use a browser-safe discriminated `UserRequest` union:

| Kind | Interaction | Authorized result |
| --- | --- | --- |
| `question` | Choice, text, choice-or-text, or explicit skip | Typed answer or skipped result |
| `approval` | Review a host-supported exact operation | Explicit approve/decline receipt, then application outcome |
| `account_setup` | Connect, reconnect, enable, or repair a personal account | Explicit readiness confirmation; no agent grant |
| `access` | Privately select a compatible account and review grant/binding | Explicit allow/decline receipt, then application outcome |

The common envelope contains:

- Stable `requestId`, `kind`, `revision`, `createdAt`, and existing kind-specific
  expiry where applicable. Do not introduce a new universal expiry policy.
- Host-owned attribution and immutable original session/route/message/turn
  association; expose only authorized, browser-safe origin/navigation fields.
- Concise title/reason, current `attemptId`, lifecycle, typed result, and
  server-derived capabilities with explicit unavailability reasons.
- Optional typed setup/access relationship and authorized blocker summary.

Operation definitions and schemas are immutable within a request. A changed
operation requires a new request, possibly linked as a replacement. Request
revision tracks canonical changes; browser stream revision remains a separate
projection synchronization counter.

Account names, selected connection references, executable inputs, gateway
details, and runner routing capabilities are not public envelope fields.
Public receipts, private reviews, and agent results are separate authorized
projections of the same facts.

### Attempts and bounded lifecycle

Each attempt uses:

```text
awaiting_user -> executing -> resolved
awaiting_user -------------> resolved
```

An attempt records its accepted response, responder/time, execution claim, and
typed outcome. Preserve the decision even when applying it fails. Finalized
attempts and their accepted responses are immutable.

Supported resolution variants include answered, skipped, declined, completed,
cancelled, expired, and application-specific failure:

- `failed`: no effects applied, as verified by the module.
- `partially_applied`: known effects applied but the reviewed operation did not
  complete; expose a safe effects summary and supported recovery.
- `uncertain`: effects cannot yet be established; allow inspection, not blind
  replay. A generic error is not evidence that nothing changed.

Questions/setup have kind-appropriate outcomes; do not force application-effect
fields into every response.

Reopening is an explicit authorized operation: retain `requestId`, create a new
`attemptId`, increment revision, and require fresh review. Old receipts remain
available. Reopen only when module reconciliation establishes that a new attempt
is safe; unknown effects require inspection first. Never automatically retry an
old consent or discard attempt history.

Blocked access remains `awaiting_user` with a typed prerequisite, not another
lifecycle string. OAuth and application steps are bounded module details, not
an additional workflow engine.

Cancellation/expiry claims race with response acceptance through the same CAS.
They terminalize awaiting attempts, not already executing external work. Do not
promise cancellation can undo effects. Parent access may be cancelled while its
independent setup child completes, without subsequently granting anything.

### Verification boundary

An access request completes when its exact grant and any reviewed configuration
are applied and host-verified. Upstream authentication/task success remains
separate and must be safely verified by the agent after any deferred restart.

Expose that distinction explicitly: "access applied; upstream operation not yet
verified." Reuse normal agent turn/task reporting for subsequent verification;
do not add a durable verification sub-workflow to every request.

## 6. Typed responses and effectively-once application

Use one response envelope for web and external channels:

```text
requestId + kind + attemptId + requestRevision + responseId
          + kind-specific response + optional supported steering message
```

Authentication supplies responder identity. Modules validate private selections,
reviewed-operation tokens, and exact connection/configuration revisions. Steering
cannot modify the approved operation.

`responseId` identifies one explicit submission, not the request. Generate it
once per user submission and reuse it for transport retries. Bind channel
callback data to the same typed request/attempt/revision/action using existing
trusted callback infrastructure; never trust client-nominated origin or user.

Persist an accepted response receipt uniquely by `(requestId, responseId)`, bound
to the authenticated responder, attempt, kind, submitted revision, and canonical
validated payload digest. Private selection data stays in module-owned storage.

Processing order:

1. Authenticate, resolve canonical request/aliases, and authorize the operation.
2. Recognize an identical accepted response before rejecting its old revision.
   Return its canonical authorized receipt without repeating any mutation or
   steering delivery.
3. Reject reused IDs with different payloads/identity, stale new submissions,
   conflicting decisions, unavailable origin, or unknown kinds/actions explicitly.
4. Validate exact review/operation data and atomically CAS the current attempt,
   persisting accepted response, execution claim, and delivery intent before
   external work.
5. Recheck authority and module-specific revisions at each privileged mutation
   boundary. Run only the installed handler for that exact operation.
6. Persist the typed outcome and correlated result-delivery intent. Return the
   canonical receipt/outcome; HTTP success alone is not application success.

A different responder receives a conflict, even if selecting the same answer.
Receipts expose no private winning selection to that responder. Reauthorization
also applies to identical retries after permission revocation.

Only accepted responses need durable receipts; do not add a journal of arbitrary
invalid submissions. Use repository-standard explicit error/status reporting.

Crash recovery inspects executing attempts through module reconciliation.
Known completed effects can be recorded without repeating writes. Proven absent
effects can enable explicit fresh review; partial/unknown effects remain visible
with inspect/recovery actions. An in-memory lock is an optimization, never the
durability guarantee.

## 7. Linked account setup and access

Recommended behavior for approval:

```text
Connect personal account -> Confirm readiness -> Review agent access
                        -> Explicit Allow access -> Apply and verify grant
```

1. Submit access once, with immutable task/account intent and no grant.
2. In private review, evaluate compatibility within the responding user's
   authorized personal library. Never search other users' libraries to decide
   whether setup is necessary. Do not silently choose an account for the user.
3. Opening setup creates/reuses a linked `account_setup` child bound to that
   initiating user, exact connection/setup intent, and parent. Reuse only that
   user's compatible active child; other responders get independent private
   children. A relationship transfers no authority.
4. OAuth callbacks remain bound to their initiating identity/connection through
   existing gateway protections. Confirm readiness from canonical gateway state
   and require explicit setup confirmation; browser success flags are not proof.
5. Setup completion grants nothing and changes no MCP binding. Keep private
   selections private; give the agent only authorized safe readiness metadata.
6. Reauthorize the responder and revalidate parent state, account compatibility,
   request revision, and connection/configuration revisions. Make fresh access
   review available; never automatically open a modal or accept a grant.
7. Separate **Allow access** consent CAS-claims the parent. One parent decision
   wins; other responders see canonical completion/conflict without learning the
   selected private account.
8. Apply through the existing credential module and deliver the parent outcome
   to the original session. The agent safely verifies and continues the task.

The overall parent remains open to other authorized responders while one user's
setup is pending. Blocker/actionability is viewer-specific: that user sees their
setup step; another user may already have a compatible account. Count one
actionable task path per viewer, not every private child as an unrelated alert.

Setup cancellation does not silently decline access. Access cancellation,
expiry, or another responder's decision prevents all late setup callbacks from
advancing/applying the parent. Invalidate linked parent actions; preserve or
finish independently created personal accounts without deleting them. Explain
exactly what changed and what did not.

Callbacks in another tab, wrong accounts, insufficient scopes, disabled
connections, closed/blocked popups, and gateway outages have explicit recoverable
outcomes. No account is automatically substituted and no access is inferred.

Limit linking to setup required by access. MCP installation and deferred restart
remain existing separate gates: a named server must be approved, applied, and
restarted before its access request. Do not build general dependency graphs.

## 8. One projection and three coordinated UI surfaces

Use one shared request shell:

1. Agent attribution, concise task-oriented title, and reason.
2. Specialized answer input or exact operation/private review.
3. Actual scope and permission breadth, with expandable technical details.
4. Explicit kind-specific actions.
5. Submission, application, conflict, recovery, and resolved receipt feedback.

Never replace unknown technical scopes with reassuring labels. Account selection
and sensitive diagnostics remain in private authorized review resources.

### Transcript, dock, and inbox

- **Transcript:** one stable request anchor, original task context, and attempt
  receipts. Decisions do not move the anchor or manufacture another request.
- **Needs you dock:** compact current-conversation summaries; expand one active
  editor rather than stack forms.
- **Needs you inbox:** authorized summaries across agents/conversations, with
  agent, task, age, actionability, and navigate-to-origin links.

All use the same ID, attempt, revision, and host capabilities. One selected
request/editor state is shared within a client; separate tabs may have drafts,
but the server's CAS determines the only accepted response.

Preserve navigate-to-origin interaction initially. Inbox/notifications are links,
not off-thread authorization endpoints. Unknown origin is read-only except for
the separately authorized management recovery described below.

### Inbox backend contract

Add a bounded authenticated inbox resource and invalidation-driven subscription
using the existing conversation stream pattern, not a new push/replay system.

- Authorize each request's visibility/actionability and origin before projection;
  never flatten unfiltered per-session data.
- Return compact public summaries and an exact viewer-actionable count; retain
  private review as a separate authorized resource.
- Order by original `createdAt`, then canonical `requestId`; use bounded cursor
  pagination. Reproject/reset pagination on invalidation or reconnect so newly
  actionable items cannot be missed behind a stale cursor.
- Count awaiting actionable paths once. Executing requests are not awaiting
  input; recoverable failures use a separate attention category.
- Reauthorize every refresh. Role/membership changes invalidate affected views
  and remove unauthorized items/counts, not merely disable their buttons.
- Subscribe before taking snapshots, coalesce invalidations, reject slow
  consumers, and surface failed reads explicitly. Reuse existing stream/reducer
  mechanics; do not invent durable browser acknowledgements.

### Interaction and privacy

- Arrival never steals focus, scrolls forcibly, or opens a modal.
- Dismissal is not decline/skip/cancellation. Keep normal chat usable.
- Preserve choice/text/skip, voice, multiline, keyboard, mobile, and accessible
  headings/labels/status/focus return.
- Explain loading, disconnection, unauthorized/stale state, prerequisites,
  unavailable origin, and expiry.
- Persist only non-secret drafts, scoped to authenticated user, request, and
  attempt. Clear on logout/account switch or lost authorization. Preserve through
  reconnect/navigation; compatible lifecycle revisions do not destroy drafts.
  Schema/review changes invalidate incompatible drafts with an explanation.
- Show safe partial/uncertain effects and explicit supported recovery inline.
- Collapse finalized attempts into concise authorized receipts with response,
  responder/time where permitted, and application/verification distinction.

Keep one outstanding question per session and existing response modes. Bounded
forms and higher concurrency are explicitly deferred, not implicit consequences
of the shared model.

## 9. Durable continuation and terminal/orphan recovery

Agent tools keep action-specific asynchronous semantics:

1. Write a durable submission once and receive its stable submission identity.
2. Report local queuing distinctly from host acceptance/delivery.
3. Finish the blocked turn or continue genuinely independent work.
4. Receive correlated host acceptance/rejection and final attempt outcomes.
5. Continue with original dates, timezone, task, and account intent; safely
   verify applied changes after any required restart.

Map submission aliases durably to canonical requests. Correlate every event with
request, attempt, and original submission/session; a deduplicated submission
must not become an agent-visible orphan.

Use the existing central transaction, host input journal, runner journal, and
session-link ownership patterns. Commit response/outcome delivery intent with
the corresponding transition. Project it idempotently to the original host input
journal using deterministic event IDs, then mark projection complete after that
commit. Runner reception retains the existing commit acknowledgements/replay.
There is no cross-file atomicity claim or host write access to runner SQLite.

Decision receipts and final outcomes are distinct facts, but use one delivery
path. Only the final appropriate result means a change is usable. Defer runtime
restart until the active response commits, and preserve post-restart outcomes.

Every terminal question outcome, including host submission rejection, skip,
cancellation, and supported expiry, releases the runner's outstanding-question
gate through an idempotent terminal result. Do not infer resolution solely from
an answer row or require a poller/new user message to unblock it.

### Missing origin and deleted sessions

- Never infer a replacement route from the active tab/session or newest message.
- Preserve an authorized management summary of unresolved legacy requests with
  unavailable origin. Owners/scoped authorized administrators can explicitly
  cancel or reissue the supported operation after review; reissue creates a new
  request with a new trusted origin. It never grants or replays automatically.
- If a trusted original session association survives, deliver a safe terminal
  result to that session using existing host-controlled transport. Do not
  invent a missing conversational route or publish private recovery details.
- If the session no longer exists, retain outcome/audit data, mark continuation
  unavailable, and stop retrying delivery to a nonexistent destination.
- Integrate outstanding-request cancellation with existing thread/group deletion
  confirmation. Executing operations retain their existing deletion guard and
  require reconciliation, not optimistic cancellation.

Cancellation and callback races settle through canonical state. An account
created independently can remain after a parent disappears; no callback may
recreate the parent or apply a grant.

## 10. Persistence, protocol, and migration

### Projection first; bounded adapters

Initially map existing questions, approvals, workflows, and history into the
shared public union. Use one tested pure legacy-normalization function, reused
where the old DTOs are consumed. Do not scatter optional-field fallback chains
across components.

Current permission checks/storage remain authoritative during the UI extraction.
Add no consent or concurrency changes as an incidental refactor. When host
canonical projection replaces legacy DTOs, remove client normalization.

### Canonical durable ownership

The target persistence concepts are request identity/origin/current attempt,
attempt response/execution/outcome, submission aliases, and durable events with
delivery intent. Follow existing central-DB helpers and migrations; choose the
smallest schema that represents these facts without a duplicate audit/outbox
framework. An append-only event record may also carry result projection intent.

Reuse existing credential workflow patterns and move their common coordination
into this core. Keep private/executable records in owning modules keyed by
request/attempt. Accepted responses and finalized attempts cannot be overwritten
by reopen.

During the response increment, add durable receipts/claims wherever missing,
including generic approvals/questions. Those are real correctness prerequisites;
an in-memory guard is insufficient. Implement them in the target schema or
reuse storage that already satisfies the identical contract.

Physical consolidation can occur by kind after behavior is proven. Each cutover
switches lifecycle ownership atomically for that kind and removes its old
mutation/notification path. No steady-state dual writes or independent lifecycle
projections. Global consolidation is not a prerequisite for linked setup if the
participating kinds already meet the common durable contract.

### Explicit migration and protocol cutovers

- Use repository schema migrations and an operator-approved, quiesced state
  conversion/deployment step. Document detect/why/fix/verify/rollback; do not
  opportunistically convert live requests when they are read.
- Preserve IDs or stable aliases, origin, existing purpose, expiry, decisions,
  steering messages, attempt history, and historical outcomes.
- Import pending/history records without execution. Preserve missing/uncertain
  facts honestly; do not synthesize consent or successful verification.
- Reconcile preexisting executing operations before reopening; do not migrate
  them into blindly runnable jobs.
- Retain legacy archives where required, but stop their lifecycle writes after
  cutover. They are audit records, not another request service.
- Back up affected stores and use coordinated restore guidance. Older binaries
  cannot be assumed to understand new state. Database rollback does not undo
  gateway grants/configuration effects; inspect and reconcile external effects
  separately.

Browser-protocol cutover is a separate coherent deployment from physical
storage conversion. Expose canonical `requests` and typed request timeline rows;
replace approval message attachments/separate question collections together
with validators, projections, reducers, subscriptions, tests, and rebuilt assets.
Do not indefinitely publish both representations.

Version the changed browser protocol; existing clients must reload rather than
silently fall back. Runner/session-link version changes occur only if their actual
wire contract changes. Coordinate host/runner deployment for strict validators.

External channels use the same typed response identity and authority, even when
rendering only a compact card/private-review link. Review navigation is never
consent. Include active callback aliases in migration coverage.

## 11. Implementation sequence and gates

Implement separately reviewable increments, not a broad rewrite.

| Phase | Prerequisites | Deliverable and completion gate |
| --- | --- | --- |
| A. Baseline and contract | None | Preserve dirty baseline; define request/attempt/response/outcome unions, kind-specific authority, normalization, and terminal/retry tests. No runtime behavior change. |
| B. Shared UI and authorized inbox | A | One shell, transcript adapter, dock, shared editor state, and bounded authorized inbox stream. Existing consent, thread gating, question limits, and voice/drafts survive. |
| C. Common response and reliability | B | Deterministic routing, durable accepted receipts/claims, immutable attempts, module reconciliation, safe correlated terminal results, and orphan recovery. Remove handler fallthrough for adopted kinds. No claim of crash safety based only on existing process-local locks. |
| D. Linked setup/access | C; explicit approval of this behavior | User-bound immutable setup children and fresh parent access review; one winning grant decision, no agent resubmission. Callback, cancellation, account-selection, and permission races pass. Does not require global table conversion. |
| E. Storage and protocol cleanup | C; include D's records if D has shipped | Separate per-kind storage cutovers and browser protocol deployment. Remove old lifecycle writers/notifications/client adapters; migrate pending/history/aliases without execution and verify rollback guidance. |

A-C are the first delivery scope. D and E are subsequent increments; E may
precede D if that reduces transition code. Do not leave adapters indefinitely:
complete E before declaring the architectural refactor finished.

Forms, cross-thread answering, question-concurrency changes, and generic workflow
composition are outside this plan. Any future forms increment needs separate
requirements, bounded schemas, privacy rules, and server validation.

### Simplification evidence required at completion

Record the old paths removed and the replacement:

| Retired duplication | Common replacement |
| --- | --- |
| Question/approval response fallthrough and overloaded IDs | Typed request/action dispatcher |
| Separate answer, approval, and access continuation writers | Correlated durable request-event delivery |
| Competing question/approval/workflow lifecycle ownership | Request/attempt service with module-owned execution details |
| Approval attachments plus independent question UI state | Canonical requests and typed timeline rows |
| Repeated status/purpose fallback logic | One normalization path, then its removal at protocol cutover |
| Agent resubmission/coordination after account setup | Narrow linked setup/access prerequisite |

No new packages, workflow engines, persistent browser replay logs, or deployment
services are expected. A common-looking card without removed duplication does
not satisfy the simplification goal.

## 12. Acceptance and fault-injection matrix

| Scenario | Required observation |
| --- | --- |
| Plain question/skip | Existing choice/text semantics; typed result reaches the original session exactly through the common delivery path. |
| Question labeled "Approve" | Answer confers no privileged authority. |
| Question cancelled/expired/rejected by host | Correlated terminal result releases the per-session outstanding-question gate, including after restart. No new default question expiry is introduced. |
| Pending request offscreen/in another conversation | Dock/inbox discovers it without focus theft, forced scroll, or modal opening. |
| Navigate/refresh/reconnect | Canonical state and authorized drafts return; one client editor; no duplicated request anchor. |
| Logout/account switch/revocation | Drafts/private review are cleared or inaccessible; inbox items/counts and conversation projections are reauthorized. |
| Two tabs/responders race | One accepted response wins; conflicting identity/decision gets an explicit conflict without exposing private selections. |
| Lost response acknowledgement | Same response ID returns its receipt despite later request revisions; no repeated mutation, steering, or outcome delivery. |
| Reused response ID with changed body | Explicit conflict; no execution. |
| Revocation or reviewed revisions change | Response and each privileged mutation revalidate authority/revisions; no stale grant. |
| Inbox pagination/invalidation/reconnect | Stable ordering, exact authorized attention count, no missed newly actionable items or unbounded buffers. |
| Private setup by multiple responders | User-bound children; compatible existing accounts remain usable by their owners; one parent decision wins without cross-library disclosure. |
| Setup readiness confirmed | No grant/binding changes; parent presents fresh separate access consent. |
| OAuth late callback/wrong account/closed popup/outage | Exact initiating identity respected; explicit recovery; no automatic account substitution or grant. |
| Parent declined/cancelled/expired/resolved elsewhere | Late setup cannot advance or apply parent. Independently created personal account is not silently deleted. |
| Broad credential grant | Exact actual current/future URL-pattern breadth and binding consequences visible before consent. |
| Shared conversation/private account | Public views, other responders, notifications, agent events, and logs expose no private library/selection or secrets. |
| Application succeeds | Host grant/configuration verification distinguished from upstream task verification; deferred restart completes before verification guidance is usable. |
| Application fails/partly applies/is unknown | Decision retained; typed effects/outcome; inspection before uncertain replay; fresh explicit review before safe new attempt. |
| Reopen failed request | Same request, new attempt/revision, immutable old receipts; old callback cannot authorize the new attempt. |
| Crash at claim/external write/outcome/delivery | Durable recovery reconciles effects, does not replay uncertain writes, and redelivers correlated events idempotently. |
| Missing origin/session deleted | No guessed route or infinite delivery retries; authorized management cancel/reissue and accurate continuation-unavailable audit state. |
| Legacy/state/protocol cutover | Pending/history/aliases/expiry survive without execution; one writer per kind; old clients reload explicitly. |
| Snapshot versus incremental updates | Identical authorized request ordering, lifecycle, receipts, capabilities, and counts. |
| Mobile/keyboard/voice/dismissal | Usable accessible inputs; focus returns; voice/navigation/dismissal never submits approval. |
| Agent blocked after setup/restart | Parent outcome resumes original task without recurring guards, polling, or another access submission. |

Inject failures around claim commit, external effects, outcome journaling, input
journal projection, callback, deletion, permission change, and deferred restart.
Assert actual grants, revisions, event identities, attempt history, counts, and
runner gate release, not just HTTP success or card appearance.

## 13. Validation and documentation

This revision is documentation-only; no runtime checks or real account operations
are needed to write it. Implementation validation starts with the smallest
affected suites. Host/UI use Vitest; runner tests use Bun.

From the BananaClaw repository root:

```bash
# Responses, consent, continuation, and access reconciliation.
pnpm exec vitest run \
  src/modules/approvals/response-handler.test.ts \
  src/modules/approvals/approval-resolved.test.ts \
  src/modules/credentials/access-requests.test.ts \
  src/ui/server/chat/question-responses.test.ts

# Projection, transcript, and protocol.
pnpm exec vitest run \
  src/ui/server/chat/approval-transcript.test.ts \
  src/ui/server/chat/conversation-convergence.test.ts \
  src/ui/shared/conversation-protocol.test.ts \
  src/ui/client/chat/src/question-dock.test.ts \
  src/ui/client/chat/src/components/ApprovalBubble.test.ts

# Runner submissions and terminal-result gate release.
cd container/agent-runner
bun test src/mcp-tools/interactive.test.ts
cd ../..

# Affected typechecks and persistent checked-in UI assets.
pnpm run typecheck
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm --dir src/ui/client/chat run build
```

Add focused tests for the new core, immutable attempts, receipts, inbox
authorization/counts, orphan recovery, migrations, and linked consent. Existing
selectors alone cannot demonstrate the new requirements. Run existing
lint/format checks on changed source and broader suites when shared-contract
changes or targeted failures justify them.

Validate UI in controlled fixtures with realistic awaiting, executing, failed,
partial, uncertain, resolved, disconnected, unauthorized, and linked data.
Do not approve live requests, sign in, restart the live host, or modify real
credentials merely to validate UI. Rebuild checked-in assets; never hand-edit
generated bundles.

As increments land, update:

- [ui.md](./ui.md): shared surfaces, private review, drafts, receipts, recovery,
  and explicit protocol deployment.
- [session-link.md](./session-link.md): actual request/result wire and durability
  changes, including terminal question outcomes.
- [approvals/project.md](../src/modules/approvals/project.md): common lifecycle
  ownership, specialized execution, reconciliation, and retired paths.
- Related DB/migration guidance: detect/why/fix/verify/rollback, per-kind
  ownership, immutable attempts, aliases, and external-effect reconciliation.
- Existing agent tool/module/skill guidance: submit once, distinguish queuing
  from acceptance, finish blocked turns, await correlated results, preserve task
  intent, and never infer access from setup.

## 14. Approval scope and definition of done

Recommended decisions embodied in this proposal:

1. Approve A-C as the initial implementation scope; D/E remain separately
   reviewable deployment increments rather than one rewrite.
2. Approve the intended linked behavior in D: host-managed setup followed by
   fresh separate access consent, replacing agent resubmission.
3. Retain originating-conversation interaction, existing question modes, and one
   outstanding question per session. Do not add forms or cross-thread answering.
4. Reopen through new immutable attempts only after safe reconciliation and
   fresh review. Never automatically repeat an uncertain privileged write.
5. Keep setup children private and initiating-user-bound; no automatic account
   choice, permission transfer, or cross-user reuse.
6. Complete access at host grant/configuration verification; report upstream
   task verification separately through ordinary agent turns.
7. Support authorized explicit cancellation/reissue for missing-origin requests,
   without guessing routes or replaying operations.

These are proposed defaults selected for simplicity and reliability, not runtime
behavior already enabled. Individual setup, grant, operation, and migration
approvals remain mandatory at their normal boundaries.

Done means persistent verified behavior across agent tools, host routing/storage,
channels, browser protocol/UI, notifications, recovery, and documentation, plus
demonstrated removal of the duplicated paths in section 11. Temporary adapters
must be retired; a new facade over unchanged competing state machines is not done.
