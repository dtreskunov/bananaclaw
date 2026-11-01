---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install NanoClaw, configure it, or go through first-time setup. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

First run `/init-agent-vault` to install/configure the verified gateway with
an approved secure password-input mechanism. Never request passwords or tokens
in chat. Verify the existing instance rather than creating another one.

Then run `bash nanoclaw.sh` in an interactive terminal. It handles dependencies,
container image, read-only gateway verification, service, first agent and
optional channel wiring. Model credentials are configured privately in the
owner's Credentials page, then granted to selected agents through Access.
There is no automatic grant or copied credential. Do not attempt the first
model response until the intended group has explicit access.

If they hit an error partway through, the script offers Claude-assisted recovery inline and resumes from where it stopped.
