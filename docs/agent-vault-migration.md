# OneCLI migration inventory, private preparation and target provisioning

## Plan of record: shared references (revision 7)

The [gateway plan of record](credential-gateway-agent-vault-fork-proposal.md)
now replaces duplicated group-owned credentials with user-owned connections
and explicit whole-credential group grants covering current and future URL rules.
The connection-wide grant migration expands existing non-revoked partial-grant
snapshots without changing active/paused/revoked settings or credential status.
Back up the gateway database before a coordinated host/gateway upgrade.
Ownership reuses native AgentVault
users, mapped from stable NanoClaw installation/user IDs; those managed users
cannot log in to the headless gateway. **F12 copying is removed.**

The commands and per-group key-set workflow below describe the **published
vault-local implementation**, not the target revision-7 importer or a promise
to retain its APIs. Their metadata remains useful source evidence; do not
bulk-provision more duplicated values as the new migration strategy.
The working tree has removed `--provision`, the per-group provisioning module
and old credential-management commands. The retained inventory/`--prepare`
tooling only reads metadata or writes private review bundles. The vault-local
provisioning snippets below are an archived release reference, not commands
supported by the canonical host.

The target transition must:

- Keep working AgentVault groups, including Denis's Lab, on their current
  deployment until the coordinated replacement is ready; do not undo their
  cutover or delete entered values/sign-ins.
- Confirm each credential owner's native managed-user mapping and personal
  library. Do not infer ownership from a group's creator, display name or
  OAuth account email.
- Adopt existing gateway-held static/OAuth state in a reviewed offline
  conversion, preserving client/grant/resource/scope and refresh-token state.
  Rewrite group bindings and F8 references without runtime legacy aliases.
  Storage ownership changes alone must not force re-entry or re-consent.
- For remaining OneCLI sources, create a static connection once from a private
  operator-supplied value or authorize an OAuth connection once per intended
  owner/identity/scope profile. Attach only explicitly approved recipient groups.
- Preserve unknown/restricted-policy, conflicting-routing and existing-target
  blockers. Matching values/identities and safe scope unions are not established
  by matching names, email addresses or source IDs.
- Never copy live OAuth tokens into receiving vaults. Sharing references one
  connection's lifecycle; group detachment/deletion must not disconnect it.
- Use create-only/revision-checked transactions and safe receipts. Credential
  provisioning, sharing, OAuth consent and backend cutover are separate actions.
- Coordinate host, gateway, runner assets and schema, with consistent private
  backups and matched-state rollback. Do not negotiate or maintain old fork
  APIs, schema models, ownership paths or copy/fan-out implementations.
- Remove temporary conversion/import utilities and superseded fork code from
  the shipped runtime/maintenance surface after acceptance. Historical metadata
  bundles, protected rollback backups and receipts are not runtime compatibility.
- Complete workload/policy acceptance before retiring OneCLI. Remove its
  runtime/setup/networking/defaults and temporary migration dependencies only
  after no active group or host caller needs them.

## Deployed vault-local tooling

### Legacy runtime isolation during retirement

AgentVault container setup and the approval module no longer import the OneCLI
SDK eagerly. When both `ONECLI_URL` and `ONECLI_API_KEY` are absent, the
legacy approval listener stays disabled and AgentVault-only operation requires
neither the SDK at runtime nor a reachable OneCLI service. Stale approval cards
are still swept. Partial legacy configuration is reported explicitly; it never
falls back to the SDK's default cloud endpoint.

Existing OneCLI groups still require both settings and lazily load their
shared client on use. The dependency remains installed for those groups and
the metadata inventory tooling until their reviewed cutovers are complete.
This isolation does not retire groups, change backends or grants, or cancel
queued messages/tasks.

### New-group default and owner attachment

New groups now default to AgentVault. No connection is automatically granted,
including the installation owner's MiniMax connection. Owners add/select their
own connections in personal Credentials and explicitly attach them to agents.
First-login onboarding opens personal Credentials for AgentVault groups;
an empty agent credential view links to that same UI.

The database migration preserves every existing group's effective backend:
old implicit NULL selections and missing config rows become explicit `onecli`;
existing AgentVault selections remain unchanged. Only future rows default to
AgentVault. Legacy selections are stored explicitly, and metadata inventory
requires the migrated schema rather than misclassifying old NULL defaults.
Schema rollback requires the matching protected DB snapshot and host files,
not a binary-only downgrade. No existing group's credentials, grants or queued
work are changed by this migration.

### Approved archival retirement

Retirement is a separate, owner-approved operation, not a side effect of
inventory or inactivity. Before archiving, check running containers, every
recorded session's queued/paused work, approvals, questions, incoming routes
and filesystem availability. Rehearse archive/restore on a protected consistent
DB copy and retain matched private backups.

Use the existing group archive flow to preserve the restorable row snapshot,
group directory and session tree. Remove only the retiring agents' OneCLI
secret/connection grants and gateway group bindings; do not delete shared
credentials or disconnect their upstream accounts. Gateway revoked grant rows
remain for audit: verify no active/suspended grants, not physical row absence.
Restoring archived rows/history does **not** restore revoked external grants;
review credentials and explicitly authorize access before resuming the agent.

The approved 2026-10-30 retirement archived five groups and preserved all five
recorded sessions. The active fleet is now three AgentVault and six OneCLI
groups. Remaining group configuration and source grant metadata, native
connections/policies and OAuth state were verified unchanged. OneCLI must remain available for those
six groups until their reviewed cutovers and the sustained acceptance gate.

Three further groups completed reviewed cutovers on 2026-10-30, bringing the
active fleet to six AgentVault and three OneCLI groups. Isolated, network-disabled
containers verified actual model generation and authenticated MCP tool listing
through AgentVault only. All 158 affected session queues, questions, roles and
routing were preserved. The approved changes included direct MiniMax routing
instead of an unfunded OpenRouter route and removal of an unused Apify client;
the scheduled task remained paused.

The remaining Google-dependent groups require fresh, separate owner consent.
An identity-only Google grant is not sufficient for API migration. Preserve
reviewed API capabilities and verify actual granted scopes before cutover.
Overlapping OAuth destinations now require explicit group-bound
`Authorization: Bearer av-access:<handle>` selection; runtime discovery exposes
`access_placeholder` and `selection_required`. Missing or invalid selections
fail closed, and no caller gains access to another owner's management metadata.
Static credential destination conflicts remain rejected. Do not silently add
destination administration merely to make another owner's grant possible.

One more Google-dependent group subsequently completed owner consent, all seven
Google API metadata checks, model generation and private-journal MCP validation.
Its nine session queues, journal data and routing were retained; the explicitly
removed cross-owner legacy Google grants were revoked without changing the
other groups' source grants. The active fleet is now **seven AgentVault and two
OneCLI groups**, awaiting the second owner's Google/BananaBrowse authorizations.
Missing Docs, Sheets and Forms API enablement in the existing OAuth client
project was resolved before cutover. No journal contents or provider tokens
were exported for validation.

The Agent Vault canary is working. This tooling advances the remaining
per-group migration without copying credentials or changing live access.
Inventory and preparation remain read-only with respect to live access.
The separate, explicitly gated provisioning mode creates target key sets;
**no mode performs a backend cutover or retires OneCLI**.

## What it reads

Run from the checkout root:

```bash
pnpm exec tsx scripts/migrate-from-onecli.ts
pnpm exec tsx scripts/migrate-from-onecli.ts --group <group-id>
```

Default output is a JSON inventory on stdout. To retain it, use a private
directory and `umask 077` before redirecting output.

The tool reads:

- The central SQLite database with `readonly:true`: group IDs, names, effective
  backend (including the legacy env override), provider and MCP-server count.
- OneCLI's metadata-only `GET /v1/secrets`, agent identifiers, explicit grants
  and effective credential metadata, plus project-scope effective app-tool
  policies for the exact source agent. It does not retrieve secret values,
  OAuth tokens, container proxy credentials or saved credential stubs.
- Agent Vault's vault list, credential-key metadata and service definitions.

Only safe projected metadata and generated templates enter the report.
Arbitrary secret metadata, values and external-store references are discarded.
Agents are matched by exact group identifier, never display name or default
agent. Missing or ambiguous source agents require investigation.

Effective access determines the candidates; listing every secret in OneCLI
does not grant every group all of them. Blocked, limited, unknown and
non-effective credentials are not converted into usable target access.

## Reading the plan

Each group has a stable `digest`, required actions and these possible static
entry states:

| State               | Meaning                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `needs-value`       | Recognized metadata produced a template; the operator must supply its value separately         |
| `manual-review`     | Unsupported/incomplete metadata or overlapping source recipients; do not guess or merge values |
| `source-restricted` | Source effective access does not permit treating the credential as usable                      |
| `target-exists`     | An existing target key/service/recipient needs review; never overwrite it                      |

Generated key/service names are deterministic from the OneCLI secret ID.
Known single-header formats preserve their prefix. Pre-encoded Basic values
are not base64-encoded again. Anthropic API-key metadata can propose `x-api-key`;
unknown/OAuth modes need manual review. Query templates include an explicit
client-rewiring task: the existing query parameter must use the new placeholder.

OAuth connection entries require new vault-local authorization, not token
export. Several OneCLI connections may describe the same provider identity;
their counts are not counts of distinct people or final Agent Vault accounts.
Choose generic app configuration and requested scopes deliberately.

All plans have `policyReviewRequired:true` and `readyToCutover:false`.
Effective/grant metadata is not proof of parity for approvals, rate limits,
method/path conditions, network restrictions or host-side OneCLI callers.
The installed edition may not expose organization-policy enumeration. Do not
bypass that limitation or interpret missing visibility as no policy.

The digest covers captured source grant/effective metadata, the generated plan
and target metadata. It is not proof that secrets are unchanged or that hidden
policies were fully audited.

`appPolicies` records the supported project-scope effective policy for each
source provider and agent: tool verdicts and rate limits. Effective approvals,
blocks, mixed/unmanaged results, missing tool coverage and rate limits remain
explicit review blockers even when an attachment grant says `full`.
Metadata read failures are surfaced, not converted into an all-allowed policy.
The inventory does not query unavailable organization resources.
This evidence is per agent/provider, not proof of OAuth scope grants or
complete raw-HTTP/static-secret/connection-specific policy parity.

### Workload and overlap evidence

New inventories include safe per-client metadata: transport, recipient host,
query-parameter/header names, executable basename and credential/proxy/CA
environment-variable names. They do not export URL userinfo, paths, query values,
header/env values or command arguments. The configured provider remains a
configured value; a null row may inherit the runtime default and is not proof
that a group has no provider.

Client review flags distinguish query-placeholder rewiring, inline credentials,
proxy/CA overrides, dependency checks and network access. An HTTP endpoint can
require an explicit private-network decision. Reading metadata does not test
that endpoint or change the gateway allowlist.

`queryClientRewires` identifies parameters that must be **added** as well as
existing ones that must be replaced with a target placeholder. These are
host-based association hints, with `exactResourceMatchVerified:false`, not
proof that the original resource path matches a source route. No client URL
is rewritten by inventory or preparation.

`routingReviews` separates complementary headers on an identical recipient
from conflicting header selectors or different path patterns. A complementary
case may include a `serviceProposal` referencing **distinct** target keys.
This does not compare or assume equality of secret values. Complementary-header
proposals have `applySupported:true` because the conditional key-set API and
shared-service UI support their lifecycle. Explicit routing review is still
required before provisioning; conflicting/path-overlapping proposals remain
unsupported. Never send a composite proposal to a single-key or upsert API.

Matching OAuth labels are grouped only as `accountReviewGroups`, with
`identityVerified:false` and `scopeUnionKnown:false`. Labels are not stable
subjects: they do not prove that accounts can be combined or establish requested
scope unions. Actual issuer/identity and intended permissions need confirmation
at sign-in. These hints do not reinstate a provider permission catalog.

The additional evidence changes plan digests. Retain old review bundles as
snapshots; never edit them or silently reuse their confirmation for a new plan.

## Explicitly gated preparation

After reviewing a group's inventory, run:

```bash
pnpm exec tsx scripts/migrate-from-onecli.ts \
  --prepare --group <group-id> --confirm-group <same-group-id> \
  --expect-digest <reviewed-digest> \
  --out /absolute/path/to/a-new-private-directory
```

The command re-reads current metadata and requires the same plan digest.
It refuses missing/mismatched confirmations, already-migrated groups,
missing/ambiguous source agents, relative paths and existing output directories.
The parent output directory must already exist.

It writes only `bundle.json`, mode 0600, in a new directory, mode 0700. The bundle
states `purpose:"metadata-review-only"`, `liveChanges:false` and
`readyToCutover:false`. It can contain unresolved blockers; writing the bundle
does not resolve them or authorize import.

There is deliberately no `--apply` or `--yes`. Preparation does **not**:

- Create/change a live vault, credential or service.
- Change OneCLI grants or policy.
- Export/re-enter values or connect OAuth accounts.
- Change a group backend or its MCP configuration.
- Restart, stop, uninstall or retire either service.

Agent Vault's legacy service API is an upsert, not a create-only import
transaction. Preparation still uses local bundles rather than making an unsafe
check-then-upsert promise about concurrent edits.
The existing proposal mechanism is transactional but its `set` action also
upserts services/credentials; it is not a create-only alternative. An importer
must not assume conditional headers or create semantics that the server does
not implement.

## Inactive target and atomic provisioning

The approved conditional API is `GET|PUT|DELETE
/v1/vaults/{vault}/key-sets/{service-name}`. Use a compatible, verified gateway
release before provisioning; a missing endpoint is an error, never a reason to
fall back to upserts.

Prepare a vault without touching the backend:

```bash
pnpm ncl credentials target prepare --group <group-id>
```

In group settings → Credentials, “Prepare / open Agent Vault target” does the
same thing. The target banner explicitly says OneCLI remains active. Requests
use `?target=agent-vault`; without that explicit mode, OneCLI groups remain
backend-gated. Group-admin/host-only permissions are unchanged.

Single-key, OAuth app and sign-in operations are available in this target mode.
Install-wide OAuth app changes still affect other groups and require the
existing owner/global-admin permission; prefer a group override for an
intentional group-only change. OAuth callback state remains bound to its
initiating user and group; completion keys remain authoritative.
Returning to Keys/Accounts or using “Refresh credentials” reloads gateway
metadata. A popup wait timing out does not prove that provider authorization
failed; check the refreshed account list before starting another sign-in.

The shared-service dialog supports create-only creation, write-only per-key
rotation, routing edits and deletion of the entire set. Existing membership is
immutable, blank edit fields preserve values, and stale revisions require a
fresh review. Single-key row actions are not offered for shared services.
CLI equivalents are `credentials key-set get|create|update|delete`, with
`--name`, safe `--service` JSON, `--values-stdin`, exact `--revision` for
update/delete, and explicit `--target-only` while OneCLI is active.
Only one of `--value-stdin`, `--secret-stdin`, `--values-stdin` may consume stdin.

For batch provisioning, first obtain a **fresh** inventory after target
preparation, review its digest, and supply actual values keyed by generated
target key names through stdin:

```bash
pnpm exec tsx scripts/migrate-from-onecli.ts \
  --provision --group <group-id> --confirm-group <same-group-id> \
  --expect-digest <fresh-reviewed-digest> --ack-source-policy \
  --ack-composite-routing --values-stdin \
  < /secure/operator-supplied-values.json
```

Do not paste values into chat, argv, shell history, reports or bundle files.
The stdin JSON must contain exactly the selected keys. Each invocation accepts
at most 64 values; use `--services name-one,name-two` for a smaller batch.
Source-policy acknowledgement records a review decision, not a claim that
unavailable policies were audited or equivalent. Composite acknowledgement
authorizes distinct complementary headers, not value equality or precedence
parity. Restricted source entries are never promoted by either acknowledgement.

Every set uses `If-None-Match: *`. The vault lock and SQL transaction cover
collision checks and all its credentials/service together. Existing names/keys
return `412`; overlapping recipients or foreign references fail explicitly.
Sets are HTTPS-only: allowing private network dialing does **not** make an
existing plaintext HTTP MCP workload TLS-ready.

On failure, the command exits nonzero and prints a safe partial receipt with
completed sets and the failed service. Prior successful sets are not rolled
back or overwritten. A lost/malformed response may hide a committed set:
re-inventory and review; never assume that matching metadata proves equal
values. Select only still-missing sets on a later reviewed invocation.
`status:"complete"` means the selected static sets completed, **not** that the
group, OAuth accounts, clients or policy parity are ready. Receipts always
retain `readyToCutover:false`, `backendChanged:false` and `oneCliChanged:false`.

No values/tokens are exported from OneCLI. No provisioning operation changes
its grants, MCP configuration, active backend or running containers.

### Approved private-network mode

The operator approved removing the per-address allowlist for this deployment.
Its gateway environment now uses `AGENT_VAULT_ALLOW_PRIVATE_RANGES=true` and no
`AGENT_VAULT_NETWORK_ALLOWLIST`. This permits private/reserved destinations,
including loopback/link-local, but retains hard blocks on known IMDS endpoints,
per-dial DNS checks, TLS validation and per-vault socket isolation.
The Home Assistant host accepted a scoped TCP CONNECT; that was a transport
check without an application payload, not model/MCP acceptance.

## Before any live cutover

This deployed-workflow checklist does not override the revision-7 target
transition above. Use the reviewed contract for the binary being deployed,
not the old per-group provisioning flags against a shared-reference release.

The operator sequence remains:

1. Finish the compatible verified gateway release/pin and preserve the matching
   database/binary rollback path.
2. Select the group explicitly and review its source access and policy needs.
3. Resolve overlaps, unsupported injections and existing target state without
   assuming two keys have the same value.
4. Prepare the inactive target and use the explicitly reviewed, create-only
   provisioning workflow above. Do not temporarily flip its backend to enter
   values.
5. Enter values through a write-only operator path and reconnect accounts in the
   intended vault. Preserve or deliberately rewire client placeholders.
6. Validate actual model/MCP workloads and policy behavior before the separately
   authorized backend switch. Standing approval is not evidence that missing
   credential values, consent or workload checks have completed.
7. Complete the sustained acceptance period and audit host-side OneCLI use
   before removing its runtime/setup/uninstall dependencies.

Re-running inventory is read-only. Repeating preparation into a new directory
is harmless; an existing bundle is never silently replaced. Do not downgrade
the gateway binary without its matching state backup.

## OneCLI retirement dependencies

Removing a group's container dependency is not the same as removing every host
dependency. Before deleting OneCLI support, review these surfaces:

| Surface                                            | Required exit condition                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Container spawn and agent provisioning             | Intended groups use Agent Vault; default/new-group behavior is deliberately migrated                          |
| OneCLI approval bridge and pending responses       | Equivalent policy or explicitly accepted behavior; no pending credential approvals lost                       |
| Docker egress network and host-gateway helpers     | Remaining OneCLI container networking is no longer needed; Agent Vault isolation remains intact               |
| Setup, uninstall and channel/provider/tool recipes | Fresh installs and removal use the compatible gateway without affecting another copy                          |
| Runtime SDK/config and backend CLI/schema defaults | No remaining runtime consumer before removal; migration-only tooling must not keep a runtime dependency alive |
| Host-side public metadata                          | OpenRouter's public model catalog is unauthenticated and no longer requires OneCLI                            |

These are retirement gates, not permission to remove active paths. The current
dual-backend installation still needs OneCLI for its unmigrated groups.

## Batch the operator session

Before requesting consent or credential entry, assemble one current review:

- Fresh inventory digest and source-policy evidence, with unknown coverage clear.
- Routing conflicts and any composite-service lifecycle decision; never assume
  two stored values are equal.
- Client query/header/env rewiring tasks and offline dependency evidence.
- Required private-network access, distinguishing configured allowlist data from
  a successful scoped gateway test.
- Candidate account consolidation, with verified issuer/identity and intended
  OAuth scopes still requiring confirmation.
- Compatible gateway release/pin, backup and separate live-cutover approval.

Request real values only through a write-only local/UI path, never chat. Keep
private-repository checks outside acceptance until a target is explicitly
authorized. Code-only readiness work must not silently perform a live import,
scope change, allowlist change or backend switch.
