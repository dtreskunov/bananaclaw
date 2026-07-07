/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, PAGES_BASE_DOMAIN } from './config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import { readEnvFile } from './env.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
  timeout?: number;
}

export interface McpHttpServerConfig {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  instructions?: string;
  timeout?: number;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[]; pip: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  smallModel?: string;
  effort?: string;
  voiceMode?: string;
  transcriptionModel?: string;
  /**
   * Freeform provider knobs (e.g. `{ max_tokens: 8192 }`). Mirrors the
   * `model_params` JSON column in `container_configs`. Always present as
   * an object so providers can spread it without a null check.
   */
  modelParams?: Record<string, unknown>;
  /**
   * Public FQDN this group's static website is served at, when the website
   * feature is configured (`PAGES_BASE_DOMAIN` set) AND this group has it
   * enabled with a slug allocated. Otherwise undefined. The `site-website`
   * skill keys off this to derive the publish path and URL.
   */
  siteFqdn?: string;
  /**
   * External base URL of the web UI (`UI_BASE_URL`, e.g.
   * `https://example.com/ui`), trailing slash stripped. Only present when an
   * explicit external URL is configured — the localhost dev fallback is
   * omitted since it's useless to a browser. The `site-website` skill uses it
   * to build absolute file-API URLs (`<uiBaseUrl>/chat/api/groups/<id>/…`) for
   * a Pages site's client-side JS, which calls the API cross-origin.
   */
  uiBaseUrl?: string;
}

/**
 * Resolve an env var via process.env first, then the .env file. Mirrors
 * `resolveEnv()` in container-runner.ts — duplicated here to avoid a
 * runner ↔ config import cycle. Values can change at runtime (.env is
 * re-read), so we never cache.
 */
function envFallback(name: string): string | undefined {
  if (process.env[name] !== undefined) return process.env[name];
  const file = readEnvFile([name]);
  return file[name];
}

/**
 * Parse the `model_params` JSON column. Tolerant: returns `{}` for null,
 * empty, malformed, or non-object payloads. Providers spread the result
 * directly so we never want to surface a parse error here \u2014 a bad value
 * would silently disable every other knob.
 */
function parseModelParams(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * Build a `ContainerConfig` from a DB row + agent group identity. Per-row
 * NULLs fall back to env defaults (`DEFAULT_PROVIDER` / `DEFAULT_MODEL` /
 * `DEFAULT_EFFORT`) so an operator can set a fleet-wide preference once
 * in `.env` instead of running `ncl groups config update` after every
 * onboarding. Row values always win.
 */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  return {
    mcpServers: JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>,
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
      pip: JSON.parse(row.packages_pip) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? envFallback('DEFAULT_PROVIDER'),
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? envFallback('DEFAULT_MODEL'),
    smallModel: row.small_model ?? undefined,
    effort: row.effort ?? envFallback('DEFAULT_EFFORT'),
    voiceMode: row.voice_mode,
    transcriptionModel: row.transcription_model ?? envFallback('DEFAULT_TRANSCRIPTION_MODEL'),
    modelParams: parseModelParams(row.model_params),
    siteFqdn:
      PAGES_BASE_DOMAIN && group.site_enabled && group.site_slug
        ? `${group.site_slug}.${PAGES_BASE_DOMAIN}`
        : undefined,
    uiBaseUrl: envFallback('UI_BASE_URL')?.replace(/\/$/, '') || undefined,
  };
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}
