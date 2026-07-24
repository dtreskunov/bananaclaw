# Private web views and Pages

Status: proposed replacement for the current Secure Preview architecture.

This document describes a minimal web-serving architecture for two related
features:

- **Pages** publishes a directory as a stable, public, read-only website.
- **Private web views** run workspace HTML for an authenticated group member on
  a disposable, isolated origin.

Both modes use one static-file serving engine. They differ only in how a web
root is resolved, who may read it, which response policy applies, and whether a
request may replace workspace files.

The design intentionally gives private HTML read access to every
member-visible file in its agent-group workspace. This is a security compromise
made to remove directory-grant machinery and support reports and applications
that use shared workspace assets. Hidden and admin-tier files remain
inaccessible.

## Product model

There are three URLs involved.

### Public Pages URL

```text
https://<site-slug>.<PAGES_BASE_DOMAIN>/<path>
```

This is a stable, anonymous URL. It serves only the group's configured public
site directory.

### Private launcher URL

```text
https://<apex>/ui/view/<agent-group-id>/<workspace-relative-html-path>
```

This is the stable URL users open, share with other authorized group members,
and bookmark. It identifies a file, not an authorization grant. Every request
authenticates the current UI session and rechecks access.

Examples:

```text
/ui/view/ag-123/output/quarterly/index.html
/ui/view/ag-123/dashboards/budget.html
```

No `reports` table or saved-report entity exists. Moving or renaming the file
breaks the bookmark. That is an accepted consequence of using the filesystem
path as identity.

### Private execution URL

```text
https://secure-<random-id>.<PAGES_BASE_DOMAIN>/<workspace-relative-path>
```

This is a temporary implementation detail. The trusted launcher embeds it in
an iframe, but it is not presented as the canonical or bookmarkable URL.

Each launch receives a fresh random hostname. Different HTML files and later
visits therefore do not share DOM access, cookies, local storage, IndexedDB,
caches, or service-worker scope.

## Primary flows

### File-browser preview

1. The user selects a member-visible HTML file in the file browser.
2. The trusted chat client requests a private web session for the selected
   group and workspace-relative path.
3. The server authenticates the UI session, checks group access, validates the
  path, and creates a temporary private web session with member-level read and
  replace access.
4. The client embeds the redemption URL in the existing preview iframe.
5. The secure host redeems the one-time handoff, sets a host-only cookie, and
  redirects to the validated workspace-relative HTML path in the handoff
  URL's `next` parameter.

The file browser mounts the private-web controller directly. It does not embed
an apex shell inside another iframe.

### Open in new tab and bookmarks

The file browser's **Open in new tab** action opens the stable launcher URL:

```text
/ui/view/<group-id>/<path>
```

The launcher is a small trusted page that mounts the same private-web
controller used by the file browser. It obtains a fresh execution origin on
every visit while the address bar remains on the stable launcher URL.

If the UI session is missing, normal authentication preserves the launcher as
`next`:

```text
/ui/view/<group-id>/<path>
  -> /ui/login?next=<encoded-launcher-url>
  -> /ui/view/<group-id>/<path>
  -> fresh secure origin
```

There is no separate report-registration or bookmark API. A browser bookmark
is sufficient.

### Expired private session

The trusted controller owns renewal. When a private iframe expires, the
controller requests a new session for the same authorized path and replaces the
iframe URL.

If the parent UI session expired, the controller performs a top-level login
redirect preserving the stable launcher or chat URL. The private document does
not run OIDC inside its sandbox and does not silently mint grants for other
targets.

Direct visits to expired `secure-*` URLs may return `401` with a plain recovery
message. They do not need a database-backed consent recovery flow because those
URLs are not canonical bookmarks.

## One shared serving engine

Pages and private views use a common mechanism with separate policy resolvers.

```ts
interface WebRootPolicy {
  filesystemRoot: string;
  visibility: 'public' | 'member';
  cache: 'public' | 'private';
  capabilities: ReadonlySet<'read' | 'replace'>;
  csp: string | null;
  principal?: {
    userId: string;
    uiSessionHash: string;
    agentGroupId: string;
  };
}
```

The host first resolves a request to a policy:

```ts
resolvePagesPolicy(host)
resolvePrivateWebPolicy(host, secureCookie)
```

It then calls one shared file server:

```ts
serveWebRoot(req, res, policy)
```

The shared engine owns:

- URL decoding and path normalization;
- realpath containment and symlink-escape rejection;
- `GET`, `HEAD`, and policy-gated `PUT`;
- directory `index.html` resolution;
- MIME types and `nosniff`;
- file-size ceilings;
- `Last-Modified` and `ETag`;
- single-range requests;
- stream error handling;
- cache headers;
- audit hooks;
- conditional replacement for writable policies.

The policy resolvers own authentication, authorization, visibility, CSP, and
capabilities. Sharing the mechanism must not merge the trust policies.

## Pages policy

Pages remains stable, public, and cookieless.

```ts
{
  filesystemRoot: groupPublicSiteDirectory,
  visibility: 'public',
  cache: 'public',
  capabilities: new Set(['read']),
  csp: null,
}
```

Properties:

- The stable hostname resolves through `site_slug` and `site_enabled`.
- The filesystem root is the group's FQDN-named publish directory.
- Only files below that directory are reachable.
- Requests do not accept UI or private-web credentials.
- Pages does not expose same-origin filesystem mutation routes.
- Public HTML may use normal browser features because it has no private read
  authority.

The current Pages-to-apex credentialed CORS file API may remain temporarily for
compatibility. New administrative applications should edit through a private
web session. Once migrated, the Pages CORS exception can be removed.

Anonymous visitor submissions are not generic filesystem writes. If needed,
they should use a separate typed, validated, rate-limited submission API.

## Private-view policy

A private web session maps the URL root to the entire agent-group workspace:

```ts
{
  filesystemRoot: groupWorkspaceDirectory,
  visibility: 'member',
  cache: 'private',
  capabilities: new Set(['read', 'replace']),
  csp: privateWebCsp,
  principal: { userId, uiSessionHash, agentGroupId },
}
```

The entry document retains its full workspace-relative path:

```text
Selected file: output/quarterly/index.html
Execution URL: https://secure-<id>.<domain>/output/quarterly/index.html
```

Ordinary relative references continue to work:

```text
./style.css       -> /output/quarterly/style.css
../../shared.js   -> /shared.js
/datasets/q3.json -> /datasets/q3.json
```

This is the core simplifying compromise. There is no stored preview root, no
parent-directory calculation, no root-level HTML rejection, no multi-root
grant format, and no per-request containment beneath an artifact directory.
Containment is always against the group workspace.

Every private request still:

1. validates the secure session and hostname ID;
2. verifies that the parent UI session exists and is unexpired;
3. rechecks current group access;
4. resolves the requested path inside the group workspace;
5. rejects symlink escape;
6. rejects hidden and admin-tier paths using `classify()`;
7. records the access under the authenticated user and group.

Private HTML never receives owner/admin visibility. Administrators also see
only member-tier files through this origin.

Every private session is writable. Any user who can launch a private view can
conditionally replace existing member-visible regular files anywhere in that
group workspace. Viewing the HTML grants this authority without a separate
editing prompt. The policy does not permit creating, deleting, renaming, or
changing the visibility of files.

## Origin and session model

Each launch creates one temporary private web session identified by a random
192-bit hostname ID:

```ts
crypto.randomBytes(24).toString('hex')
```

The 48 lowercase hexadecimal characters fit in one DNS label after the
`secure-` prefix.

One database row can hold the complete temporary session lifecycle:

```text
id                      TEXT PRIMARY KEY
handoff_token_hash      TEXT NOT NULL
secure_token_hash       TEXT
parent_ui_session_hash  TEXT NOT NULL REFERENCES ui_sessions(token_hash) ON DELETE CASCADE
user_id                 TEXT NOT NULL REFERENCES users(id)
agent_group_id          TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE
created_at              TEXT NOT NULL
expires_at              TEXT NOT NULL
last_used               TEXT
redeemed_at             TEXT
```

This replaces separate roots, handoffs, secure sessions, and consent
challenges.

### Handoff

The trusted apex controller requests a session with an authenticated
non-navigation `POST`. The response contains:

```text
https://secure-<id>.<domain>/_auth/redeem?t=<one-time-token>&next=%2F<workspace-relative-html-path>
```

The issuance endpoint constructs `next` from the normalized selected path. It
is a local path on the new secure host, not an absolute URL, and is not stored
with the session.

The secure host atomically redeems the token, generates a secure cookie token,
stores only its hash, and sets:

```http
Set-Cookie: private_web_session=<token>;
Path=/;
HttpOnly;
Secure;
SameSite=Lax
```

The cookie has no `Domain` attribute. It is valid only on that random host.
The secure host obtains the group only from the redeemed session row. It
decodes `next` once, rejects schemes and network-path references, resolves it
inside that group's workspace, and requires an existing member-visible HTML
file before redirecting with `303`.

`next` is launch continuation, not authorization. A caller holding the handoff
may change it to another valid member-visible HTML file in the same group, but
that does not increase authority: after redemption the session can already read
and replace existing member-visible files throughout the group workspace. The
random single-use handoff remains the credential; the group ID is never
accepted from the redemption URL.

Suggested lifetime:

- 8-hour absolute expiry;
- 30-minute idle expiry;
- immediate cascade revocation when the parent UI session is deleted;
- current membership check on every request.

The stable launcher makes session recovery disposable: after login or expiry,
it creates a new row and hostname instead of recovering an old secure origin.

## Private CSP and iframe sandbox

Private HTML runs in an iframe with:

```html
sandbox="allow-scripts allow-same-origin"
```

The response header also applies:

```http
Content-Security-Policy:
  sandbox allow-scripts allow-same-origin;
  default-src 'none';
  script-src 'self' 'unsafe-inline' blob:;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  media-src 'self' data: blob:;
  font-src 'self' data:;
  connect-src 'self';
  frame-src 'none';
  object-src 'none';
  worker-src 'none';
  form-action 'none';
  base-uri 'none';
  frame-ancestors <configured-apex-origin>
```

`connect-src 'self'` is intentional. It permits applications to fetch JSON and
other member-visible workspace data from their own private origin. The other
directives block external scripts, styles, images, media, fonts, frames, forms,
workers, objects, and programmatic connections.

The iframe does not receive `allow-forms`, `allow-popups`, or
`allow-top-navigation`. Private code cannot navigate the trusted parent, open
authentication popups, or submit external forms.

Service workers remain disabled. Fresh random origins also prevent one private
application from retaining browser state that affects a later application.

These browser controls do not provide absolute network isolation. An untrusted
document can navigate its own iframe to an external URL and encode data in that
URL; the sandbox prevents top-level navigation, not navigation of the
document's own browsing context. Current browsers provide no dependable CSP
directive that closes this channel. `Referrer-Policy: no-referrer` should still
be applied, but the cross-origin parent cannot reliably inspect the iframe's
destination or prevent the request before it occurs. Deployments requiring a
hard no-egress boundary must not expose sensitive workspace-wide reads to
arbitrary HTML.

## Workspace writes

The same URL reads and replaces a workspace file:

```http
GET /<workspace-relative-path>

PUT /<workspace-relative-path>
If-Match: "current-etag"
Content-Type: application/octet-stream
```

Write semantics are deliberately narrow:

- replace an existing member-visible regular file only;
- require `If-Match`, returning `428` when absent;
- return `412` and the current `ETag` when stale;
- enforce workspace containment and reject symlinks;
- reject hidden and admin-tier paths;
- enforce body-size and rate limits;
- write a sibling temporary file and atomically rename it;
- return `204 No Content` with the new `ETag`;
- audit user, group, path, old hash, and new hash.

Creation, deletion, rename, directory creation, and arbitrary upload are not
supported. They may be added later only as separate methods with their own
authorization and validation rules.

`PUT` does not perform directory `index.html` resolution or redirects. The
request must name the concrete existing file, so `PUT /report/` is rejected and
`PUT /report/index.html` is valid. Authentication endpoints such as
`/_auth/redeem` are reserved and can never resolve to workspace files.

No CORS is required because the file and application share the disposable
origin. The URL accepts neither a group ID nor an absolute filesystem path.
The secure session cookie authenticates the request. `PUT` and the mandatory
`If-Match` header force browsers to preflight any cross-origin attempt. The
secure host emits no CORS permission, so another origin cannot invoke a write.

Writes apply the same checks as reads on every request: live parent UI session,
current group access, workspace containment, symlink rejection, and member
visibility. The target is resolved and revalidated immediately before the
atomic rename. `PUT` is denied on Pages hosts, unauthenticated secure hosts,
directories, and reserved host routes.

## Security compromise

The private origin is an untrusted-code boundary, not a directory privacy
boundary.

Malicious HTML may read every member-visible file in its group workspace. It
may inspect shared source, reports, datasets, notes, and uploads that are not
classified as hidden or admin-tier. CSP restrictions make routine exfiltration
harder but do not make broad reads harmless; malicious content can still
display, transform, socially expose, or leak data through self-frame
navigation.

Malicious HTML may also replace every existing member-visible regular file in
the group workspace. It can corrupt reports, application assets, datasets, and
other shared state under that visibility tier. `If-Match` prevents accidental
lost updates; it is not a permission boundary against code already running on
the private origin.

This risk is accepted because agent groups are treated as the primary read and
write trust boundary. Deployments that mix unrelated sensitive member-visible
content in one group should retain the existing directory-scoped model or use
separate groups.

The simplification does not compromise these boundaries:

- the authenticated apex UI remains a separate origin;
- each launch receives a fresh origin and host-only cookie;
- cross-group reads remain impossible;
- hidden and admin-tier files remain unavailable;
- traversal and symlink escape remain blocked server-side;
- common resource, form, and programmatic egress channels remain blocked;
- writes are limited to conditional replacement of existing member files;
- Pages remains public, cookieless, and read-only.

## Path handling

The launcher and secure server treat paths as untrusted input.

- Decode each URL segment once.
- Reject malformed escapes, NUL, encoded slash or backslash, `.` and `..`
  segments, and platform separators.
- Normalize to `/`-separated workspace-relative paths.
- Resolve through `realpath` and require containment in the group workspace.
- Classify the full group-relative path on every request.
- Do not treat knowledge of a launcher URL or secure hostname as authorization.

Launcher paths appear in browser history, copied URLs, reverse-proxy logs, and
UI access logs. Filenames must not contain secrets.

## Trusted controller

One private-web controller powers both UI surfaces.

### Embedded mode

The file browser supplies `agentGroupId` and `entryPath`. The controller:

- requests and refreshes private sessions;
- owns the iframe reference and sandbox flags;
- handles loading, `401`, `403`, and missing-file states;
- initiates top-level login when the UI session expires;
- refreshes after the trusted source editor saves.

### Standalone mode

The `/ui/view/<group>/<path>` page resolves the same two inputs and mounts the
same controller full-viewport. It adds only trusted shell chrome such as title,
refresh, return-to-files, and access status.

The controller does not synchronize arbitrary iframe navigation back into the
launcher URL in the initial implementation. Bookmarks identify the entry
document, not transient in-app navigation.

## Non-goals

- Durable report IDs, report metadata, aliases, or path-move tracking.
- Directly bookmarkable `secure-*` execution URLs.
- External network dependencies from private HTML.
- Anonymous writes from Pages.
- Generic server-side application execution.
- Cross-group asset loading.
- Admin-tier private previews.
- File creation, deletion, or rename through private origins.
- Using CSP as a substitute for filesystem authorization.

## Implementation plan

1. Extract MIME, range, path-resolution, index-file, and streaming logic from
   Pages and Secure Preview into a shared web-root server.
2. Add `/ui/view/<group-id>/<path>` and a reusable private-web controller.
3. Change secure execution URLs to retain the full workspace-relative path.
4. Replace directory-root grants with group-workspace member visibility.
5. Collapse root, handoff, session, and consent persistence into one temporary
   private-web-session table.
6. Move private-session renewal into the trusted controller.
7. Change private CSP to `connect-src 'self'` and retain the external resource,
   form, and programmatic egress restrictions.
8. Make file-browser **Open in new tab** use the stable launcher URL.
9. Add same-origin `PUT` on secure file URLs with mandatory `If-Match`, reusing
   the existing atomic workspace replacement and audit mechanics.
10. Keep existing Pages behavior on the shared server and reject writes on
  Pages hosts.
11. Retain the existing Pages CORS persistence path during migration, then
    remove or explicitly mark it as legacy.

During rollout, old secure URLs may continue using the existing directory
grant handler until their sessions expire. New launchers should use only the
new private-web session model.

## Validation

### Shared server

- Pages still serves only the configured public directory.
- Pages remains anonymous, cookieless, stable-origin, and read-only.
- Private views resolve against the group workspace.
- MIME, `GET`, `HEAD`, indexes, ranges, size ceilings, and stream failures work
  identically through the shared engine.
- Traversal, malformed encoding, and symlink escape fail for both policies.

### Private authorization

- Launcher requests require a valid UI session and current group access.
- The launcher accepts member-visible HTML only.
- Handoffs are random, hash-stored, exact-host-bound, short-lived, and
  single-use.
- Redemption accepts only a local `next` path resolving to an existing
  member-visible HTML file in the handoff's server-side group.
- Neither `next` nor any other redemption parameter can select a group.
- Secure cookies are host-only and root-ID-bound.
- Logout, parent-session expiry, group deletion, and membership removal revoke
  reads and writes.
- Hidden and admin-tier files return `404` for every role.
- Another group, secure hostname, or cookie cannot select the grant's group.
- Root-level HTML is allowed and receives only member visibility.

### Browser behavior

- File-browser and standalone launchers use the same controller.
- The standalone launcher remains bookmarkable across private-session expiry.
- Login returns to the launcher and creates a fresh random origin.
- Two launches receive different origins and isolated browser storage.
- Relative, parent-relative, and root-relative workspace assets load.
- Same-origin `fetch` can read member-visible JSON.
- External fetch, resources, forms, frames, workers, objects, popups, and top
  navigation remain blocked; self-frame navigation remains a documented
  exfiltration limitation.
- Desktop and mobile layouts render without overlap or overflow.

### Writes

- Every valid private session can call `PUT`.
- Pages hosts and unauthenticated secure hosts cannot call `PUT`.
- `PUT` addresses the same concrete file URL as `GET`; directory index aliases
  are rejected.
- `If-Match` is mandatory.
- Stale writes return `412` without modifying the file.
- Successful writes are atomic, audited, and return `204` with a new `ETag`.
- Hidden, admin-tier, missing, directory, symlink, oversized, create, delete,
  and rename attempts fail closed.

## Selected decisions

- Agent groups are the private read and write boundary.
- Private HTML can read and conditionally replace existing files throughout the
  member-visible group workspace.
- Stable bookmarks are path-addressed apex launcher URLs.
- There is no `reports` entity.
- Execution origins are random and temporary.
- Pages and private views share file-serving mechanics but not authorization
  policy.
- Pages is public and read-only.
- Private views are authenticated and can read or conditionally replace
  existing member-visible files throughout their group workspace.
- Private writes use `PUT` on the served file URL and require `If-Match`.
- Direct secure-origin URLs are not durable and do not need recovery records.
