# Remove fx provider

Idempotent — safe to run even if some steps were never applied. Reverses both the host (`src/providers/`) and container (`container/agent-runner/src/providers/`) trees, plus the Dockerfile binary install.

There is no dependency to uninstall: the fx provider adds no npm/Bun packages.

## 1. Move any groups off fx first

A group left on `agent_provider = 'fx'` will fail to start once the provider is gone.

```bash
ncl groups list
ncl groups config update --id <agent-group-id> --provider claude
```

## 2. Delete the barrel registrations (both trees)

- `src/providers/index.ts` — delete (do not comment out) the `import './fx.js';` line.
- `container/agent-runner/src/providers/index.ts` — remove `'./fx.js'` from `OPTIONAL_PROVIDER_MODULES`, leaving `['./opencode.js']`.

This unregisters the provider from both `listProviderContainerConfigNames()` (host) and `listProviderNames()` (container).

## 3. Delete the copied files (both trees)

```bash
rm -f src/providers/fx.ts \
      src/providers/fx-registration.test.ts \
      src/fx-dockerfile.test.ts \
      container/agent-runner/src/providers/fx.ts \
      container/agent-runner/src/providers/fx-gateway-shim.ts \
      container/agent-runner/src/providers/fx-gateway-shim.test.ts \
      container/agent-runner/src/providers/mcp-to-fx.ts \
      container/agent-runner/src/providers/fx.test.ts \
      container/agent-runner/src/providers/fx-registration.test.ts
```

## 4. Revert the Dockerfile and build.sh

In `container/Dockerfile`, delete the whole `# ---- fx CLI` block: the four `ARG`s (`INSTALL_FX`, `FX_VERSION`, `FX_SHA256_X86_64`, `FX_SHA256_AARCH64`) and the `RUN if [ "$INSTALL_FX" = "true" ]; then ... fi` step.

In `container/build.sh`, delete the `INSTALL_FX` `.env` lookup and the `BUILD_ARGS+=(--build-arg INSTALL_FX=true)` branch.

## 5. Drop the `.env` flag

```bash
sed -i.bak '/^INSTALL_FX=/d;/^FX_MODEL=/d;/^FX_MAX_AGENT_STEPS=/d;/^FX_GATEWAY_BASE_URL=/d;/^FX_GATEWAY_CHAT_URL=/d;/^FX_UPSTREAM_GATEWAY_URL=/d' .env && rm -f .env.bak
```

## 6. Clean the per-group overlays

The runtime overlays shadow the image, so a stale `fx.ts` there would still be loaded:

```bash
for overlay in data/v2-sessions/*/agent-runner-src/providers/; do
  [ -d "$overlay" ] || continue
  rm -f "$overlay/fx.ts" "$overlay/fx-gateway-shim.ts" "$overlay/mcp-to-fx.ts"
  cp container/agent-runner/src/providers/index.ts "$overlay"
done
```

Per-session fx state directories can go too:

```bash
rm -rf data/v2-sessions/*/*/fx-state
```

## 7. Rebuild and validate

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm test
cd container/agent-runner && bun test && cd -
./container/build.sh
```

## 8. Revoke the credential (optional)

```bash
onecli secrets list
onecli secrets delete --id <secret-id>
```
