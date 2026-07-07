# Per-group static websites (Pages)

Each agent group can publish a **public static website** on its own
subdomain. Files written into a specially-named folder in the group's
workspace are served, unauthenticated, over HTTP by the host's shared
server. This is the "GitHub Pages for agent groups" feature.

## How it works

- A group has two columns in `agent_groups`: `site_slug` (a DNS label) and
  `site_enabled` (0/1).
- When enabled, the group is reachable at
  `https://<site_slug>.<PAGES_BASE_DOMAIN>/`.
- The served files live in the group's workspace folder, in a sub-folder
  named **exactly** like the FQDN:
  `groups/<folder>/<site_slug>.<PAGES_BASE_DOMAIN>/`.
  Inside the container this is `/workspace/agent/<fqdn>/`.
- A request for `/` (or any directory) serves that directory's `index.html`.
- **Everything under the FQDN folder is public.** Nothing else in the group
  workspace (CLAUDE.md, container.json, skills, etc.) is ever web-reachable —
  only the FQDN-named subtree is rooted, and path traversal out of it is
  rejected.

The feature is **off unless `PAGES_BASE_DOMAIN` is set.** With it unset, the
host handler isn't even registered and the UI hides the website controls.

## Environment

Add to `.env`:

```sh
# Base domain for per-group websites. A group with site_enabled is served at
# <site_slug>.<PAGES_BASE_DOMAIN>. Leave unset to disable the feature.
PAGES_BASE_DOMAIN=bananaclaw.app
```

Restart the host after changing it so the new config and host handler load.

## Enabling a site

A **group admin** flips the "Enable website" checkbox in the group's web
settings (the per-group admin modal). On enable, a unique `site_slug` is
auto-allocated from the group name (sanitized to a DNS label, with a numeric
suffix on collision). Owners / global admins can also set the slug explicitly
in the same panel.

`ncl` / the central DB can set the same columns directly if needed:

```sh
pnpm exec tsx scripts/q.ts data/v2.db \
  "UPDATE agent_groups SET site_slug='goodnewsbot', site_enabled=1 WHERE id='<group-id>'"
```

## Publishing content

From inside the agent container, write files into the FQDN folder:

```
/workspace/agent/goodnewsbot.bananaclaw.app/index.html   → https://goodnewsbot.bananaclaw.app/
/workspace/agent/goodnewsbot.bananaclaw.app/style.css    → https://goodnewsbot.bananaclaw.app/style.css
/workspace/agent/goodnewsbot.bananaclaw.app/img/logo.png → https://goodnewsbot.bananaclaw.app/img/logo.png
```

The composed `CLAUDE.md` for any group automatically gains a "Static website
hosting" section (only when `PAGES_BASE_DOMAIN` is configured) telling the
agent how to publish and its live URL / enabled state — so agents discover the
feature without being told.

## Serving details

- Methods: `GET` and `HEAD` only (others → 405).
- Content types: full set (HTML, CSS, JS, JSON, wasm, fonts, images, audio,
  video, …). Unknown extensions → `application/octet-stream`.
- Single `Range` request support (media seeking), `206` / `416` as
  appropriate.
- `Cache-Control: public, max-age=60`, `Last-Modified`, `Accept-Ranges`,
  and `X-Content-Type-Options: nosniff` on every response.
- Per-file ceiling of 100 MB.

### Why running arbitrary HTML/JS here is safe

The UI session cookie (`ui_session`) is set **without** a `Domain` attribute,
so it is host-only and never sent to subdomains. A group website therefore
runs on a **cookieless origin** — it cannot read or ride the operator's UI
session — which is why HTML/JS is served with real content types instead of
being coerced to `text/plain`.

## Traefik configuration

The host's shared server listens on `0.0.0.0:WEBHOOK_PORT` (default `3000`)
and now routes by `Host` header for site subdomains. You need three things:
wildcard DNS, a wildcard TLS cert, and a wildcard router that sits **below**
the existing apex (UI) router in priority.

### 1. DNS

Point a wildcard at the host:

```
*.bananaclaw.app.   A   <host-ip>
bananaclaw.app.     A   <host-ip>
```

### 2. Wildcard TLS certificate

Wildcard certs require a DNS-01 challenge. Example static config
(`traefik.yml`), using Cloudflare as the provider:

```yaml
certificatesResolvers:
  le:
    acme:
      email: you@example.com
      storage: /etc/traefik/acme.json
      dnsChallenge:
        provider: cloudflare
```

### 3. Routers (dynamic config)

Keep the **exact-host** UI router at a higher priority than the wildcard
site router so the apex domain still serves the UI:

**Traefik v3** (`HostRegexp` uses Go regexp / named groups):

```yaml
http:
  routers:
    nanoclaw-ui:
      rule: "Host(`bananaclaw.app`)"
      priority: 100
      service: nanoclaw
      tls:
        certResolver: le
        domains:
          - main: bananaclaw.app
            sans:
              - "*.bananaclaw.app"

    nanoclaw-pages:
      rule: "HostRegexp(`^[a-z0-9-]+\\.bananaclaw\\.app$`)"
      priority: 10
      service: nanoclaw
      tls:
        certResolver: le

  services:
    nanoclaw:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:3000"
```

**Traefik v2** uses the older `{name:regex}` template syntax instead:

```yaml
    nanoclaw-pages:
      rule: "HostRegexp(`{subdomain:[a-z0-9-]+}.bananaclaw.app`)"
      priority: 10
      service: nanoclaw
      tls:
        certResolver: le
```

Notes:

- Do **not** add a `stripPrefix` / path middleware — sites are served from the
  URL root, and the host maps `Host` + path to the right file.
- The wildcard router forwards to the same `nanoclaw` service as the UI; the
  host decides (by `Host`) whether a request is a site or falls through to the
  normal UI mounts.
- If you front the host with a different reverse proxy (nginx/Caddy), the same
  rules apply: wildcard DNS, wildcard cert, and proxy `*.bananaclaw.app` to
  `127.0.0.1:3000` preserving the `Host` header.

## Relationship to file-share links

This is **separate** from the private file-sharing **link** feature (one-off
expiring `/dl` links backed by `ui_download_tokens`). Use links for private,
per-file shares; use Pages for a public site.

## Data persistence (the file API)

Pages is **static and public read-only** — no server-side runtime, no
database, and anonymous visitors cannot write. When a site needs data that
changes over time, keep it as files in the group folder and update them
through the authenticated file API (part of the web UI under `/api/groups/…`,
so it requires a logged-in **admin** UI session — never reachable by anonymous
site visitors):

| Method + path | Purpose |
|---|---|
| `GET /api/groups/<gid>/files/<rel>` | File bytes. Response includes an `ETag` (version token). |
| `GET /api/groups/<gid>/files/<rel>?meta=1` | Metadata JSON: `size`, `mtime`, `etag`, … |
| `POST /api/groups/<gid>/write` | Overwrite an existing file. Body `{ path, content }`. |
| `POST /api/groups/<gid>/upload` | Multipart upload; `?mode=skip\|overwrite\|rename`. |

A data file written into the FQDN publish folder is *also* served publicly as
a static asset, so a page's client JS can `fetch()` it for reads while the
agent/admin owns the writes.

### Optimistic concurrency (safe overwrites)

Reads (`GET …/files/<rel>` and `?meta=1`) return a strong `ETag` derived from
the file's size + mtime. Overwrites accept it as a precondition so a client
can only replace the exact version it last read:

- `POST …/write` — pass the token as an `If-Match` header or an `ifMatch`
  field in the JSON body.
- `POST …/upload` with `mode=overwrite` — pass the token as an `If-Match`
  header (applied per matching target).

If the on-disk version no longer matches, the write is rejected with **`412
Precondition Failed`** (the `write` op; the `upload` op reports
`precondition_failed` in that file's result entry) and the response carries
the current `ETag`. The precondition is opt-in: omit it for first-writer-wins
behavior (the prior default). Implementation:
[src/ui/server/chat/etag.ts](../src/ui/server/chat/etag.ts),
[src/ui/server/chat/write.ts](../src/ui/server/chat/write.ts).
