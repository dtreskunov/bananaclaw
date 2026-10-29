# NanoClaw Documentation

The official documentation is at **[docs.nanoclaw.dev](https://docs.nanoclaw.dev)**.

The files in this directory are original design documents and developer references. For the most current and accurate information, use the documentation site.

| This directory                                                 | Documentation site                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [SPEC.md](SPEC.md)                                             | [Architecture](https://docs.nanoclaw.dev/concepts/architecture)           |
| [SECURITY.md](SECURITY.md)                                     | [Security model](https://docs.nanoclaw.dev/concepts/security)             |
| [REQUIREMENTS.md](REQUIREMENTS.md)                             | [Introduction](https://docs.nanoclaw.dev/introduction)                    |
| [docker-sandboxes.md](docker-sandboxes.md)                     | [Docker Sandboxes](https://docs.nanoclaw.dev/advanced/docker-sandboxes)   |
| [APPLE-CONTAINER-NETWORKING.md](APPLE-CONTAINER-NETWORKING.md) | [Container runtime](https://docs.nanoclaw.dev/advanced/container-runtime) |

## Design proposals

- [Credential gateway plan of record](credential-gateway-agent-vault-fork-proposal.md):
  revision 7 adopts native AgentVault managed users, user-owned static/OAuth
  connections, explicit shared references and a top-level Credentials tab.
  Group vaults retain isolated proxy identity and service grants, not credential
  copies. F12 copying is removed; the target release replaces superseded fork
  contracts without permanent compatibility code.
- [Agent Vault releases and safe upgrades](agent-vault-upgrades.md): pinned
  binaries, checksum/provenance verification, preserved state and rollback via
  `/init-agent-vault`, plus the coordinated clean-break release requirements.
- [OneCLI migration inventory and preparation](agent-vault-migration.md):
  metadata-only source access evidence, the deployed vault-local tooling, and
  the target shared-reference adoption/retirement contract.

- [Native credential gateway](credential-gateway-proposal.md): historical
  TypeScript alternative and transport/trust-model analysis; not a competing
  plan of record for credential ownership or UI.
- [Credential gateway spike and acceptance history](credential-gateway-spike.md):
  evidence for the existing proxy/OAuth foundations, not acceptance of the
  revision-7 sharing and native-user contracts.
