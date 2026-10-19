# NanoClaw Documentation

The official documentation is at **[docs.nanoclaw.dev](https://docs.nanoclaw.dev)**.

The files in this directory are original design documents and developer references. For the most current and accurate information, use the documentation site.

| This directory | Documentation site |
|---|---|
| [SPEC.md](SPEC.md) | [Architecture](https://docs.nanoclaw.dev/concepts/architecture) |
| [SECURITY.md](SECURITY.md) | [Security model](https://docs.nanoclaw.dev/concepts/security) |
| [REQUIREMENTS.md](REQUIREMENTS.md) | [Introduction](https://docs.nanoclaw.dev/introduction) |
| [docker-sandboxes.md](docker-sandboxes.md) | [Docker Sandboxes](https://docs.nanoclaw.dev/advanced/docker-sandboxes) |
| [APPLE-CONTAINER-NETWORKING.md](APPLE-CONTAINER-NETWORKING.md) | [Container runtime](https://docs.nanoclaw.dev/advanced/container-runtime) |

## Design proposals

- [Native credential gateway](credential-gateway-proposal.md): retire OneCLI with a
  NanoClaw-owned egress gateway service (separate from the host), encrypted vault,
  OAuth apps, and MCP OAuth 2.1 with dynamic client registration.
- [Credential gateway via an Agent Vault fork](credential-gateway-agent-vault-fork-proposal.md):
  alternative route to the same goals by forking Infisical Agent Vault (Go, MIT),
  with a spike-gated go/no-go.
