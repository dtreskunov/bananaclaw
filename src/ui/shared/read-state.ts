import { id, shape } from './validation.js';

export interface ReadCursor {
  sessionId: string;
  key: string;
}

const cursor = shape({ sessionId: id, key: value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) });
export function isReadCursor(value: unknown): value is ReadCursor { return cursor(value); }
