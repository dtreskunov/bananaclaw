---
name: add-ollama-provider
description: Configure a reviewed Ollama endpoint without bypassing Agent Vault socket isolation. Use when users want local models or reduced API costs; existing direct-host-network recipes are not supported.
---

# Ollama provider routing

Agent containers always have `--network=none`; changing `NO_PROXY`,
`host.docker.internal` or a generated `container.json` cannot enable direct
host access. Do not add open-egress fallbacks, override gateway settings or
make home directories world-writable.

Ask for the intended group, model, endpoint and approved gateway network policy.
Inspect the installed provider's supported endpoint/model configuration before
editing it. Use a reviewed gateway-reachable HTTPS endpoint for Ollama and
explicit operator approval for any private-range access or allowlist change.
Do not silently expose the host's Ollama listener to other groups.

If the current provider cannot express the endpoint per group, report that
limitation and agree on a bounded provider integration using `/customize`.
Do not change global endpoint variables to redirect unrelated groups.

Before any provider switch, validate the exact model through a disposable
network-disabled container and its scoped gateway socket. Confirm tool/text
support, preserve memory and apply changes at a committed turn boundary.
Never report success based solely on a host-side `curl`.

See [the current network model](../../../docs/ollama.md).
