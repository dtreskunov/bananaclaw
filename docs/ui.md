# Web UI

Optional read-only web UI mounted on the existing webhook HTTP server under `/ui`. A shared auth shell (`/ui/auth/*`) hands out a single bearer-cookie that's reused by every UI app. Today the only app is the **chat** app at `/ui/chat`; more apps will live alongside it.

### Conversation protocol

The chat client uses versioned atomic conversation snapshots/updates, with
explicit turn identity and durable settlement. Host, runners, session stores
and browser assets must match; there is no old-client compatibility path.
Reload cached clients after a deployment. Going back to the pre-turn protocol
is a snapshot restore: see [downgrade-to-v3.md](downgrade-to-v3.md).

Missed frames, unknown streams, and revision gaps require an actual authorized
resnapshot. Disconnect or confirmed runner exit disables controls, but never
fabricates a final response, completion time, or billing record. Silent turns
remain visible without synthetic output. At the same host revision, reducing
incremental frames yields the same conversation as a fresh snapshot.

> Per-agent-group **public static websites** (served by `Host` on the same
> listener) are documented separately in [pages.md](pages.md).

## Enable

Set in `.env`:

```bash
UI_ENABLED=true
```

Restart the host. The routes are mounted on the webhook listener (default `0.0.0.0:3000`).

## Configuration

| Env var       | Default                               | Purpose                                                                                                                                        |
| ------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `UI_ENABLED`  | `false`                               | Mount the UI shell and every registered app.                                                                                                   |
| `UI_SECURE`   | `false`                               | Mark session cookies `Secure`. Set when fronted by HTTPS (reverse proxy, ngrok, etc.).                                                         |
| `UI_BASE_URL` | `http://localhost:${WEBHOOK_PORT}/ui` | External base URL embedded in magic-link URLs. Override when the host is behind a reverse proxy or tunnel (e.g. `https://bot.example.com/ui`). |

## Getting a login link

**From chat (self-service)** — any user wired to the bot can DM:

```
/web-login
```

The host intercepts the command (before it reaches the container) and replies with a one-time link. The link expires in 10 minutes and is consumed on first redeem. The resulting session cookie is valid for 30 days, `Path=/ui` so it covers every app.

**From the host (operator)**:

```bash
ncl users issue-link --user <userId>
# optionally --base-url <url> to override UI_BASE_URL for this call
```

`<userId>` is the user UUID from `users.id`. Look one up with `ncl users list`, or resolve from a channel handle via the `identities` table: `ncl exec 'SELECT user_id FROM identities WHERE channel=? AND handle=?' --args tg,6037840640`.

After redeem the browser lands on `/ui/chat/`. Log out via the button in the header (`POST /ui/auth/logout`).

## Apps

### Chat (`/ui/chat`)

In-browser chat + read-only browser for the per-agent-group filesystem at `groups/<folder>/`.

#### Startup conversation

A fresh visit without a thread in the URL opens a blank web conversation instead
of the most recent thread. A group or file link keeps its group, file, and panel
state while opening the blank conversation. As with **New thread**, an existing
empty web thread is reused.
On mobile, the header includes a **+** (**New thread**) button immediately left
of the agent-group dropdown, so opening a blank conversation does not require
opening the thread drawer. It uses the same action as the thread rail and is
disabled until an agent group is selected.

The selected thread is written to the URL, so refreshing stays in that
conversation and explicit thread links still open the requested conversation.
Blank conversations are remembered in the tab's browser history until a warmup
or send creates their server session, so refreshing before typing also keeps
the same conversation.
Switching agents after startup continues to open that agent's most recent thread.

#### Intent-triggered thread warmup

Opening a new thread only allocates its ID and messaging-group context. The
first non-empty composer edit (including pasted text), accepted attachment
(upload, paste, drop, or capture), or voice recording starts the session's
container in the background. Focus alone and editing an already-submitted
message do not warm a thread. This applies only to empty web threads.

The client sends one `POST /api/groups/<groupId>/chat/<threadId>/warmup` per
thread during the page's lifetime. The endpoint checks normal web-send
permissions, resolves the same session used by submission, and invokes the
existing container wake path. It creates no message, title request, model
call, or conversation turn. Send never waits for the warmup HTTP request:
concurrent wakes share the existing startup promise, and failed or deferred
warmups leave normal submission unchanged. Warmup failures are logged rather
than interrupting composition.

Navigating away does not cancel startup. The empty session remains listed as
`(new thread)` and is reused on return; New thread also reuses an existing empty
entry. Ordinary admission, idle eviction, and idle cleanup govern its container.
No lease, special promotion, or speculative worker pool is involved. Deleting
a thread waits for its outstanding warmup before deleting the persisted session.

#### Thread-list scanning

Thread-list statistics are read by one lazy, persistent Node worker, not on the
host event loop. Sync, thread listing, search scoping, and push-title lookup share
this scanner. SQLite connections are worker-local, read-only, and closed after
each session scan; the runner's private database is never read.

Concurrent identical requests share one scan. The worker retains up to 1,024
session/routing results and rescans sessions marked dirty by committed message,
usage, title, or task changes. Invalidations coalesce until the next request;
an older in-flight scan cannot clear a newer invalidation. Central session,
wiring, identity, and fork metadata are read afresh on the host, with visibility
rechecked after scanning. Adapter connectivity is not cached.

Cached results expire after 60 seconds even when accessed repeatedly, so
out-of-band database edits are reconciled on a subsequent refresh. No persistent
summary table or migration is involved. Pending scans are bounded to 32 requests
with a 30-second deadline; worker failures reject requests, and a later request
starts a fresh worker. Thread-list/search failures return an explicit 503 rather
than an empty successful result. Push titles log failures and retain the existing
group-name fallback.

#### Startup recovery

The chat shell displays a loading screen before JavaScript or account data
finishes loading. Account and group requests have a shared 10-second timeout.
Temporary network or server failures show an error and **Try again** instead
of leaving an empty screen. Startup retries every five seconds while visible,
and immediately when connectivity returns, the app becomes visible, or the
page is restored. Concurrent retry triggers share one attempt; background
retries pause while hidden. Recovery listeners and timers stop after successful
startup. Authentication failures still redirect to sign-in with the original
URL, including the selected thread, preserved.

#### Appearance

In **My Profile / Settings → Appearance**, choose **Default** or **Autumn**,
and independently select **System**, **Light**, or **Dark** mode. Default /
System follows the OS color mode, including the black dark-mode background.
Default light mode uses opaque secondary text, solid blue action fills with
white labels, and darker status and syntax colors so they remain readable on
white surfaces and tinted message, code, and table backgrounds. Essential
control borders and focus rings use stronger colors rather than decorative
separator tints. Autumn uses parchment and copper in light mode, and walnut
and amber in dark mode.

The message composer and question-answer input share a rounded, theme-colored
outline: subtle at rest, stronger on hover with a mouse, and full-strength while
the text input or any control inside has focus. A solid theme-colored backplate
fills the outline and its gap, preventing the transcript pattern from showing
through. The composer and agent-selector header cast theme-aware shadows over
the transcript. Only the header's decorative shadow is layered; the header
itself does not create a stacking context, so account menus and dialogs remain
above the side panes. Outline changes do not shift the layout. Keyboard-focused buttons
retain their individual focus indicators, and reduced-motion preferences disable
the outline transition.
Composer controls use matching side and bottom insets (3 px on desktop, 2 px on
mobile); single-line inputs keep the same clearance above the buttons in both
text densities.

**Text density**, below Mode, offers **Comfortable** (larger text and more
breathing room) and **Compact** (smaller text and tighter spacing). Both use
locally bundled Figtree at weight 300 with 0.015em letter spacing. Compact is
the default and uses 15 px text with 1.3 line height while preserving the
tighter layout spacing. Comfortable uses 16 px text with 1.5 line height and
increases chat message gaps from 6 → 10 px, message padding from 6/10 → 10/14
px, and paragraph spacing from 8 → 12 px, alongside roomier spacing in lists,
menus, previews and settings. The selector includes a live sample message and
thread row. Markdown list items are separated by 4 px in Compact and 6 px in
Comfortable, without widening operational lists such as activity traces.
Ordered lists reserve 32 px in Compact and 35 px in Comfortable so markers
through at least three digits remain inside message bubbles; bullet lists keep
their 20 px indentation.
Density is independent of theme and mode, applies across the app, and does not
restyle embedded websites, PDFs or media. Pane widths, conversation width limits
and icons stay unchanged; existing touch targets never shrink and mobile text
inputs remain at least 16 px.

Changes apply immediately, including to the open settings dialog, and are
saved in this browser (`localStorage`, key `nanoclaw:appearance`, version 2).
Version-1 preferences migrate automatically, preserving theme and mode and
adding Compact density.
They synchronize across tabs on the same origin, not across devices or
accounts. System follows OS changes live; explicit Light / Dark overrides the
OS. Storage failures show an error while leaving the current in-memory
selection usable. Invalid saved preferences are diagnosed and cleared.
Themes affect application chrome, not embedded or user-authored websites.

Density changes preserve drafts and expanded panels. A conversation already
following the bottom stays there; otherwise the first visible message retains
its viewport offset through reflow (clamped if the content no longer overflows).
The change does not mark existing messages as new.
The appearance controller captures reading position before changing CSS and
restores it immediately and after composer autosizing; new scrolling cancels
the deferred restore. Density changes do not animate text or spacing.
Shared density tokens live in `global.css`, separately from theme colors.

Oversized message bubbles scroll internally. Their total height, including traces,
metadata, attachments, and actions, is capped at the transcript viewport minus
its floating dock and one line of edge spacing at the top and bottom. New
responses start below the header so the entire bubble fits above the composer.
Small messages and task/branch event pills keep their natural size.

The transcript is one full-height native scroller, with a faint, theme-aware
diagonal cross-hatch background attached to its scrolling content. Its scrollbar
spans the same area, including behind and below the floating composer.
There are no fades or navigation arrows on the transcript itself; header and
composer shadows separate the fixed controls from the scrolling content.
There is no JavaScript background-scroll synchronization.
The composer, status, and question prompts overlay the bottom of the scroller;
their measured height reserves scroll space and limits oversized bubbles so the
latest response stays readable above them. The overlay leaves the native
scrollbar accessible. User and agent reply bubbles and the composer input keep
solid, unpatterned backgrounds, so scrolling inside a long message is visually
distinct from scrolling the transcript.

Only the inset content scrolls and receives edge fades; the bubble's padding,
solid background, and rounded corners stay unchanged when scrolling starts.
Edge fades span up to three text lines, capped at 30% of the content viewport
per edge. This keeps truncation visible across blank-line and paragraph gaps
while leaving a clear reading area in small bubbles. Overflowing content
supports keyboard focus and scrolling; search
navigation reveals matching text inside them. Copy still includes the complete
message, not just its visible portion. There is no separate full-message reader.
Edge tracking reads only enabled scroll axes and updates fade classes only when
an edge changes. Focusability and accessibility attributes update only when
content starts or stops overflowing, not on each scroll event.

The cap follows window, composer, question-dock, and text-density changes. On
mobile, the existing VisualViewport sizing shrinks the transcript when the
keyboard opens and expands it back when dismissed. Ordinary re-renders preserve
internal reading positions, with browser clamping if content no longer overflows.

Markdown messages containing tables use the full conversation width. Tables
retain readable, non-wrapping cells and scroll horizontally inside the message
when their intrinsic width exceeds the viewport. Tables throughout the UI share
the same subtle row and column borders, darker theme-aware header background,
and faint even-row stripe. A short fade marks each edge that has additional
horizontally scrolled content. Tables scroll horizontally by default;
exceptional fixed-layout tables can opt out with `data-table-scroll="off"`.
Non-standard transcript entries share a subtle inset provenance rail without
changing their geometry. Tool, file and card output uses an accent
rail; runner notices and internal traces use a neutral rail; warning and failed
message state use semantic warning and error rails. Normal agent replies have
no rail. Live turn-system status is intentionally transparent and rail-free.
Queued user input keeps its normal bubble styling without a transient left
rail; its queue status and actions remain in the metadata row.
Runner-authored notices use the same background as agent replies, but retain
the neutral or semantic rail and omit a redundant status label from the
metadata row.
Live in-progress turn-system bubbles use the full transcript width and remain
transparent in every theme and color mode, whether their activity is collapsed
or expanded. Settled turn-system bubbles remain content-sized. Timing and model
All bubble status-line entries stay on one line, including outcome, provenance
and token-availability labels. Flexible metadata text truncates when
space is limited; timestamps and trace controls retain their size. Inline metrics
keep labels and values on one line and scroll horizontally when needed. The live
progress-summary row places Stop between the bouncing dots and label text;
the controls keep their size while long labels truncate.
Activity trace previews and expanded rows use the same small type scale as
status metadata so operational detail remains secondary to message content.
Actions and repetition counts use the UI font; tool names, paths, commands,
and title arguments use inline-code styling in individual rows, chapter
headers, and the latest-activity hint.
Activity uses expandable **chapters** of consecutive related steps, without
reordering or omitting activities. Chapter headers have filled dots on a
continuous rail; child steps are indented with smaller hollow dots and branches.
Singleton steps stay directly on the rail. Only one chapter can be expanded at
a time. Opening via either **N steps** or the live activity summary expands the
latest step's chapter, scrolls to its header, and leaves step details collapsed.
The latest chapter stays open when its
latest step completes and when another related step is appended; it switches
only when the next entry belongs to a different chapter. Subsequent steps'
details never open automatically. At most one chapter and one step's details
are open within a trace. Explicitly opened latest details remain open while
that step updates, but collapse when the next step arrives.
Reveal operations scroll only the trace viewport: short details are shown
fully, while oversized details align at their beginning so the header remains
visible. Selecting steps, browsing chapters or collapsing the latest chapter
is respected until a new step arrives; then its chapter expands automatically,
with details collapsed. Scrolling does not change expansion.
Any number of Steps and Stats sections can be expanded at once, independently.
Each kind stores its open owner IDs with a mode (`follow` or `open`); chapter
and step selection are local to the mounted trace.
Opening a section on a live (or starting) response makes it follow: when the
next response starts, from the moment its message is sent, the section moves
to it. Opening a section on a settled response pins it there. Opening a section
never closes another, and closed sections stay closed.
With technical information on, the first live response in a conversation
(the starting row of the first send, or a live turn when the conversation
opens) opens its Steps in follow mode, unless the user already toggled Steps in
this conversation. Stats never open on their own. Activity, accounting and
terminal outcomes do not open, close or move panels.
Completing the turn does not close its panels or its expanded chapter.
Same-step status/accounting updates and same-turn reconnect snapshots preserve
local selections; conversation navigation resets both disclosures.
Each logical turn has one complete activity trace. Steering, questions, and
intermediate assistant outputs never split it. While running, a synthetic
bubble below the turn's latest conversation content carries the trace and
Stop control. On settlement, the trace attaches to the final response; if
there is no final response, it stays on the synthetic bubble. Intermediate
`send_message`/`send_file` output is not a final response.
The durable settling phase keeps the existing live presentation without a
transient "Finalizing turn" notice; completion remains gated on settlement.
Transient runner-disconnection, stopping and Stop-error notices appear in the
live turn's regular footer and trailing trace marker, not separate transcript
rows. The disconnect text is **Runner disconnected**. Notices clear when the
active state changes; settled outcome notes remain with their original turn.
Notice layout changes keep bottom-following viewers pinned; readers scrolled
up into history retain their position.
The trace uses its turn as the owner, so expansion survives movement between
the live bubble and a response. Moving the live bubble preserves local group
and step selection; moving onto a response resets them.
On completion, the trace stays expanded with every group collapsed,
and the transcript scrolls the response's top into view instead of following
its bottom. Reconnect snapshots clear transient trace state. Completion
scrolling applies only to observed updates, not initial history loads or
reconnect snapshots; outputless turns retain their trace without inventing a
response to scroll to.
Submitting a message scrolls to the transcript bottom and clears any previous
search-result highlight so the authoritative input echo cannot pull the viewer
back into history. Cancelling a steering/queue choice preserves the draft,
highlight and scroll position. A rejected send retains the draft and attachments.
Question activity comes only from the recorded `nanoclaw.ask_user_question`
tool call; question cards do not synthesize a second action in the trace.
Current tool captions remain in the status line instead of duplicating recorded
entries as standalone rows after their chapters.
Every trace opens with one display-only start row whose label follows the turn's
startup: **Queued…** from submission until the runner picks the turn up (no
stopwatch), **Preparing…** until the first model call can start (its CPU time),
then **Thinking…** while that call's AI time ticks on it, and **Started
response** once later work or settlement closes it. Queueing counts toward the
turn total only. The row counts as a step and is not stored. Settled traces otherwise contain only
recorded activities, with no synthetic **Done** entry. Completion and notable outcomes remain in the regular status footer;
completion does not imply that the requested work succeeded. Transient notices
do not count as activity steps or enter the runner journal, stored activity or
usage accounting. The step-count disclosure is hidden when there are no recorded steps.
Questions use their stored output-to-turn associations, and question cards never
own separate traces. Missing output or turn references are explicit projection
errors; reads never infer ownership or synthesize historical turns. Legacy imports
must establish canonical associations before their data is served.
Headers show the group heading and outcome notices. Recorded file targets and
arguments shared by every entry can appear in the heading; a differing last
argument is not presented as the whole group's target. Child labels omit the
parent's repeated verb and are indented 20 px beneath the chapter label.
Each grouping pass parses entries once and prepares their displayed headlines.
Expanded bodies are formatted only when the individual row opens, not for
collapsed chapters or headline previews. Rows and the latest-activity preview reuse this presentation,
including raw-text fallbacks. This does not change chapter categories,
compact child wording, repetition counts, or expansion behavior.
The response row prepares its chapters once per activity snapshot and shares
them with the preview and trace list. Stopwatch ticks do not regroup unchanged
activity. Connection/Stop notices append only their own standalone chapter;
they do not reparse the recorded entries.
Exact timestamps, status and duration share one line with dot separators when
a step is expanded; full arguments and errors appear beneath.

Each row shows execution time, model time, its timeline marker, then its label.
The two compact right-aligned time columns are sized to their widest value so
each kind lines up across rows and chapter headers. The columns have no headers;
each value has its full name as a hover hint. **CPU** (execution time) shows tool
and compaction time, live from the moment a step starts, and stays on completed
rows. **AI** (model time) shows the model calls that the row's step prompted.
The runner records a hidden `model` activity step for each finished model call
that reports its duration (`duration_api_ms`). A call is attributed to the step that most recently
finished before it started, or to the start row if none had; several calls can
share one row, so the number of rows with AI time can be lower than **Model
calls**. After the last call, the time since the latest step or call ends is shown
live on that step's row until the next step or the reply. Turns recorded
before model steps existed show no AI time. Runner overhead between calls is not AI time; the usage
details count it as **Other**. A finished time that would display as **0.0s**
(including no attributed time) is left blank; the empty cell keeps the columns
aligned, and live stopwatches still count up from zero. Times are plain
tabular numbers without outlines. **CPU** uses a muted warm tint; **AI** uses
the theme's model-time color (`--activity-model-time`), which the usage
details' **Model** time shares. Live times tick themselves and show tenths
below 10 s, then whole seconds. Chapter execution time merges the children's
execution intervals: overlap counts once, gaps count zero, and active calls
extend to the current time. Two overlapping 3-second commands spanning 4 seconds
therefore show 4 seconds, not 6. Reported durations without usable timestamps
remain included, but their overlap cannot be inferred. Chapter AI time remains
the sum of its children's attributed model time, plus any live tail.
Blank or malformed activity timestamps never start a live stopwatch or supply
an inferred epoch-zero interval. Recorded durations remain included in chapter
and response totals when their position is unknown; a numeric `0` is a valid
timestamp. Model calls without a usable timestamp do not end preparation.
Chapter and response execution totals use the same interval-union calculation;
the chapter adds a live tail, while the response total clips running calls to
its current clock. Model-time attribution remains separate and unchanged.

Chapter wording follows its latest step: **Editing files / Edited files**
and **Running command / Ran command**. Repeated groups append **· N times**;
single entries omit the repetition suffix. These counts describe operations,
not identical arguments: existing consecutive grouping remains unchanged.
Consecutive changes to one recorded path name that file and retain the operation
count, such as **Edited `path` · 4 times**. Otherwise file headings count
distinct recorded paths when all targets are known; incomplete records do not
invent a file count. Standalone steps, chapter headers,
and child rows share a compact 28 px rhythm. Earlier failures remain counted even
after later successes. Queued, running, completed and failed states use
theme-aware colors, interrupted states use warning colors, and unknown outcomes
are muted. Accessible labels and expanded metadata convey status without
relying on color. Historical unfinished steps become **Outcome unknown**, not
successful or still-running steps.
Standalone entries use filled timeline dots; child entries use smaller hollow
dots and branch connectors. Chapters use a right-pointing chevron when collapsed
and a downward chevron when expanded. Rails and per-tool Stop controls stay in
the timeline column immediately after the two stopwatches. Expanded child
details align with their indented labels.
The activity viewport scrolls vertically, and horizontally when row or chapter
labels are wider than the transcript, so long labels stay readable on narrow
screens. Expanded details wrap within the table instead of widening it.
A running step's **Stop tool** button appears once it has run for one second,
including while its details are expanded. It replaces the step's timeline node:
a small outlined square with a stop icon in the step's status color. It cancels only that
tool call; the turn, other tools, queued inputs and response continue normally.
The separate **Stop response** control in the status row still cancels the
entire turn. Per-tool Stop currently requires the native provider's live
`supportsToolCancellation` capability; unsupported providers show a disabled
tool control rather than falling back to turn cancellation. Recorded durations remain visible after
completion. Full labels remain available through accessible labels and expanded
details. Hidden vertical edges use the same 12 px transparency fades as tables.
Expanded command bodies and metadata wrap within the viewport and share its
scrolling, without a second nested scrollbar.

Every registered `nanoclaw.*` builtin has action-specific trace wording across
queued, running, completed, failed and uncertain states. For example, a completed
email call reads **Emailed `recipient`**; expansion includes its subject and
attachment paths. Messages name their destination, files name their paths,
reactions name their emoji, task actions name their task ID or scheduled time,
and title changes name the title. Cards name the card and question calls name
the question. A completed question call reads **Requested an answer to `<question>`**,
not receipt of an answer; the answer arrives in a later turn. Agent, package, MCP-server and link actions say
**Requested …** where completion only confirms submission to the host or an
approval flow. **Emailed** confirms the email tool accepted the request, not
delivery to the recipient.

Providers capture only a per-tool allowlist of primary and supplementary
arguments. Expansion preserves literal multiline subjects and questions.
Message/email bodies, scripts, agent instructions, MCP commands/arguments,
credential environment variables/headers and generated URLs are not captured.
Metadata is bounded to 2,000 characters per field. Existing stored events are
not backfilled; missing arguments are not guessed. Consecutive grouping and
whole-turn ownership remain unchanged; differing targets yield a target-free
group heading such as **Sent message · 2 times**, with individual targets below.

Thread-title actions read **Set title to TITLE**. New runner events retain the
title argument; historical events without it say **Set title** and explain the
missing recording when expanded. TODO updates read **Updated TODO items** and
expand into a checklist with item statuses and recorded priorities. Unrecognized
legacy TODO details remain visible as raw text. The same chapters are used for
live and completed traces, and remain gated by **Show technical information**.
Themes define the font family, body and heading weights, and UI letter
spacing through `--font-ui`, `--font-weight-body`,
`--font-weight-heading`, and `--letter-spacing-ui`. Density defines the
font-size scale and `--line-height-ui`, so typography can be tuned without
coupling the color theme to Compact or Comfortable spacing.

Theme values live in
[`default.css`](../src/ui/client/chat/src/styles/themes/default.css) and
[`autumn.css`](../src/ui/client/chat/src/styles/themes/autumn.css). Theme
metadata lives in [`appearance.ts`](../src/ui/client/chat/src/appearance.ts).
To add a theme, add its registry entry, import its CSS in `global.css`, and
define common typography/radii plus `[data-theme="<id>"][data-mode="light"]`
and `dark` token branches. Override all theme-sensitive values, including
surfaces, text, borders, solid actions and their foregrounds, selection
washes, focus rings, status colors, shadows and syntax highlighting. Keep
responsive layout and touch-target sizes shared. Check text contrast at 4.5:1
and essential control boundaries/focus indicators at 3:1.
The blocking `dist/appearance.js` script runs before the stylesheet in the
chat shell to prevent wrong-theme and wrong-density flashes. The main bundle reuses its
controller, and the service worker caches the bootstrap for offline loads.
Rebuild browser assets with `pnpm --dir src/ui/client/chat run build` after
editing theme definitions or appearance logic; the watch script watches both
the app and the bootstrap.

#### Conversation layout

Normal message bubbles use at most 90% of the conversation column. On desktop,
the column and composer share a 760 px maximum and the same centered gutters,
defined once by `--chat-max` / `--chat-gutter` in
[`ChatMain.css`](../src/ui/client/chat/src/components/ChatMain.css). Mobile keeps
its existing 90% bubbles and 12 px composer gutters.
The normal composer placeholder uses the selected agent group's display name,
such as **Message Denis's Lab…**, and follows group switches and renames. While
group metadata is unavailable it uses **Message the agent…**. Editing, pending
question-dock and reconnecting prompts retain their specific wording.

#### Access and file browsing

**Full-screen previews.** The file-preview toolbar offers **Full screen preview**
for documents, source files, images, PDFs, HTML pages and attachments, audio,
video, and unsupported/error previews. It opens the same dialog chrome as
**My Profile**: edge-to-edge on mobile and a large centered panel on desktop.
The toolbar, breadcrumbs, and metadata are hidden in full-screen mode, leaving
the content and dialog header. Content has no outer pane margin or border;
embedded previews run flush to the content area's edges. Readable text, source,
editors, and lyrics retain internal padding and a centered `80ch` maximum width;
images, embedded pages, PDFs, and media can use the available space.
The same preview stays mounted while switching modes, preserving unsaved
edits, media position, embedded-page state, and expanded metadata. The dialog's
Close button, Escape, or Browser Back returns to the inline preview without
discarding an edit. Closing the file also exits the
dialog. Returning inline restores the toolbar, breadcrumbs, and metadata.

**Access model.** A user sees an agent group if either:

- the user has an `owner` or `admin` role for the group (or globally), or
- the user is listed in `agent_group_members` for the group.

Web chat threads are shared by every user who can access the agent group. All
members can list, read, and send messages in every web thread; only owners and
admins (global or scoped to the group) can delete a thread. Human messages keep
their sender attribution in both history and live updates.

Historical normal human message bubbles include an icon-only **Edit** action for starting a new
branch with that message copied into the composer. It is not restricted to the
original author, so another participant with access to the agent group may use
it; the newly sent revision is attributed to the editor. The client branches
after the preceding conversational message so the original remains only in the
source thread. Editing the first message starts a blank web thread instead.
Historical attachments remain in the source thread and are not copied into the
composer. Read-only channel threads offer Edit only for that first-message
blank-thread case. Branch and historical Edit show an explanation before making
the copy. Opening a branch scrolls its inherited conversation to the end and
focuses the composer; historical Edit also places the copied text there without
sending it.

On mobile, transcript bubble actions stay hidden until the user taps that
bubble. Tapping another bubble moves the actions there; keyboard focus also
reveals them. The metadata row reserves the actions' vertical touch-target
height so revealing them does not resize the bubble. Desktop continues to
reveal actions on hover or focus. User-message timestamps stay anchored to the
left while actions occupy the right side of the row.

**Appearance → Transcript details → Show technical information** controls technical
details on all bubbles: activity trace, elapsed time, recorded activity count,
cost, and context use. Expanded trace and usage panels have a solid theme-colored
background in both live and completed turns, so the transcript pattern does not
show through. Technical information occupies a separate line at the top of live,
reply and display-card bubbles, including system-generated warning/error notices
and attachment-only replies, and is absent when the toggle is off. A settled
turn's final response owns its trace and usage inside that bubble, regardless of
who generated it.
Live turns, questions, and turns with only intermediate tool deliveries or no
final response keep their separate turn row. The regular information line
remains at the bottom and retains relative timestamps and message provenance.
The disclosure is labelled **5 traces** (or **1 trace**), counting recorded
trace entries, not model requests or exclusively tool calls; display-only markers
are excluded. The count does not repeat in its adjacent summary, which shows
available fields in the order `15s · $2.09 · 35% ctx`. Elapsed time appears here
only after the turn settles; running, stopping, and settling turns retain timing
in the live stopwatch and inline usage details, not the trace status summary.
Elapsed time uses the trace time format (tenths below 10 s, then floored
seconds, `11m 50s`, `1h 1m`), so it always equals the details' **Total**. Missing fields and zero
cost are omitted from both the summary and the details. Total cost is
shown only when every usage report includes cost; context is the latest reported
valid context/window pair, not cumulative billed tokens. Context is read from
the same usage record as the token and model-call counts, which the runner
rewrites after every model call, so it updates live with them. The tokens
column shows **Context utilization** (`54.8k tok · 5%`: the latest call's whole
prompt plus its reply, and its share of the window); the model column shows the
window itself as **Context size** (`1M tok`). An incomplete or invalid
report retains the latest known valid measurement, and a report without a
context window still displays its token count. The inline details show three unlabeled columns (timing,
tokens and model) side by side on one row, inside a single outline sized to
their content; a narrow screen scrolls them horizontally. Values are
left-aligned. Token counts use the `tok` unit; with several
accounting reports, the token and model columns show a **Usage report N**
subheading for each.
The summary is a chevron toggle styled like the adjacent **trace** disclosure,
retaining its duration/cost/context label. It opens detailed metrics inline at
the top of the activity panel, not in a pop-up. Metrics and trace expand
independently: either or both can be shown, including metrics on turns without
recorded activity, on any number of turns at once.
Selection survives live-to-settled handoff and same-turn reconnects. Metrics
follow and pin exactly like Steps (see the activity trace section above):
following persists through settlement until the next response starts or the
metrics are closed and reopened on a settled turn. Metrics can inherit their
open state before accounting arrives, appearing when usage is available. Closed
panels stay closed, and conversation navigation resets both. Both disclosures
are accessible only when technical information is on.
Expanded metrics use the available bubble width, placing multiple label/value
pairs side by side when there is room and returning to a single pair per row
on narrow layouts. All rows and reports share the same responsive column tracks;
Total, Model, and Other time stack in the first column without indents. Remaining
metrics pack into the available cells around them, with empty cells only at the
end of the grid. Sparse reports use fewer columns to avoid interior gaps.
Labels and values each stay on one line. Oversized values scroll horizontally
within the metrics panel rather than wrapping or being clipped. Individual report
headings occupy a metric cell so multiple reports can share the compact layout.
Usage on a running turn does not add an awaiting-final-totals notice; partial
reports still retain their warning.
Live turns without a recorded model call hide the usage disclosure; their
stopwatch and any activity trace remain available until accounting arrives.
Missing token accounting does not add a "Tokens unavailable" label to the
transcript. Partial records show only reported values; a record with no summary
values still offers **Usage details** for inspecting its available timing and
accounting. Completed turns do not show standalone outcome labels or a **Done** label.
**Stopped by user**, **Ended with a warning**, **Interrupted; outcome unknown**,
and **No reply** appear at the end of the owning activity trace, derived from the
existing settled outcome and end time without changing the journal. A recorded
stop entry is reused rather than duplicated. Display-only outcome entries do not
increase the recorded-entry count; a trace containing only an outcome still offers
the **trace** disclosure.
Future provider failures and failure-explanation
attempts are recorded in the activity trace, including whether model output or
a system notice was recorded. A model-written acknowledgement remains a normal
assistant bubble and does not change the failed outcome. Historical
failure-explanation attempts are not inferred or backfilled.
Live rows order the bouncing dots, Stop, stopwatch, and current
activity text. Only pending or running activities drive that text; when none
remain, it returns to **Thinking…**. Before any recorded activity arrives it
mirrors the open start row (**Queued…**, **Preparing…** or **Thinking…**).
An activity finishing does not mask another activity that is still running.
Completed, failed and interrupted entries stay in the trace, not in the live
status text.
Native web-chat submissions display their user bubble immediately, using the
existing client-generated message identity to reconcile the server echo without
duplicates. An idle submission also shows **Queued…** in the response
status slot before the real turn exists. This display-only phase survives HTTP
acceptance and the initial generic queued receipt, then hands the same bubble
over to the authoritative turn's start row. Stop is visible but disabled
during startup, and the stopwatch runs from submission. When the durable turn
appears before its live connection state, Stop stays in place but remains
disabled until the live ID matches the displayed turn. It then follows the
existing permission/connection checks; the stopwatch keeps measuring from the
server's receipt of the submitted message. The startup marker
is synthetic and does not contribute to the step count or enter conversation records.
Starting and real-turn presentations use one stable response component and shared
trace/footer markup, so the handoff does not remount the bubble or its controls.
If the current live turn arrives before its input association, the host anchors
its status after the latest visible timeline entry until its own anchor is known.
This prevents the status from briefly moving above the message history; historical
and settled turns retain their existing placement.
Startup uses the same controls rather than empty layout slots, keeping the
headline aligned on desktop and coarse-pointer devices. Markdown link, image, and
search setup and submit/bottom-follow scroll corrections run before paint;
browsing history and completed-response anchoring keep their existing policies.
The real-turn presentation receives a
non-null turn; startup never needs a placeholder turn.
Submission retention and startup visibility derive from one classifier, but
remain separate decisions: an unconfirmed follow-up still retains its payload
without displaying another Starting bubble.

Real queued follow-ups and steering retain their authoritative captions; they
do not create another startup bubble while a turn is active. A failed send stays
visible with its error and **Retry**, preserving the original message identity,
text, attachments and queue/steering intent. Submission releases the captured
composer draft immediately, but never replaces a newer draft on failure or
acknowledgement. An authoritative echo confirms acceptance even if the HTTP
transport subsequently fails.
Fresh sends and retries share the captured-packet transport; retry does not
rebuild the original payload or resolve queue/steering intent again. Only failed
submission states carry an error. **Send** always creates a new message identity
and resolves current queue/steering intent, even for identical text and attachments.
Only the failed bubble's **Retry** reuses its original identity and intent.
When delivery is uncertain, use Retry rather than Send to avoid submitting a
duplicate; the inline failure guidance explains this distinction.

While live, Thinking and current tool captions are shown in the footer without
adding trace entries. Stopping, disconnection and Stop errors still get a
transient, display-only notice in the trace. The notice clears when its condition
ends and never enters the durable journal.
Stop errors use a red failed marker, without
changing the durable activity or the still-running turn's outcome. Concurrent
tool calls retain their individual lifecycle colors: a completed call is green
even while another call remains blue. Execution concurrency depends on the
provider, model and tools; adjacent calls alone are not proof of overlap.
Stopping/disconnect notices and Stop errors occupy the same footer text slot,
not separate transcript rows. Errors retain their alert role and retry control.
Current activity remains visible with technical information hidden. The toggle
does not change status font size or the font used for inline-code subjects.
The stopwatch uses the trace time format (tenths below 10 s, then
seconds and minutes) and remains in the regular footer while the turn is live,
whether technical information is on or off. While the trace is expanded, the
footer omits the current activity text that the trace already shows. The technical summary omits inline timing.
The timing column lists **Total**, **Model**, **Tools** and **Other**, all in
the trace time format; **Model** uses the same color as the trace's **AI** column. Tools is the time with at
least one tool running (overlapping tools count once; live tools count to now).
Model is the cumulative time requesting and streaming model responses,
excluding tool execution and waits for user input. Native measures it with the
SDK's model-call performance callback, including compaction calls; OpenCode uses
each assistant message's created/completed times. The Claude SDK reports no
per-call timing, so the runner times each call from when its prompt went out
(the user's message or the previous tool results) to when its message arrived.
Other is Total minus tool and model time, clamped at zero, and covers runner
overhead such as container startup, prompt assembly, history loading and
message delivery (listed in its hover hint). Total uses the authoritative logical turn,
not the provider attempt's duration. Providers and older records without
isolated timing explicitly show **unavailable** for model and other time, never
substituting wall time or zero. Model, Tools and Other rows that would show
**0.0s** are omitted; Total is always shown.
The tokens column shows input and output processing (`55.0k tok in · 485 tok out`), then reasoning, cache
read and cache write when non-zero, then context (`55.4k tok / 1M tok (6%)`).
The model column shows the model, context size, the model-call count, and cost
(**Estimated cost**, or **Reported cost** for partial usage) only when it is
non-zero; zero or missing cost is omitted.
Live model timing reflects reported calls so far, not a second running stopwatch.
Stopped/failed calls retain reported timing alongside partial usage; unfinished
calls without a usage report cannot provide a complete model-time total.
Technical information and the expanded trace form one shared, compact block at
the top of live, reply and display-card bubbles, before their content. This keeps
header-to-trace spacing consistent without accumulating card-content gaps or
mobile footer touch-target spacing. Synthetic status markers never inflate its
step count; a live status preview can still reveal the current marker when the
zero-step disclosure is hidden.
It is off by default, including for preferences migrated from older versions.
Live bubbles retain essential progress feedback and Stop controls. Notable
completed outcomes such as failures, warnings, interruptions, and silent turns
remain visible even when technical details are hidden.

An isolated production-component fixture covers initial Thinking, running and
completed tools, two simultaneously running calls and one parallel call already
completed, long activity text, stopping/disconnected/settling states,
immediately visible simulated Stop failures and real simulated retry handling, final
replies without recorded steps,
replies, outputless turns, failures and display cards. Idle and busy submission
scenarios exercise the production composer, retry action and queue/steering
dialog. Chapter scenarios advance through a running step, completion, a related
step and an unrelated step without resetting follow intent:

```bash
pnpm --dir src/ui/client/chat run build:turn-status-fixture
```

Open the content-hashed `/ui/chat/dist/turn-status-fixture-<hash>.html` URL printed
by the build command on this host; the document hash includes both script and
stylesheet references, so CSS-only changes also invalidate cached fixture pages.
Its technical-info toggle is page-local and does not save preferences.
Send and Stop are simulated through the real UI actions; every other fetch is
explicitly blocked. In the submission scenarios, **Accept send** / **Fail send**
resolve HTTP independently of **Echo message** and **Start response**, allowing
both HTTP-first and echo-first validation without contacting a real conversation.
The fixture can
advance the same turn into a reply to verify trace ownership and frozen elapsed
time across settlement. Generated fixture assets are ignored and rebuilt from
`src/ui/client/chat/fixtures/`.

Your own pending native web-chat messages instead offer an **Edit** icon
while the connected runner advertises input editing. This changes text in place,
preserving attachments, ordering, message identity, and steering/queue intent;
it uses the main composer without creating a branch. The composer shows a
checkmark save button and an explicit **Exit edit** action. Your unsent composer
text and attachments are parked and restored after save or exit. Attachment
changes, uploads, and recording are disabled during editing. Other authors' messages and
external-channel pending messages cannot be edited in place. Queued, steering,
processing, and applied inputs never offer historical branch-edit, including
applied steering after the response finishes.

Save waits for durable runner confirmation. Conflicts, consumed inputs, and
disconnects show an inline error and retain the draft even if its pending status
changes. **Retry save** reuses the request identity for the same text. If a save
is still pending or its outcome is unknown, the draft is locked until that
request is resolved: retry checks the existing request rather than starting
another edit. **Exit edit** restores the unsent composer draft and keeps the
pending edit draft available on reopening; it cannot withdraw a save already
submitted, which may still apply. Drafts and requests remain scoped to their
original conversation across navigation.

Pending Edit (pencil), Cancel (trash), and Copy share the same icon-button group
and hover/focus styling as historical branch/edit/copy controls. Pending controls
remain visible on desktop and mobile without hovering or tapping the bubble.
Waiting-to-steer and queued captions use the same muted, italic metadata styling
as **mid-turn update** while retaining their status wording.
Tooltips and accessible labels identify each action;
Cancel retains its cancelling/retry state, and cancellation errors remain visible
outside the action group.

The bubble's **Cancel** action removes only your own queued or waiting-to-steer
input, and only when the connected native runner advertises cancellation.
It never stops the active response. Cancel waits for authoritative confirmation;
the ordered conversation update removes the bubble. Command HTTP replies do not
overwrite transcript data, so a delayed reply cannot revert a newer edit or
cancellation. An ambiguous response or
network failure leaves it visible with **Retry cancel**, reusing the same request
ID. Consumed-input conflicts keep the bubble visible. An unresolved edit blocks
cancel, and an unresolved cancel blocks edit, until the original request resolves.
Reconnect history replaces the visible web transcript, so a cancellation missed
while offline still removes its bubble. Redacted cancellation tombstones in
history and scoped sync are authoritative: their matching bubbles are removed,
while merging a snapshot does not discard unrelated absent optimistic inputs.
Confirmed cancellations also leave conversation-scoped client tombstones.
Duplicate versioned updates do not replay mutations.
Only the matching send acknowledgement is cleared; unrelated optimistic sends
and unsent composer drafts/attachments are retained.

Admin-tier files (`container.json`, `bot.json`, `allowed-senders.txt`) are visible only to admins. `.git`, `node_modules`, `.claude-fragments`, dotfiles, and the composed `CLAUDE.md` are always hidden. `CLAUDE.local.md` is visible read-only.

On mobile, file-browser rows follow the thread rail's two-line hierarchy: the
filename is the primary line, while modified time and size share a compact
secondary line. Search results place their relative path at the start of that
secondary line. Desktop file rows keep this information on one line.
Checkboxes, type icons and the actions menu remain outside the text block.
Thread-browser rows use the table alternate-row color while preserving stronger
hover and active states.

**Inline preview** in-browser:

- Images (`png`, `jpg`, `jpeg`, `gif`, `webp`)
- Audio (`mp3`, `m4a`, `aac`, `wav`, `ogg`, `opus`, `flac`)
- Video (`mp4`, `mov`, `webm`, `ogv`)
- PDFs
- Text (`.txt`, `.md`, `.json`, `.yaml`, `.log`, `.csv`, source code, etc.)

Everything else falls back to a download link.

### Steering a native response

Queued follow-ups appear as ordinary input bubbles at the bottom of the
conversation, below the active response and its Stop control. There is no
separate queue area: a subtle bubble footer shows status and **Edit** / **Cancel**
when available. They remain there through Stop until the runner consumes them.
At consumption each input moves into the transcript after the preceding
response and before its own response, once its durable position arrives.
A processing acknowledgement arriving before that position leaves it in the
bottom position with editing disabled. Durable logical positions preserve this
ordering on refresh, even when sent timestamps are identical; timestamp labels
still show the original send time. Older messages retain chronological ordering.
An initial idle message is not a follow-up merely because it briefly has queued
status. Waiting-to-steer input also appears at the bottom; applied steering
returns to its position in the current transcript.
When the provider confirms injection, the activity trace records a
**Steering message injected** step immediately after that input's recorded
consumption position. It remains in the saved trace after completion.
The stored notification is displayed as **Considered `<steering text>`**.
Expanding it shows the multiline text,
subject to the normal 2,000-character activity-detail cap.
Submitting, accepting, or queuing steering alone does not create this step.

Promoting an input preserves its attachments and pending editor: unsaved drafts,
in-flight saves, retry identities, and composer conflicts survive movement within
the conversation.

Sending text, dictation, or attachments while a native response is running in
the same web conversation offers **Steer current turn** (focused by default)
and **Queue for later**. Cancel, Escape, or dismissing the dialog keeps the
draft, files, and pinned context. Other providers keep their existing send
behavior. External-channel conversations do not show this choice; eligible
native inputs are steered automatically by the runner.

Both choices capture the active turn ID. If that turn finishes while the
dialog is open, steering becomes a follow-up rather than targeting a new
response. Shared sessions never steer a different conversation's response.
Capability comes from the running turn, not the group's saved provider setting.

Inbound bubbles show **Queued** with a distinct inset accent, **Waiting to
steer**, or **Applied to current turn**. Only a durable runner receipt confirms
application; an HTTP response or message echo does not. Queued/waiting captions
clear when processing starts, while applied provenance and explicit follow-up
outcomes remain in history. Receipts restore after reconnects and on external
conversation refreshes.

The web send endpoint accepts optional JSON `inputHandling: { mode:
"queue" | "steer", turnId?: string }`; multipart sends carry the same object as
a JSON-encoded `inputHandling` field. Steering requires a captured `turnId`.
The host validates send access and the matching live turn's capability, and
preserves stale targets for safe follow-up handling. A `clientMessageId` remains
stable across retries after ambiguous network/server failures.

### Stopping a response

Trace-row **Stop tool** and status-row **Stop response** are separate actions.
Per-tool requests include both the authoritative turn ID and tool call ID; stale
or finished targets cannot stop a different call or the entire turn. HTTP
acceptance means the active provider accepted a per-call cancellation request.
The tool button remains pending until authoritative activity reports the tool's
outcome. Errors, lost connections and unconfirmed cancellation are shown on
that row and can be retried without cancelling the response.

Both actions share HTTP request and error parsing in
`src/ui/client/chat/src/stop-request.ts`. Their state lifecycles remain separate:
tool cancellation has a confirmation timeout, while an accepted turn Stop waits
for durable settlement without timing out.

The live activity ("thinking") bubble has a small square **Stop** icon at the
right end of its metadata footer, matching the branch button on completed
responses. It has no visible text; its tooltip and accessible label identify
the action. It remains available while the activity trace is collapsed and stops only that
response, including a response waiting on a tool. The composer, Send/Enter,
attachments, and dictation remain unchanged: you can still enqueue follow-ups.
Queued messages are not cancelled and run afterward.
Sending queued or steering input does not hide or retarget Stop: it remains
bound to the actual active response, even when the newest bubble is your input.
Steering accepted but not yet applied is preserved as a follow-up after Stop.
When the next queued response starts, Stop targets that new turn instead.

Questions are not cancelled by Stop. They remain actionable in the input dock, and submitting
an answer is ordinary new input (or a queued follow-up). You can stop the
resulting turn after answering. If the agent has finished asking a question and
is only waiting for your answer, there may be no active turn to stop.

Questions and responses are separate durable events: the original question output
keeps its identity, timestamp, recorded position and asking-turn association;
the answer input has its own identity, timestamp and consumed-input position.
The host orders both normally and never relocates the question. Asked events
never render transcript cards. Outstanding questions replace the ordinary
composer in a bounded, scrollable input dock below the transcript, with choice,
text and dictation controls, plus an explicit **Skip** button beside the question
text, without a separate title. Multiple questions keep their recorded order.
Question text and answer choices use solid theme foreground/surface pairs rather
than translucent accent text. Choice labels retain at least 4.5:1 contrast in both
themes and color modes, including hover and disabled states; outlined choices
also keep a visible keyboard-focus ring.
Freeform answers use the same textarea, dictation and send controls as ordinary
composition, including density/width-aware autosizing. Question textareas grow
to fit the entire answer; only the outer question dock scrolls. The ordinary
message composer keeps its 200px height cap and inner scrolling. Desktop
Enter submits; Shift+Enter and mobile Enter insert a newline. Enter during IME
composition does not submit either editor.
The ordinary composer stays mounted but hidden, preserving its draft, attachments,
pinned context and pending-message editor; none of these are submitted as an answer.
Question submission failures retain typed text and show an error. HTTP acceptance
or metadata saying "answered" locks the prompt while waiting for its actual answer
event; neither fabricates an answer bubble nor restores the ordinary composer.
Once the answer event is available, the prompt disappears and the transcript
displays a read-only answer bubble at the input event's position. The question text
is prepended as a Markdown blockquote followed by the response, rendered together
using the ordinary message Markdown renderer and styling, without a separate
title or custom card layout. Choice responses retain their selected labels.
The composer returns without automatically taking focus. Cancelled
questions leave the dock without creating a transcript card. The asking turn's
trace stays on its final response (or its own synthetic bubble), independently
of prompt visibility. Reconnects restore the dock from authoritative question
and response records; read-only views retain their existing answer permissions.

Skipping uses the existing response endpoint with a typed `responseType: "skipped"`
response and no answer value. It resolves the question with `answer_type = 'skipped'`,
records who responded and when, and journals a wake-eligible interactive input.
The agent is explicitly told that no answer, choice, consent or approval was
provided; it can continue where possible or explain what is blocked. The transcript
shows **Question skipped** at the input event's position. HTTP acceptance or
metadata alone does not restore the composer; the actual response event does.
Skip failures retain the prompt and typed answer with a retryable error, including
a **Retry skip** control if the terminal outcome was saved before journaling failed.
Answers and skips share one idempotent response ID and a first-response-wins update,
so retries and competing tabs never produce both outcomes. Approvals cannot be skipped.
Browser protocol version 4 includes skipped responses and title-free questions;
older clients must reload.

The icon is disabled and grayed out while stopping, without adding transient
status text or changing the bubble's layout. A **Stopping response** tooltip
and accessible busy state remain until the runner settles the turn; HTTP
acceptance alone is not a completed stop. A disconnected runner or failed HTTP
request is shown explicitly, with a retry affordance. An accepted Stop waits for
the authoritative turn phase; elapsed time never declares success or failure.
Retries carry the same immutable turn ID, so a stale click cannot stop the next
response. Other open tabs and reconnects receive the current turn state.
Only users allowed to send in the conversation can stop it; a shared-session
turn running in a different thread or channel cannot be stopped from this view.

A stopped response leaves a durable history entry and its activity trace, even
if no assistant reply was sent. Completed and failed tool calls retain their
status; interrupted calls without a confirmed result are marked as having an
unknown outcome, not as successfully completed. Stopping does **not** undo
completed filesystem changes, messages, or external API effects. Provider
continuation is retained, and the stopped input is not automatically retried.
Already-submitted approval requests are separate workflows and are not revoked
by stopping the response.

Stopped responses retain elapsed time, the model when known, and any token usage
already reported. Counts are labeled **tokens reported** and may exclude an
unfinished model call; if no usage was reported, technical details say **Tokens
unavailable** instead of showing zero. Native model-call usage is captured before
waiting for tools to finish. This metadata is persisted for reloads, but cannot
be reconstructed for older stopped responses that never recorded it.

#### Upgrading question skips

Fresh installations support `skipped` directly. Existing databases whose
`questions.answer_type` CHECK constraint allows only `choice` and `text` need
an offline upgrade; the host does not run this migration at startup.

Stop this installation's host and verify no process is writing its central DB.
The temporary script was removed after deployment; recover it from commit
`aee7b194` into a temporary file inside this checkout when upgrading an older
installation:

```bash
(set -C; git show aee7b194:scripts/migrate-question-skips.ts > .question-skip-upgrade.ts)
pnpm exec tsx .question-skip-upgrade.ts data/v2.db --host-stopped
rm -- .question-skip-upgrade.ts
```

The offline script creates a restricted-permission SQLite backup beside the
database, preserves all question records, rowids, indexes and triggers, extends
the response constraint transactionally, and verifies data and database integrity.
Unexpected schemas are rejected. Re-running it on an upgraded database is a no-op.
Installations still using `pending_questions` must first finish the durable-question
upgrade offline. With the host stopped, back up the central DB using SQLite's
backup API, recover `src/db/migrations/028-durable-questions.ts` from `aee7b194`,
and apply its `migration028.up(db)` inside a SQLite transaction. Verify the
question IDs and count survived, and run the integrity and foreign-key checks
before proceeding. Restore the backup if verification fails. No legacy question
conversion ships in the host.
Rebuild the host and chat assets, restart the host, and recycle any existing
agent containers so the runner's formatter recognizes skipped responses.
Reload stale browsers for the current conversation protocol version.

Verify that `questions` admits `answer_type = 'skipped'` with a NULL value,
the existing pending question still appears in the dock with **Skip**, and
normal answers are unchanged. Do not skip a real question merely to validate
deployment. Before reopening the service, rollback is a restore of the printed
backup with the host stopped plus the matching previous code/assets. Never
restore that backup over newer accepted messages.

#### Removing stored question titles

Question titles have been removed from the MCP tool, delivery payload, central
schema and browser protocol. Fresh databases create the title-free schema
directly; there is no startup migration. Approval and display-card titles remain
unchanged. Existing `questions.title` columns must be dropped offline before
starting this host.

Stop this installation's host and verify that nothing is writing the central DB.
The temporary offline script was removed after deployment. Recover it from
commit `e8f909b0` into a temporary file inside this checkout so its dependencies
resolve. It defaults to read-only inspection:

```bash
(set -C; git show e8f909b0:scripts/migrate-question-titles.ts > .question-title-upgrade.ts)
pnpm exec tsx .question-title-upgrade.ts data/v2.db
pnpm exec tsx .question-title-upgrade.ts data/v2.db --apply --host-stopped
rm -- .question-title-upgrade.ts
```

Applying creates a restricted-permission backup using SQLite's backup API, drops
the title column inside a transaction and verifies every remaining question
value, rowid, index, trigger, constraint and applied-migration record. Integrity
and foreign-key checks must pass. Unexpected schemas or failed verification
abort the upgrade. An already title-free database needs no change. Original
session journals are immutable history; old title fields there are ignored and
are not projected into current question records.

Rebuild host and chat assets, restart this host and recycle its existing agent
containers to refresh their MCP tool schemas. Reload browsers for protocol
version 4. Before accepting new input, rollback is a restore of the printed
backup with the host stopped and the matching previous code/assets. Never
restore the backup over newer accepted messages.

### Authoritative conversation synchronization

An active web conversation uses one versioned WebSocket subscription. Its first
snapshot includes messages, durable input dispositions, turns, current activity,
usage metadata, questions, runner connection state and permitted actions.
Subsequent envelopes update that view atomically. A final response is not rendered
until the host commits the matching turn's `settled` barrier. Platform typing
notifications are unrelated and cannot complete a browser turn.

Each logical turn has one complete trace, owned by its turn ID. Steering,
questions and intermediate outputs move the synthetic bubble beneath the latest
associated content without splitting the trace. Settlement attaches it to the
final response, if present. Expansion state stays with the turn. Silent, warning,
stopped, failed and interrupted turns remain visible even without a response.
Usage retains its accounting IDs and is displayed once per record, not once per
response; metadata explicitly distinguishes provisional, partial, final and
unavailable reports. Missing usage never becomes fabricated zero tokens.

Non-web conversations poll the same projector and replace their store using the
same validated snapshot reducer. Sidebar lists and global approvals keep their
existing ten-second polling. Web conversation questions are never overwritten by
that poll. Local composer drafts, uploads and command request IDs are separate
from the server store; HTTP acceptance does not prove a command took effect.

The host publishes an explicit `timeline` of message references, question
references, and typed turn trace/status rows. The host selects the final response
or the synthetic bubble beneath the latest associated conversation content as
the sole trace host. Recorded logical-clock positions order the turn's activities.
The browser resolves those references, adds display-only live notice markers
and the start row, and attributes model-call steps to trace rows.
Thinking, current tool captions and completion stay in the status line.
It does not infer activity segments
from timestamps or invent messages, message IDs, or insertion positions for
trace/status rows. Chapters remain presentation-only groups within a trace.
Every recorded activity has a required position. Historical activity is normalized
once, offline, using saved output associations and ordinals. These assigned
positions encode canonical presentation order, not recovered execution timing.
There are no runtime missing-position or saved-association placement fallbacks.

The browser protocol is version 5 and validates `protocolVersion`, `streamId`,
revisions, entity shapes, timeline references, and unique activity placement.
Gaps or unknown streams show a synchronization error and reconnect for a fresh
snapshot; incompatible protocols explicitly ask for a page reload. Progress is
coalesced on the host with a bounded dirty flag. Slow consumers are closed rather
than building an unlimited queue. There is no durable browser replay/ACK log.
Every projection rechecks access and scopes channel, platform and thread, including
shared sessions and synthetic DM IDs. Off-route sends cannot reveal their originating
turn's trace; historical turns with an unknown origin expose only activity and
usage anchored to already-visible outputs.

**Deployment:** this client and host have no legacy frame support. Build
the checked-in bundle with `pnpm --dir src/ui/client/chat run build`, deploy host
and assets together, and reload open tabs. Verify that a reconnect starts with a
`snapshot` and subsequent changes are revisioned `update` envelopes. Do not mix
protocol versions; see [downgrade-to-v3.md](downgrade-to-v3.md) for rollback.

#### Activity-order storage

The one-time offline cutover is complete. Its converter and regression tests were
retired from the working tree and remain archived in commit `36cb79d4`.
Normal operation, fresh sessions, and restarts do not need migration scripts.

**Detect / why:** the host and runner reject incompatible activity storage with
an `Unsupported activity-order schema` error. The runtime requires
`turn_activity.timeline_position` to be positive and `NOT NULL`; it never upgrades
existing storage or accepts older activity frames. Queued inputs that have not
been consumed still use their arrival chronology; that is current behavior, not
activity-format compatibility.

**Older installations only:** restore the archived converter before following
the offline procedure below:

```sh
git restore --source=36cb79d4 -- scripts/activity-order-migration.ts scripts/migrate-activity-order.ts
pnpm exec tsx scripts/migrate-activity-order.ts --check
```

Exit code 1 means existing host/runner pairs need conversion. Do not bypass the
schema checks or run old writers against already-converted databases.

**Prepare:** let active turns finish and runner journals drain using the previous
host. Stop this installation's host and all its runners, then take a consistent
backup of every session's inbound, outbound and runner-state databases (including
any SQLite sidecars), plus the matching software and central database. Do not stop
other installations. The converter refuses unfinished turns, pending runner events,
divergent projections, and missing/mismatched backups. It preflights all sessions
before writing and commits each attached host/runner pair atomically.

**Fix:** with writers stopped, run:

```sh
pnpm exec tsx scripts/migrate-activity-order.ts --offline --backup-dir /absolute/path/to/backed-up/v2-sessions
pnpm exec tsx scripts/migrate-activity-order.ts --check
pnpm run build
pnpm --dir src/ui/client/chat run build
```

The converter preserves IDs, activity ordinals/text/display timestamps, provider
continuations, accounting and journal cursors. It rekeys message/input timeline
metadata consistently in both projections, makes room for activity immediately
before its saved output (or after its turn inputs when outputless), and reseeds
the runner clock without decreasing its previous floor. Already-recorded activity
order is preserved. Numeric historical message times are normalized once for
ordering; stored display timestamps remain unchanged. Activity timestamps never
determine placement. Old activity journal triggers are rewritten offline; no
conversion events are added to the drained journal. Repeat conversion is a no-op.

**Verify:** require zero pairs needing conversion, SQLite integrity/foreign-key
checks, and matching activity positions on both sides before starting the matched
host and runners. Verify session-link version 5, browser protocol version 4,
served bundle hashes, reconnect snapshots, applied steering, mid-turn output and
completion behavior. Reload open browser tabs. Runner source is bind-mounted, so
source-only changes do not require an image rebuild.

**Rollback:** stop all writers again; restore the complete matching database
backups and previous host/client/runner software, then restart. Do not run old
writers against the strict schema. A failed individual conversion rolls back that
pair; global rollback must restore all converted pairs from the same offline backup.
Builds replace served static assets even before a host restart, so keep builds and
activation inside the maintenance window. After successful conversion, retire
the restored converter files again; retain the backups and git history.

### Live voice input

The microphone starts live dictation directly into the composer. Speech appears
as revisable text; **silence never sends a message**. While listening, the
microphone becomes a stopwatch: press it to stop capture and finalize the text.
A spinner indicates finalization, then the microphone returns and the draft
can be edited normally. Press it again to dictate more at the cursor.
The existing Send button finalizes active dictation before submitting once.
There is no separate voice panel. Existing text and attachments are retained.
Capture initialization starts on the click, in parallel with the connection:
microphone permission, audio-context resume, and worklet loading do not wait for
the server. First-use browser permission is still required. The stopwatch shows
recording even while connecting; a spinner beside it indicates pending connection.
Up to four seconds of PCM is queued locally, then drained in order with relay
headroom and rate limiting. An overflow stops with an explicit error rather than
silently discarding the opening words. Stop while connecting retains and finalizes
already captured audio. Pressing the startup spinner before capture is ready
cancels acquisition without changing the draft.

Dictation inserts at the caret or replaces the selection in both the composer
and question answers. Interim revisions update only the original insertion
range, preserve surrounding whitespace and punctuation, and keep the caret at the
end of the inserted words, before the suffix. If no usable words remain, the
original draft and selection are restored.

Voice works with every agent model and with question-dock text answers. It is
separate from attaching an audio file for a model to hear. Browser speech
recognition and the old web `/voice/transcribe` upload endpoint are replaced by
streaming STT. Received audio files use the separate attachment behavior below.

The initial backend is ElevenLabs `scribe_v2_realtime`, accessed directly from
the **host** through AI SDK's experimental streaming transcription API. Use
Node **22 or newer**. Configure `ELEVENLABS_API_KEY` in the host's restricted
`.env` file or service environment. Never put the key in group files, container
configuration, or a browser build. The host reads the key explicitly and does
not pass it to agent containers. This is a host-only credential exception to
agent-side OneCLI routing; WebSocket STT does not go through OneCLI.
Streaming uses VAD commits and `noVerbatim: true` (`no_verbatim` in the ElevenLabs
API) to remove filler words and disfluencies. Interim hypotheses may still contain
fillers until the provider commits the cleaned text; no separate LLM cleanup pass
or paid fallback is used.

In Agent Settings, voice input has a separate enable toggle and a **Voice input
backend** selector for the server default or ElevenLabs. The database stores
`voice_input_enabled` separately from the nullable `voice_input_backend`;
`NULL` selects the server default, and backend IDs are not restricted by a
database provider whitelist. The host checks whether a backend is supported.
The server default is ElevenLabs; set `DEFAULT_VOICE_INPUT_BACKEND=disabled`
to disable inherited voice input by default. A missing key, unsupported backend,
or invalid server default shows an unavailable status rather than falling back
to another provider. Voice setting changes affect the next voice session and
do not restart agents.
When voice input is not ready, the disabled microphone shows
"Live voice input is not configured" as a tooltip instead of an inline notice;
Agent Settings retains the detailed availability reason.

Microphone capture requires HTTPS (or localhost) and browser permission. Set
`UI_BASE_URL` to the actual external UI URL: the voice WebSocket checks the
browser Origin against it. Reverse proxies must forward WebSocket upgrades.
The browser captures at its native audio rate; the audio worklet resamples to
16 kHz mono PCM before sending over an authenticated, group-authorized
connection. Limits are one active session per user, eight globally, five
minutes per capture, and bounded audio queues. Stopping and starting dictation
creates a fresh stream. After an explicit Stop or Send, a clean provider stream
ending can finalize the latest provisional text even without a provider final
event. The same recovery applies to an SDK empty-transcript error when
provisional text exists without a provider-confirmed removal. Empty provider
commits are authoritative: they clear that segment instead of reviving its old
partial text. The adapter assigns distinct IDs even when the SDK reuses an ID
after an empty commit. Zero-audio Stop aborts without an empty provider commit.
Revisions retain their segment IDs rather than being
appended again. Recovery is logged with a segment count, never transcript text.
Other provider failures, a stream ending before Stop/Send, cancellation, and a
ten-second finalization timeout do not promote provisional text or submit it.
Silent audio and unrecognized speech have distinct error messages.

Each capture has a UUID attempt ID shared by browser, host, and provider-socket
logs. The browser sends one terminal diagnostic to the authenticated, same-origin,
group-authorized `POST /api/groups/:gid/voice/diagnostics` endpoint, including
failures before the WebSocket becomes ready. Its 4 KiB payload accepts only fixed
categories, UUIDs, bounded counters, and phase timings; transcript text, draft
contents, audio, arbitrary error messages, and credentials are rejected.
The browser reports the outcome, a small failure category (including permission
denial), its queue high-water mark, and click-relative capture, connection,
first-audio, and first-transcript timings. Failed diagnostic delivery is contained
and reported in the browser console.
Host summaries include audio duration, peak/RMS level, clipped-sample count,
queue high-water mark, provider readiness, first audio/transcript, and finalization
latency. These host metrics are recorded once at session end; provider readiness
and audio statistics are not mirrored into the browser protocol.
Provider errors and rejected upgrades include the attempt ID. Abnormal
socket closes caused by local teardown are debug-level; unexpected closes remain
warnings. Provider retention remains disabled (`enableLogging: false`).

For systemd installs, inspect the configured unit's journal and filter for
`Voice input`, `Voice client`, `Voice upgrade`, and `ElevenLabs voice`; search an
`attemptId` to correlate one capture. Validate changes with simulated delayed
connections and the local SDK WebSocket fixtures before activating matched host
and browser assets. Builds targeting the served `dist/` replace live assets, so
use a staging output directory when testing outside a maintenance window.

Hiding the page or leaving a conversation releases the microphone. Provider
errors, disconnects, and quota exhaustion preserve recovered, editable text and
show an error but cancel automatic submission; review the text before pressing
Send again or starting another dictation.
No automatic paid fallback is configured. Provider free allowances and
spending settings are managed in the ElevenLabs account, not guaranteed by the
application.

Audio and provisional transcripts are not persisted by the host. Audio is sent
to ElevenLabs; only submitted text enters the chat journal. The request disables
provider logging where supported; provider retention and account terms still
apply. Spoken editing commands and assistant speech playback are not included.

### Audio attachments and channel voice messages

Audio received through WhatsApp, Telegram, other channels, or web file uploads
is an ordinary attachment. The **+ > Record audio attachment** action is
available whenever the browser supports microphone capture, independently of
the selected model and live dictation settings.

There is no automatic file transcription or hidden STT fallback. The original
file is saved in the workspace and its name, MIME type, and path are included
in the prompt. Providers embed audio only when model capabilities, their
transport, and the file format support it. Otherwise the agent receives the
file reference and can use its available tools; it is not told that the audio
was transcribed.

The native provider requires a known audio-input model over OpenAI-compatible
Chat before inspecting any audio. `NATIVE_BASE_URL` overrides the endpoint
address, not the canonical model's catalog capabilities. Unknown custom models
remain unknown; catalog outages produce a diagnostic and leave custom endpoints
usable with unknown capabilities (catalog retries back off for one minute).
Explicit endpoints retain their independently selected `NATIVE_PROTOCOL`
(OpenAI-compatible Chat by default).

Eligible audio is inspected by `ffprobe`, not trusted solely by its declared
MIME type or extension. Compatible MP3 and PCM WAV can be embedded directly;
common voice-note formats such as OGG/Opus, WebM, M4A/AAC, and FLAC are normalized
to MP3 with `ffmpeg`. The original file is never replaced. Conversions are not
cached; temporary preparation files are cleaned up immediately afterward.
See [audio preparation limits](build-and-runtime.md#audio-attachment-preparation).

Unknown or text-only model capabilities, unsupported adapters, invalid media,
and processing limits or failures retain the original file reference, with an
explicit reason in the model prompt and runner logs. Anthropic Messages,
OpenCode's current file-part adapter and Claude do not embed native audio.
These agents can still access the original file through their tools. Catalog
audio support does **not** promise every endpoint accepts every audio format;
provider rejection is surfaced rather than retried with a different attachment
representation. Live dictation, attachment controls, and Agent Settings are
unchanged by this preparation.

**Upgrade behavior change:** channel voice notes sent to text-only models no
longer get automatically transcribed. `DEFAULT_TRANSCRIPTION_MODEL` is ignored
and can be removed from the host environment; `transcription_model` and
`voice_mode` are removed by a new database migration. Historical migrations
remain unchanged. The live web dictation backend and enable flag are preserved.
Legacy transcription settings are not converted to dictation settings.

Rebuild the host and chat UI, then restart the host and affected agent
containers to pick up this simplification. Runner source is bind-mounted, so
this source-only change does not require rebuilding per-group images.
Idle containers restarted through `ncl groups restart` start fresh on the next
message. Back up the database before
upgrading if rollback to the legacy schema is needed; the removal migration
does not preserve the retired settings.

### Feedback notifications

Ordinary error toasts across the UI remain visible until explicitly dismissed. Their text
can be selected and copied, long messages wrap and scroll, and each has a
keyboard-accessible **Dismiss** button. Later notifications queue behind an
unread error rather than replacing it. Success messages still auto-dismiss;
action prompts remain persistent. New-version and incompatible-protocol notices
share a **Reload** action instead of **Dismiss**. Reload checks for a newer
service worker and waits for it to activate before reloading, so a cached client
does not simply reload itself. Failed updates show a retryable Reload error.
Protocol mismatches pause chat rather than implying that the user must reply on
another channel; the read-only banner appears only after capabilities have been
confirmed, and read-only Web threads do not direct users back to Web.
Later notifications also queue behind a required Reload prompt.

If a catalog skill fails to install, the error includes Git's diagnostic when
available. `Repository not found` during a catalog add or refresh means the
upstream is unavailable to the host; it does not invalidate an existing snapshot.

### Catalog snapshots and skill installation

Catalogs are cached under `data/skills/cache/<catalog-id>`. Installs use that local
Git snapshot, not a fresh clone of the upstream. The UI sends the displayed commit
with the install request; if the cache has changed, installation stops with a
request to reload and review the catalog rather than silently using another
revision. Directory results that have not yet been cached are cloned once when
added; expanded previews reuse their existing snapshot when added.

Each group receives an independent sparse checkout at
`groups/<folder>/skills/.catalogs/<catalog-id>@<commit>`, with relative skill
symlinks into it. The checkout's `origin` remains the original repository URL,
but no Git objects are borrowed from the browsing cache: removing or refreshing
that cache cannot break installed skills. Installing another revision does not
update existing skills. Local edits and commits are preserved; if a checkout
cannot safely supply the requested skill, a separate suffixed checkout is used.
Legacy `.catalogs/<catalog-id>` checkouts continue to work unchanged.

Installing a cached skill does not require the upstream repository to exist.
Existing security-audit checks and acknowledgements still apply. Catalog refresh
and updating an agent's installed skills remain separate operations.

### Refreshing catalogs

Owners and global admins can **Refresh** a registered catalog from either its
catalog card or its directory-search result. Both show **Last successful refresh**: the
last successful upstream check, with an exact timestamp on hover. Older preview
snapshots without a recorded fetch time show **Not recorded**. Installing a skill
does not change this timestamp.

Refresh is manual; browsing does not trigger a network refresh. While a refresh
is running, its controls show progress and repeated requests for that catalog
join the same operation. Other catalogs remain usable. Git network operations
run asynchronously so they do not block host routing or other UI requests.

The host prepares a separate checkout, fetches the configured branch, and validates
the catalog before publishing its tree and metadata together. A failed fetch or
validation preserves the previous cache, commit, and successful timestamp. The
latest failure and attempt time are retained and displayed, and cached skills
remain installable. Publication errors roll back the previous tree; an unsuccessful
rollback preserves staging files and logs their location for operator recovery.
Removing a catalog during its refresh is refused.

Successful refreshes update the timestamp even when the commit has not changed,
clear the previous failure, and invalidate the displayed catalog and directory
previews so subsequent installs use the newly displayed commit. Refresh never
updates agent checkouts or discards agent edits.

### Updating installed skills

Owners and global admins have an **Update** button beside each catalog-installed
skill. It uses the current local catalog snapshot; it does not fetch upstream.
Use **Refresh** separately when a newer catalog revision is wanted. Built-in
and agent-authored skills have no catalog update action.

Update prepares and validates the target revision before atomically switching
only that skill's link. Other installed skills and the old checkout remain
untouched. Updating to the already-installed revision is a no-op. Local edits
or commits, missing sources, invalid snapshots, and blocking security audits
stop the update with an error instead of replacing the current skill. There is
no review or confirmation flow and no automatic restart.

Skill updates and catalog refreshes show button progress and updated revision
metadata without success notifications. Failures remain visible. Enabled flags
and unsaved settings are preserved; restart the agent to pick up updated skills.

## Security posture

- Magic-link tokens and session tokens are 256-bit random; only their sha256 hashes are stored.
- Cookie is HttpOnly, `SameSite=Lax`, `Path=/ui`, optionally `Secure`.
- Path traversal and symlink escapes are blocked (`resolveSafe` runs `realpath` + containment).
- Read-only: no upload, rename, delete, or edit endpoints.
- Access is logged to the `ui_access_log` table.

The mount is reachable on whatever interface the webhook server binds (default `0.0.0.0`). If your webhook port is exposed to the public internet, the UI is too — auth is strong, but treat the URL as sensitive. Put it behind a reverse proxy with TLS for non-LAN use, and set `UI_SECURE=true`.

## Tables

Migration `016-ui` creates:

- `ui_sessions` (cookie sessions, shared across apps)
- `ui_magic_links` (single-use login tokens)
- `ui_access_log` (audit trail)

All three are pruned hourly by the in-process purge timer.
