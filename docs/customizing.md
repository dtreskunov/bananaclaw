# Customizing NanoClaw

NanoClaw is made to be forked and changed. The catch with most projects is that once you edit the code, every upstream update turns into a merge fight, and the more you customized, the worse it gets.

NanoClaw avoids that with one simple idea: **every change you make is a skill.**

## The idea in a minute

- A **skill** is a small, self-contained add-on. It brings its own code and knows how to install itself.
- Your **fork is just a list of skills**, plus one "recipe" that says which skills you have and how they fit together.
- Because your changes live beside the core instead of tangled into it, **pulling in updates stays easy**.

## What makes it work

A good skill mostly **adds** things: new files, a line appended to an existing file, a dependency. It avoids rewriting existing code in place.

And it ships a test for each spot where it touches the rest of the system. When an update moves something your skill depends on, that test fails and points at the fix, instead of you finding out when things break in production.

## How you actually work

You don't have to think in skills while you're building. **Edit the code directly, get it working, then turn your changes into skills afterward.** A coding agent does the conversion for you, following [skill-guidelines.md](skill-guidelines.md).

The only rule worth remembering: **a change isn't really part of your fork until it's a skill**, because that's the form that survives an upgrade.

## Upgrading

Always upgrade by running `/update-nanoclaw`. **Don't just `git pull`.** The command sets a rollback point, pulls the upstream changes, runs your tests, and walks you through anything that needs fixing, usually a small, local fix in one skill.

## The deal

We keep the core small and stable, and every breaking change ships with its migration. You keep your changes as skills, with tests. Do that, and upgrades won't break you. Changes edited directly into the core are the one thing the model can't protect.

## MCP server additions

Agents use `add_mcp_server` for both stdio and HTTP/SSE servers, modifying only
their own agent. The host-only `ncl groups config add-mcp-server` command remains
available to operators for any target group; its flags and explicit restart
behavior are unchanged. Both use the same configuration implementation.

### Detect / why / fix / verify / rollback

- **Detect:** Look for agent instructions or scripts using
  `ncl groups config add-mcp-server`, especially with another agent's `--id`.
  The command now returns `forbidden` to agents, including global-scope agents.
- **Why:** The CLI's separate approval/restart flow competed with the native
  MCP tool and encouraged retries and duplicate approvals. Agents now have
  one setup operation. Catalog hints are available at the
  [MCP Registry](https://registry.modelcontextprotocol.io/) and [mcp.so](https://mcp.so);
  verify publisher documentation before submitting an addition.
- **Fix:** Replace agent-side CLI additions with `add_mcp_server`. Submit once,
  tell the user approval is pending, and finish the turn. After approval and
  automatic restart, request missing credentials for the configured server,
  then verify its tools. Cross-agent additions must be performed by an operator
  on the host. Deploy the host and runner changes together, and let containers
  restart normally so refreshed built-in instructions are composed.
  Existing pending approvals are not cancelled, converted or resubmitted;
  review them explicitly and reject unwanted duplicates.
- **Verify:** Agent help omits the CLI addition verb, and attempting that
  command creates no approval. Native additions still require approval and
  schedule their own deferred restart; the host CLI still accepts its original
  stdio, HTTP/SSE, metadata and connection-reference flags.
- **Rollback:** Restore the previous host/runner revision and its instructions
  using the normal deployment rollback procedure. No database migration or
  credential change is required.

## Go deeper

- **[The skills model in full](skills-model.md)**: how skills, recipes, tests, and upgrades work under the hood.
- **[Skill guidelines](skill-guidelines.md)**: the authoritative checklist for writing one.
