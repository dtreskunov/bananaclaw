import { getContainerConfig } from '../../../db/container-configs.js';
import { readEnvFile } from '../../../env.js';
import { log } from '../../../log.js';

export type VoiceInputBackend = 'disabled' | 'elevenlabs';

export interface VoiceInputConfig {
  backend: VoiceInputBackend;
  ready: boolean;
  reason?: string;
}

export const VOICE_INPUT_MODEL = 'scribe_v2_realtime';
const INVALID_DEFAULT_REASON = 'DEFAULT_VOICE_INPUT_BACKEND must be disabled or elevenlabs.';
let warnedInvalidDefault = false;

function hostValue(name: string): string | undefined {
  return (process.env[name] ?? readEnvFile([name])[name])?.trim() || undefined;
}

export function defaultVoiceInputBackend(): VoiceInputBackend {
  return configuredDefaultBackend() ?? 'disabled';
}

function configuredDefaultBackend(): VoiceInputBackend | undefined {
  const backend = hostValue('DEFAULT_VOICE_INPUT_BACKEND');
  if (!backend || backend === 'disabled' || backend === 'elevenlabs') {
    warnedInvalidDefault = false;
    return backend === 'disabled' ? 'disabled' : 'elevenlabs';
  }
  if (!warnedInvalidDefault) {
    log.warn(`${INVALID_DEFAULT_REASON} Default web voice input is unavailable.`);
    warnedInvalidDefault = true;
  }
  return undefined;
}

/** Private host credential. Never include this value in config or status payloads. */
export function getVoiceInputApiKey(): string | undefined {
  return hostValue('ELEVENLABS_API_KEY');
}

export function resolveVoiceInputConfig(groupId: string): VoiceInputConfig {
  const config = getContainerConfig(groupId);
  if (config?.voice_input_enabled === 0) {
    return { backend: 'disabled', ready: false, reason: 'Voice input is disabled.' };
  }
  const inherited = config?.voice_input_backend == null;
  const backend = inherited ? configuredDefaultBackend() : config.voice_input_backend;
  if (backend === undefined) {
    return { backend: 'disabled', ready: false, reason: INVALID_DEFAULT_REASON };
  }
  if (inherited && backend === 'disabled') {
    return { backend, ready: false, reason: 'Voice input is disabled.' };
  }
  if (backend !== 'elevenlabs') {
    return { backend: 'disabled', ready: false, reason: 'Configured voice input backend is not supported.' };
  }
  if (!getVoiceInputApiKey()) {
    return { backend, ready: false, reason: 'ELEVENLABS_API_KEY is not configured on the host.' };
  }
  return { backend, ready: true };
}
