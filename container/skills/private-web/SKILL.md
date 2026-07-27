---
name: private-web
requires_env: UI_ENABLED
description: >-
  Build private interactive HTML applications in the agent workspace. Use for
  authenticated dashboards, interactive reports, planners, trackers, visual
  editors, calculators, games, or browser tools that read or persist private
  workspace data without a public deployment.
---

# Private web applications

Private web views run member-visible workspace HTML for authenticated members
of this agent group. Each launch uses a fresh isolated browser origin while the
NanoClaw UI keeps the user on a stable launcher URL.

Use this capability for private static applications that need browser-side
interaction or persistence. It is not a server runtime.

## Choose the right hosting mode

| Need | Use |
|---|---|
| Authenticated interactive app using private workspace files | `private-web` |
| Public static site on the group's built-in subdomain | `site-website` |
| SSR, server functions, framework hosting, external APIs, or Vercel specifically | `vercel-cli` |
| One private downloadable file rather than an app | `mint_file_link` from `web-ui` |

## Build the application

1. Create a dedicated directory under `/workspace/agent/` with an `.html` or
   `.htm` entry file. Root-level HTML also works, but a directory keeps the app
   and its state easy to identify.
2. **CDNs are not supported.** Download, vendor, or bundle every runtime
  dependency and asset into the app directory before presenting it. This
  includes scripts, ES modules, styles, fonts, images, audio, video, 3D models,
  textures, WASM, workers, and data. Use local relative or root-relative URLs;
  do not leave runtime references to jsDelivr, unpkg, cdnjs, Google Fonts, or
  any other `http://` or `https://` origin in HTML, CSS, imports, workers, or
  `fetch()` calls. External scripts, resources, frames, workers, forms, and
  programmatic connections are blocked; same-origin `fetch()` is allowed. Do
  not treat this CSP as hard network isolation: the document can still
  navigate its own frame to another URL.
3. WebAssembly runs, but the `.wasm` file must load from the workspace like any
  other asset. JavaScript `eval()` and `new Function()` stay blocked, so avoid
  toolchains and glue code that rely on them. Web workers are unavailable, so
  choose single-threaded builds.
4. Treat every member-visible workspace file as readable by the application.
   Never place secrets in member-visible files. Hidden and admin-tier files are
   unavailable from private web origins.
5. Pre-create every file the browser must persist. A private app can replace an
   existing member-visible regular file, but cannot create, delete, rename, or
   make directories.
6. Scan the final HTML, CSS, and JavaScript for remote runtime URLs and replace
  each one with a local asset. Build responsive loading, empty, error, save,
  and conflict states. Verify the app in a real browser at desktop and mobile
  sizes before presenting it.
7. If the app takes input from a link or bookmarklet, read it from
  `location.hash`. See "Receive input from the launcher URL" below.

## Read and persist workspace data

Read a concrete file URL and retain its `ETag`:

```js
async function readJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Read failed: ${response.status}`);
  return {
    value: await response.json(),
    etag: response.headers.get('ETag'),
  };
}
```

Replace that same file with the exact non-wildcard ETag:

```js
async function writeJson(path, value, etag) {
  const response = await fetch(path, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': etag,
    },
    body: JSON.stringify(value, null, 2),
  });
  if (response.status === 412) return { conflict: true, etag: response.headers.get('ETag') };
  if (!response.ok) throw new Error(`Save failed: ${response.status}`);
  return { conflict: false, etag: response.headers.get('ETag') };
}
```

Rules:

- `If-Match` is mandatory. Missing or wildcard preconditions return `428`.
- A stale version returns `412` without changing the file. Re-read, merge or
  ask the user which version to keep, then retry with the current ETag.
- A successful replacement returns `204` and a new ETag.
- Address the concrete file, such as `/apps/budget/state.json`; directory index
  aliases are read-only conveniences and are not valid write targets.
- Browser writes do not send a message or wake this agent. Read the file on a
  later turn, poll it from a scheduled task, or add an explicit messaging flow
  when the agent must react.

## Receive input from the launcher URL

The launcher URL is the stable, shareable entry point:
`https://<ui-host>/ui/view/<agent-group-id>/<path>/index.html`. Its **fragment**
reaches the application; its **query string does not**, because the private
session redirect only carries the target path. Read parameters from
`location.hash`:

```js
const params = new URLSearchParams(location.hash.slice(1));
const url = params.get('url');
```

Deep links and bookmarklets therefore use `#`, never `?`:

```text
https://<ui-host>/ui/view/<agent-group-id>/<path>/index.html#url=...&title=...
```

Name the entry file explicitly. Directories are not rewritten to `index.html`.

A `javascript:` bookmarklet only needs to open that URL with an encoded
fragment:

```js
javascript:void(window.open("<launcher-url>#url="+encodeURIComponent(location.href)+"&title="+encodeURIComponent(document.title),"_blank"))
```

Rules for bookmarklets:

- Encode only the values. Percent-encoding the `#`, `&`, or `=` delimiters turns
  the whole tail into a path segment and returns `404`.
- Do not pass `noopener` or `noreferrer` to `window.open`; either one makes it
  return `null`.
- Never try to reach the application with `postMessage` from the opener. The
  application runs in a nested isolated origin that the opener cannot address
  reliably. The fragment is the supported input channel.
- Confirm the exact launcher URL with the user rather than guessing the UI host.

## Present it to the user

Tell the user which workspace HTML file to open. If they need browser access,
run `web-ui` and call `request_login_link`; once signed in they can select the
HTML file in Files and open its private view. The UI also provides stable
private launcher links for opening or sharing with other authorized members.

Never construct, save, or share a `secure-*` hostname. Those execution URLs and
their cookies are temporary implementation details owned by the trusted UI.
