import { checkKeyName, checkValue, KeyInputError } from './keys.js';
import type { GatewayAuth, GatewayService } from './gateway-credentials.js';

function record(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

export function checkSetValues(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new KeyInputError('Values must be a JSON object');
  if (Object.keys(raw).length > 64) throw new KeyInputError('A key set supports at most 64 keys');
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [checkKeyName(key), checkValue(value)]));
}

export function parseSetValues(raw: unknown): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // JSON parser diagnostics can contain the supplied credentials.
    parsed = undefined;
  }
  return checkSetValues(parsed);
}

export function checkSetService(raw: unknown): GatewayService {
  if (
    !record(raw) ||
    typeof raw.name !== 'string' ||
    typeof raw.host !== 'string' ||
    !record(raw.auth) ||
    typeof raw.auth.type !== 'string'
  ) {
    throw new KeyInputError('Provide a service object with name, host and auth.type');
  }
  const allowed = ['name', 'host', 'path', 'enabled', 'https_only', 'auth', 'substitutions'];
  const authFields = ['token', 'username', 'password', 'key', 'header', 'prefix'] as const;
  if (
    Object.keys(raw).some((key) => !allowed.includes(key)) ||
    Object.keys(raw.auth).some((key) => !['type', 'headers', ...authFields].includes(key))
  ) {
    throw new KeyInputError('Unsupported service or authentication field');
  }
  const auth: GatewayAuth = { type: raw.auth.type };
  for (const field of authFields) {
    const value = raw.auth[field];
    if (value !== undefined) {
      if (typeof value !== 'string') throw new KeyInputError('Authentication fields must be strings');
      auth[field] = value;
    }
  }
  if (raw.auth.headers !== undefined) {
    if (!record(raw.auth.headers)) throw new KeyInputError('Headers must be a template map');
    auth.headers = Object.fromEntries(
      Object.entries(raw.auth.headers).map(([name, value]) => {
        if (typeof value !== 'string') throw new KeyInputError('Header templates must be strings');
        return [name, value];
      }),
    );
  }
  const service: GatewayService = { name: raw.name, host: raw.host, auth };
  if (raw.path !== undefined) {
    if (typeof raw.path !== 'string') throw new KeyInputError('Service path must be a string');
    service.path = raw.path;
  }
  for (const field of ['enabled', 'https_only'] as const) {
    if (raw[field] !== undefined) {
      if (typeof raw[field] !== 'boolean') throw new KeyInputError('Service flags must be booleans');
      service[field] = raw[field];
    }
  }
  if (raw.substitutions !== undefined) {
    if (!Array.isArray(raw.substitutions)) throw new KeyInputError('Substitutions must be an array');
    service.substitutions = raw.substitutions.map((item: unknown) => {
      if (
        !record(item) ||
        typeof item.key !== 'string' ||
        typeof item.placeholder !== 'string' ||
        Object.keys(item).some((key) => !['key', 'placeholder', 'in'].includes(key))
      ) {
        throw new KeyInputError('Invalid substitution');
      }
      if (
        item.in !== undefined &&
        (!Array.isArray(item.in) || !item.in.every((s: unknown): s is string => typeof s === 'string'))
      ) {
        throw new KeyInputError('Substitution surfaces must be strings');
      }
      return { key: item.key, placeholder: item.placeholder, ...(item.in === undefined ? {} : { in: item.in }) };
    });
  }
  return service;
}

export function checkSetRevision(raw: unknown): string {
  if (typeof raw !== 'string' || !/^"[a-f0-9]{64}"$/.test(raw))
    throw new KeyInputError('Refresh the key-set metadata and use its exact revision');
  return raw;
}
