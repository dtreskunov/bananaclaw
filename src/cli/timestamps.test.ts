import { expect, it } from 'vitest';

import { serializeCliTimestamps } from './timestamps.js';
import { dispatch } from './dispatch.js';
import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createApproval } from '../db/approvals.js';
import { register } from './registry.js';
import './resources/users.js';
import './resources/approvals.js';

it('formats only public CLI record timestamps, leaving opaque metadata untouched', () => {
  const metadata = { created_at: 0, timestamp: 1 };
  expect(serializeCliTimestamps([{ created_at: 0, resolved_at: null, metadata }])).toEqual([
    { created_at: '1970-01-01T00:00:00.000Z', resolved_at: null, metadata },
  ]);
  expect(() => serializeCliTimestamps({ created_at: NaN })).toThrow('Invalid epoch-millisecond timestamp');
});

it('does not traverse opaque approval input, data, model parameters, content or nested arrays', () => {
  const opaque = {
    timestamp: 1.5,
    created_at: 0,
    updated_at: 42,
    data: [{ timestamp: 9, created_at: 8 }],
  };
  const content = JSON.stringify(opaque);
  const original = {
    created_at: 0,
    updated_at: 1000,
    input: { payload: opaque },
    payload: opaque,
    data: opaque,
    model_params: opaque,
    metadata: opaque,
    content,
  };
  const serialized = serializeCliTimestamps(original);
  expect(serialized).toEqual({
    ...original,
    created_at: '1970-01-01T00:00:00.000Z',
    updated_at: '1970-01-01T00:00:01.000Z',
  });
  expect(serialized).toHaveProperty('input', original.input);
  expect(serialized).toHaveProperty('payload', opaque);
  expect(original.created_at).toBe(0);
  expect(serializeCliTimestamps([[opaque], original])).toEqual([
    [opaque],
    { ...original, created_at: '1970-01-01T00:00:00.000Z', updated_at: '1970-01-01T00:00:01.000Z' },
  ]);
});

it('preserves opaque approval payloads when dispatch serializes host interaction dates', async () => {
  runMigrations(initTestDb());
  try {
    const payload = { timestamp: 1.5, created_at: 0, data: [{ timestamp: 12, created_at: 13 }] };
    const input = { action: 'test', payload, title: 'Test', options: [] };
    createApproval({ id: 'opaque', request_id: 'opaque', created_at: 0, input });
    expect(
      await dispatch({ id: 'get', command: 'approvals-get', args: { id: 'opaque' } }, { caller: 'host' }),
    ).toMatchObject({
      ok: true,
      data: { created_at: '1970-01-01T00:00:00.000Z', updated_at: '1970-01-01T00:00:00.000Z', input },
    });
  } finally {
    closeDb();
  }
});

it('does not format external gateway payloads, including top-level date-looking numeric fields', async () => {
  const gatewayPayload = {
    timestamp: 123,
    created_at: 456,
    data: [{ timestamp: 1.5, created_at: 0 }],
    metadata: { created_at: 0 },
  };
  register({
    name: 'credentials-timestamp-boundary-regression',
    resource: 'credentials',
    description: 'Timestamp boundary regression fixture',
    access: 'open',
    parseArgs: (raw) => raw,
    handler: async () => gatewayPayload,
  });
  const result = await dispatch(
    { id: 'gateway', command: 'credentials-timestamp-boundary-regression', args: {} },
    { caller: 'host' },
  );
  expect(result).toEqual({ id: 'gateway', ok: true, data: gatewayPayload });
  if (!result.ok) throw new Error('Expected host gateway fixture response');
  expect(result.data).toBe(gatewayPayload);
});

it('parses external CLI date filters once and rejects invalid timestamp arguments', async () => {
  runMigrations(initTestDb());
  try {
    createApproval({
      id: 'a',
      request_id: 'a',
      created_at: 0,
      input: { action: 'test', payload: {}, title: 'Test', options: [] },
    });
    const result = await dispatch(
      { id: 'list', command: 'approvals-list', args: { created_at: '1970-01-01T00:00:00.000Z' } },
      { caller: 'host' },
    );
    expect(result).toMatchObject({ ok: true, data: [{ id: 'a', created_at: '1970-01-01T00:00:00.000Z' }] });
    expect(getDb().prepare('SELECT created_at FROM interactions WHERE id=?').get('a')).toEqual({ created_at: 0 });
    expect(
      await dispatch(
        { id: 'invalid', command: 'approvals-list', args: { created_at: 'not-a-date' } },
        { caller: 'host' },
      ),
    ).toMatchObject({ ok: false, error: { message: 'Invalid timestamp' } });
    expect(
      await dispatch({ id: 'invalid-type', command: 'approvals-list', args: { created_at: 0 } }, { caller: 'host' }),
    ).toMatchObject({ ok: false, error: { message: 'created_at must be a timestamp string' } });
  } finally {
    closeDb();
  }
});

it('stores numeric CLI-created records while returning documented ISO output', async () => {
  runMigrations(initTestDb());
  try {
    const result = await dispatch(
      { id: 'create', command: 'users-create', args: { id: 'test-user', kind: 'web', display_name: 'Test' } },
      { caller: 'host' },
    );
    expect(result.ok).toBe(true);
    const row = getDb().prepare('SELECT created_at FROM users').get() as { created_at: number };
    expect(typeof row.created_at).toBe('number');
    expect(result).toMatchObject({ data: { created_at: new Date(row.created_at).toISOString() } });
  } finally {
    closeDb();
  }
});
