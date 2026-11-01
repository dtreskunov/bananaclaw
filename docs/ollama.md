# Ollama and mandatory gateway isolation

Agent containers always run with `--network=none`. Their only egress is the
per-session Agent Vault Unix socket; proxy/CA settings are reserved and cannot
be overridden by provider contributions.

The old direct-host-network recipe is not supported. Setting `NO_PROXY` or
`host.docker.internal`, editing generated `container.json`, or adding ad hoc
environment fields cannot make a local Ollama server reachable safely.

A local-model integration needs a reviewed gateway-reachable HTTPS endpoint,
explicit network policy (including approved private-range access where needed)
and a provider configuration that scopes the endpoint/model to the intended
group. Do not redirect global settings for unrelated agents or bypass TLS.
If the installed provider lacks that configuration surface, implement it through
an agreed bounded customization, not an open-network fallback.

Validate actual model generation and tools through a disposable isolated
container before switching. Keep memory and credential grants unchanged and
apply runtime changes after the current turn commits.

Use `/add-ollama-provider` to review requirements or `/add-ollama-tool` for an
MCP integration; the same gateway isolation requirements apply.
