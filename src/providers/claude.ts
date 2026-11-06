/**
 * Claude provider container config — only registered when the user has
 * configured a custom Anthropic-compatible endpoint via setup. Setup
 * appends `import './claude.js'` to providers/index.ts at that point;
 * standard installs hitting api.anthropic.com don't need this file
 * loaded.
 *
 * The real auth token never enters the container. The owner creates a
 * personal connection for the exact API host and documented auth recipe
 * and grants the selected agent access, so the proxy
 * rewrites the Authorization header on the wire. The container only
 * needs:
 *   - ANTHROPIC_BASE_URL — so the SDK knows where to call
 *   - ANTHROPIC_AUTH_TOKEN=placeholder — so the SDK adds an
 *     Authorization: Bearer header for Agent Vault to overwrite
 */
import { registerProviderContainerConfig } from './provider-container-registry.js';
import { providerRuntimeEnv } from './runtime-env.js';

registerProviderContainerConfig('claude', () => ({ env: providerRuntimeEnv('claude', process.env) }));
