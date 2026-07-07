---
name: site-website
description: Publish a public static website on this group's own subdomain. Use when asked to host, publish, deploy, or share a website / landing page / homepage on the group's built-in subdomain (no third-party host needed). Static files only — no server-side runtime.
---

# Static website hosting (per-group subdomain)

This group can publish a **public static website** on its own subdomain.
Files in a designated workspace folder are served unauthenticated over
HTTPS — anyone with the URL can read them.

This is a **separate capability** from:

- **`vercel-cli`** (`/vercel-cli`): deploy to Vercel. Use that when the user
  wants Vercel specifically, or needs preview URLs / framework SSR / build
  steps. The current skill is for self-hosting on this group's own subdomain
  with zero build pipeline.
- **`mint_file_link` / private file-share links**: one-off expiring links
  for individual private files. Use those for private shares.

## Check feature state — read your config first

Read `/workspace/agent/container.json` and look at the `siteFqdn` field:

| `siteFqdn` value | What it means |
|---|---|
| missing / undefined / empty | Feature is **off** for this group — either the operator hasn't configured it on this install, or this group's "Enable website" toggle is off. You cannot enable it yourself. |
| a string like `"demo.example.com"` | Feature is **on**. You can publish. |

When off, tell the user the toggle is admin-only — a human admin flips
**Enable website** in the group's web settings (per-group admin modal). You
may still prepare files in the workspace so they're ready when an admin
flips the toggle. If they need a public site immediately, suggest
`vercel-cli` instead.

## Publishing — when `siteFqdn` is set

Derive the rest from `siteFqdn`:

- **Publish directory** (where to write files): `/workspace/agent/<siteFqdn>/`
- **Live URL** (where users see it): `https://<siteFqdn>/`

For example, if `siteFqdn` is `"demo.example.com"`, write into
`/workspace/agent/demo.example.com/` and the site is live at
`https://demo.example.com/`.

Steps:

1. Write your site files into that exact directory. The folder name must
   match `siteFqdn` exactly (the host serves files only from that
   FQDN-named directory; renaming it breaks routing).
2. `index.html` at the root of that folder is served at the bare URL.
   Subpaths like `about.html` and nested folders (`assets/css/main.css`)
   work the same way.
3. Everything under that folder becomes **publicly readable** the moment
   it's written — no separate publish/deploy step. There is no staging.
4. Commit your changes (see "Version control" below).

## Version control — keep the site in git

Treat the publish directory as a git repository so every edit is
recoverable. Do this on every change, not just the first one.

- **First time** (no `.git` inside `/workspace/agent/<siteFqdn>/` yet):
  initialize a repo at the root of the publish directory. Set a sensible
  default branch (`main`), add a `.gitignore` that excludes anything you
  don't want tracked (build caches, `node_modules/`, OS junk), then make
  an initial commit of the current contents.
- **Every subsequent edit**: after writing/replacing/deleting files, stage
  and commit with a short message describing the change (e.g.
  `update hero copy`, `add /about page`, `fix broken link in footer`).
  Run `git status` first to make sure you're not committing leftover
  build artifacts or accidental files.
- **Don't commit secrets or large binaries.** Same rules as the publish
  rules above — anything in the folder is publicly served, and committing
  it just bakes a leak into history. Add `.env*`, key files, and oversize
  blobs to `.gitignore`.
- **Don't push to a remote unless the user asked you to.** A local repo
  is enough for recoverability; remotes are a separate decision.

If the user asks you to undo a recent change to the site, use git to
revert (`git revert`, `git checkout <path>@<rev>`, etc.) rather than
rewriting from memory.

## Hard constraints — static only

- **No server-side runtime.** No PHP, Node, Python, databases, or anything
  that needs to execute on request. Only files served as-is.
- **Client-side JS is fine.** SPAs (React/Vue/Svelte/etc.), static-built
  Hugo/Astro/Eleventy output, plain HTML/CSS, WASM-backed apps, MDX-rendered
  static sites — all OK as long as the build output is plain files.
- **No build step is run for you.** If the user's source needs a build,
  run that build in the workspace yourself, then copy the output into the
  publish directory.
- **No secrets in the published folder.** Every file is publicly readable.
  Don't write API keys, `.env` files, private credentials, or anything else
  the user wouldn't want shared with the world.
- **Soft size limit.** Individual files are capped at ~100 MB by the host.
  Keep total bytes reasonable; this is shared infra, not a CDN.

## Need data persistence? Use the BananaClaw file API

Pages itself is static — the served folder is public **read-only**, there is
no database, and anonymous visitors cannot write anything. If the site needs
data that changes over time (a JSON feed, a small dataset a page renders, a
counter, saved state), keep that data as **files in your group folder** and
maintain them yourself. Two complementary access paths:

- **Publish for reading.** Write the data file into the publish directory
  (`/workspace/agent/<siteFqdn>/data.json`) and the page's client-side JS can
  `fetch('/data.json')` — it's served as a normal static asset. You can also
  just write it directly to the workspace filesystem yourself as the agent.
- **Update safely over HTTP.** The host exposes an authenticated file API for
  the group at `/api/groups/<groupId>/…` (part of the web UI, so it requires a
  logged-in UI session with **admin** rights — it is *not* reachable by
  anonymous site visitors). Use it when you or an admin tool need to update a
  file over HTTP rather than from inside the container:

  | Method + path | Purpose |
  |---|---|
  | `GET /api/groups/<gid>/files/<rel>` | Read a file's bytes. Response carries an `ETag` header — the file's current version token. |
  | `GET /api/groups/<gid>/files/<rel>?meta=1` | Read metadata JSON (`size`, `mtime`, `etag`, …) without downloading bytes. |
  | `POST /api/groups/<gid>/write` | Overwrite an existing file. JSON body `{ "path": "<rel>", "content": "…" }`. |
  | `POST /api/groups/<gid>/upload` | Multipart upload (new or existing files); `?mode=skip\|overwrite\|rename`. |

- **Don't clobber concurrent edits — reference the version you read.** Reads
  return an `ETag`. When you overwrite, echo it back so the write only lands
  if nothing changed underneath you:

  - `write`: send the token as an `If-Match` header **or** an `ifMatch` field
    in the JSON body.
  - `upload` (`mode=overwrite`): send it as an `If-Match` header.

  If the file changed since you read it (the agent, another admin, or another
  tab wrote it first), the server responds **`412 Precondition Failed`** with
  the current `ETag`. Re-read, merge, and retry — never blindly re-send. Omit
  the precondition only for a first-writer-wins overwrite you genuinely intend.

Read-modify-write pattern:

1. `GET …/files/state.json` → keep the response `ETag`.
2. Modify the parsed content.
3. `POST …/write` with `{ "path": "state.json", "content": "…", "ifMatch": "<etag>" }`.
4. On `412`, go back to step 1 with the fresh copy.

The same static-only rules still apply to anything you place under the publish
directory: it's world-readable, so never persist secrets there.

## Common patterns

- **Landing page from scratch.** Write `index.html` (and optional
  `style.css`, `script.js`) directly into the publish directory. Show the
  user the URL afterward.
- **Promote a build artifact.** If the user has a built site already (e.g.
  in `/workspace/agent/build/`), copy or rsync into the publish directory
  and confirm `index.html` is at its root, not nested.
- **Update an existing site.** Edit files in the publish directory
  directly; the changes are live immediately on the next request.
- **Share a one-off file with one person.** Don't use this skill — that's
  what `mint_file_link` is for.

## Failure modes to call out

- If `siteFqdn` is unset and the user really needs a public site now,
  offer `vercel-cli` as an alternative path.
- If the user expects authentication on the site, this skill cannot help —
  it's anonymous-public-read by design.
- If the user wants a custom domain (something other than the configured
  subdomain), this skill cannot help — slug allocation lives in the host
  admin UI, and only owners can override the slug.
