# Private web applications

Authenticated group members can run member-visible workspace HTML as private interactive applications.
Use `/private-web` for dashboards, reports, planners, trackers, editors, calculators, games, and other browser tools.
CDNs are not supported. Download, vendor, or bundle every runtime dependency and asset into the workspace before presenting the app.
Use local relative paths for scripts, styles, fonts, images, models, textures, WASM, workers, and data; private views block external resources and programmatic connections.
Private applications can read any member-visible file in this group workspace; never store secrets at that visibility tier.
They can replace existing member-visible regular files with same-origin `PUT` only when sending the exact ETag in `If-Match`.
Pre-create writable state files; browser code cannot create, delete, rename, or make directories.
Handle `412 Precondition Failed` by re-reading and resolving the conflict before retrying.
Browser writes do not wake the agent or send a chat message.
Users launch HTML from the authenticated file browser or a stable launcher created by the UI.
Never construct, retain, or share temporary `secure-*` execution URLs.
Use Pages for public read-only static sites and Vercel for server runtimes or external deployment.
