/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

import type { McpServerConfig } from './providers/types.js';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, McpServerConfig>;
  model?: string;
  smallModel?: string;
  effort?: string;
  voiceMode: 'off' | 'transcribe' | 'audio';
  transcriptionModel?: string;
  /**
   * Freeform provider knobs from the host. Always an object — the host
   * materializer guarantees this. Providers ignore keys they don't
   * understand and log a one-shot warning at startup.
   */
  modelParams: Record<string, unknown>;
}

const DEFAULT_MAX_MESSAGES = 10;

let _config: RunnerConfig | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  _config = {
    provider: (raw.provider as string) || 'claude',
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
    model: (raw.model as string) || undefined,
    smallModel: (raw.smallModel as string) || undefined,
    effort: (raw.effort as string) || undefined,
    voiceMode: raw.voiceMode === 'transcribe' || raw.voiceMode === 'audio' ? raw.voiceMode : 'off',
    transcriptionModel: (raw.transcriptionModel as string) || undefined,
    modelParams: isPlainObject(raw.modelParams) ? (raw.modelParams as Record<string, unknown>) : {},
  };

  return _config;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}

/** Test-only: seed the config cache, or clear it by passing null. */
export function setConfigForTest(overrides: Partial<RunnerConfig> | null): void {
  _config = overrides ? { ...loadConfig(), ...overrides } : null;
}
