---
name: add-email-bot
description: Scaffold a new email-bot alias under groups/<alias>@<domain>/. Creates the folder with CLAUDE.local.md (persona), allowed-senders.txt (regex allow-list), and bot.json (name + cli_scope). The Resend adapter lazy-provisions the agent group, container config, wiring, and destination on the first allowed inbound email. Use when the operator wants a new email persona at a fresh alias on their bot domain.
---

# Add Email Bot

Stand up a new per-alias email bot. Each alias maps to its own agent group with its own persona, model config, and sender allow-list. The filesystem is the source of truth — drop the folder and the alias is enabled; remove it and the alias is disabled (existing sessions keep working, but new senders are dropped).

## Prerequisites

- **Resend adapter installed and connected.** `.env` has `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `RESEND_FROM_NAME`, `RESEND_WEBHOOK_SECRET`. Confirm with: `grep RESEND_ .env`. If missing, run `/add-resend` first.
- **Service running.** A recent `Resend inbound` line in `logs/nanoclaw.log` is the cheapest sanity check.
- **Inbound webhook configured at Resend.** Emails to the bot domain reach the host. If unsure, ask the user to send a test email to their existing default address and grep the log.

## 1. Collect the bot details (interactive)

Ask each of the following via AskUserQuestion. Use one call per field so the user can answer them one at a time. For free-form fields, pass `allowFreeformInput=true` with no options; for choice fields, pass the option list below.

1. **AskUserQuestion: "What email alias should the bot receive on?"** — free-form. Expect a full address like `support@bot.example.com`. Must be on a domain Resend will deliver to your host. Record as `ALIAS`.

2. **AskUserQuestion: "What display name for the bot?"** — free-form. Suggest the local-part of `ALIAS` (e.g. `support`) as the default in the question text. Record as `BOT_NAME`.

3. **AskUserQuestion: "Describe the bot's persona, tone, and what it knows."** — free-form, multi-line accepted. This becomes the body of `CLAUDE.local.md`. Tell the user inline: *don't put rules about who can email here — the next step handles that.* Record as `PERSONA`.

4. **AskUserQuestion: "What ncl scope should this bot have?"** with options:
   - `disabled` (recommended) — no `ncl` access. Pure persona-only. Best for untrusted inbound / prompt-injection-sensitive bots.
   - `group` — can manage its own agent group via `ncl` (own config, destinations, members, sessions). Risky-action changes (`install_packages`, `add_mcp_server`) still go through approval.
   - `global` — full admin. Reserved for owner bots — only pick if you fully trust every sender in the allow-list.

   Record the choice as `CLI_SCOPE`.

## 2. Collect the allowed-senders list (interactive)

Tell the user inline before asking:

> Email bots without a sender allow-list silently drop every inbound message — no exceptions. List one regex per line; blank lines and `#` comments are ignored. Senders are matched case-insensitively against the bare email address (e.g. `alice@example.com`, not `Alice <alice@example.com>`).

**AskUserQuestion: "How should the allow-list start?"** with options:

- `me-only` — just the operator's own email address. Recommended for any bot with `cli_scope=global` or sensitive tooling. Follow up with a free-form AskUserQuestion: *"What's your email address?"* and write `^<escaped-email>$` as the only line.
- `domain` — domain-locked. Follow up with a free-form AskUserQuestion: *"Which domain should be allowed?"* and write `.*@<escaped-domain>$` as the only line.
- `open` — permissive `.*@.*`. New senders still hit the `request_approval` flow (DM to owner) before their first reply lands. Use only when the agent group is also opt-in safe.
- `custom` — follow up with a free-form AskUserQuestion: *"Paste the regex lines, one per line."* — accept multi-line input verbatim.

Record the resulting full text content as `ALLOWED_SENDERS` — this is exactly what gets written to `allowed-senders.txt`. Always escape `.` and `@` with backslashes inside regex literals when building from a concrete email or domain. Anchor with `^` and `$` for `me-only` so a substring match (e.g. `evil-denis@…`) cannot slip through.

## 3. Create the folder

## 3. Scaffold the folder

Use the `ncl email-bots create` verb — it writes the three files atomically and validates the inputs. Pass each multi-line field on stdin via a here-doc style invocation (or as a single `--arg=value` if it's short):

```bash
ncl email-bots create \
  --alias '<ALIAS>' \
  --name '<BOT_NAME>' \
  --cli-scope '<CLI_SCOPE>' \
  --persona '<PERSONA>' \
  --allowed-senders '<ALLOWED_SENDERS>'
```

The verb refuses to overwrite an existing folder, validates the alias is a well-formed email, and rejects empty `--allowed-senders` (fail-safe). On success it returns the folder path and a "send a test email" hint.

No DB rows, no service restart. The Resend adapter reads the folder on the first inbound email to `<ALIAS>` and lazily registers the agent group, container config, wiring, and destination.

## 4. Verify

Tell the user to send a test email to `<ALIAS>` from an address that matches one of the regexes in `allowed-senders.txt`.

What you expect to see in `logs/nanoclaw.log` within a few seconds:

```
INFO Resend inbound from="<sender>" alias="<ALIAS>" to=["<ALIAS>"] subject="..."
INFO Provisioned email bot folder="<ALIAS>" agentGroupId="ag-..." messagingGroupId="mg-..." cliScope="<CLI_SCOPE>"
INFO Session created id="sess-..." agentGroupId="ag-..." sessionMode="per-thread" threadId="resend:<ALIAS>:<sender>:..."
INFO Spawning container sessionId="sess-..." agentGroup="<BOT_NAME>"
... (a few seconds later)
INFO Message delivered id="msg-..." channelType="resend" platformId="resend:<sender>" ...
```

Then the user receives the reply by email. The first reply may take longer if the owner approval flow fires (depends on `unknown_sender_policy='request_approval'` on the messaging group + whether the sender is already a known user).

## Troubleshooting

**"Resend dropped — alias not enabled" in the log.**
The folder doesn't exist or `CLAUDE.local.md` is missing. Check: `ls groups/<ALIAS>/`. The full email (with `@`) must be the folder name verbatim.

**"Resend dropped — sender not in allowed-senders.txt" in the log.**
The sender's address didn't match any regex. Check the regexes — remember they're matched against the bare email (case-insensitive). Add the sender's address (or a broader regex) and have them re-send.

**"Provisioned email bot" fires but no container spawn.**
Check `data/v2-sessions/<agentGroupId>/<sessionId>/inbound.db` for a `messages_in` row. If it's there but no spawn, host-sweep should pick it up within 60s. If still nothing, check `logs/nanoclaw.error.log` for container-runtime errors.

**Container spawns but no reply arrives.**
First-time senders may be held by the approval flow — check `ncl approvals list`. For a new agent, review its Access and the owner’s Credentials. No credentials are granted automatically; use the existing request_access workflow rather than broadening access to every connection.

**Container name issues / docker error about invalid characters.**
The host sanitizes `@` → `_at_` in container names, so `groups/leet@bot.example.com/` becomes `nanoclaw-v2-leet_at_bot.example.com-<ts>`. If you see another character cause problems (rare — only `[a-zA-Z0-9_.-]` is allowed), report it.

## Lifecycle

- **Edit the persona** — change `CLAUDE.local.md`. Effective on the next session spawn (existing live containers keep the old persona until they idle out).
- **Edit the allow-list** — change `allowed-senders.txt`. Effective immediately for the next inbound email.
- **Change `cli_scope` or name** — edit `bot.json`, then run `ncl groups config update --id <agentGroupId> --cli-scope <new>` to push to the DB (the auto-provisioner only writes `bot.json` values on first registration). For name changes, also `ncl groups update --id <agentGroupId> --name <new>`.
- **Disable the alias** — `rm -rf groups/<ALIAS>`. New inbound emails will be dropped. Existing sessions keep working until they idle out, then any subsequent email also drops. To clean up the DB rows too: `ncl groups delete --id <agentGroupId>`.
- **List all email bots** — `ncl email-bots list` (or `ls -d groups/*@*/`).
