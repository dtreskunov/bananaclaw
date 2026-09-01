import fs from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-durable-link-test',
}));

import { initSessionFolder, outboundDbPath } from './session-manager.js';
import { applyDurableRunnerEvent } from './session-link-durable.js';

const ROOT = '/tmp/nanoclaw-durable-link-test';
const AGENT_GROUP_ID = 'agent-a';
const SESSION_ID = 'session-a';

function messagePayload(content: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'out-1',
    seq: 1,
    in_reply_to: null,
    timestamp: '2026-09-01 00:00:00',
    deliver_after: null,
    recurrence: null,
    kind: 'chat',
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify(content),
  };
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  initSessionFolder(AGENT_GROUP_ID, SESSION_ID);
});

afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('applyDurableRunnerEvent', () => {
  it('applies the complete durable event vocabulary in journal order', () => {
    let sequence = 0;
    const apply = (type: string, payload: Record<string, unknown>) =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        eventId: `event-${++sequence}`,
        sequence,
        event: { type, payload },
      });

    apply('message.upsert', {
      id: 'out-1',
      seq: 1,
      in_reply_to: null,
      timestamp: '2026-09-01 00:00:00',
      deliver_after: null,
      recurrence: null,
      kind: 'chat',
      platform_id: 'chat-1',
      channel_type: 'web',
      thread_id: null,
      content: '{"text":"hello"}',
    });
    apply('processing.upsert', {
      message_id: 'in-1',
      status: 'processing',
      status_changed: '2026-09-01 00:00:01',
    });
    apply('state.upsert', {
      key: 'continuation:native',
      value: 'continuation-1',
      updated_at: '2026-09-01 00:00:02',
    });
    apply('container.upsert', {
      id: 1,
      current_tool: 'Bash',
      tool_declared_timeout_ms: 1000,
      tool_started_at: '2026-09-01 00:00:03',
      updated_at: '2026-09-01 00:00:03',
    });
    apply('checkpoint.upsert', {
      message_out_id: 'out-1',
      provider: 'native',
      continuation: 'continuation-1',
      provider_turn_ref: 'turn-1',
      created_at: '2026-09-01 00:00:04',
    });
    apply('activity.persist', {
      message_out_id: 'out-1',
      ordinal: 0,
      ts: '1',
      text: '{"kind":"notification","id":"n1","text":"ok"}',
    });
    apply('usage.persist', {
      id: 'usage-1',
      message_out_id: 'out-1',
      cost_usd: 0.1,
      input_tokens: 10,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: null,
      num_turns: null,
      duration_ms: null,
      duration_api_ms: null,
      model: 'test/model',
      context_window: null,
      max_output_tokens: null,
      context_tokens: null,
      timestamp: '2026-09-01 00:00:05',
    });
    apply('task-attempt.upsert', {
      task_message_id: 'task-1',
      series_id: 'series-1',
      trigger_source: 'manual',
      status: 'skipped',
      started_at: '2026-09-01 00:00:06',
      completed_at: '2026-09-01 00:00:07',
      duration_ms: 1,
      exit_code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      error: null,
      wake_agent: 0,
      provider_invoked: 0,
    });
    apply('processing.delete', { message_id: 'in-1' });
    apply('state.delete', { key: 'continuation:native' });

    const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
    try {
      expect(db.prepare('SELECT id, seq FROM messages_out').all()).toEqual([{ id: 'out-1', seq: 1 }]);
      expect(db.prepare('SELECT * FROM processing_ack').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM session_state').all()).toEqual([]);
      expect(db.prepare('SELECT current_tool FROM container_state').pluck().get()).toBe('Bash');
      expect(db.prepare('SELECT provider_turn_ref FROM turn_checkpoints').pluck().get()).toBe('turn-1');
      expect(db.prepare('SELECT text FROM turn_activity').pluck().get()).toContain('notification');
      expect(db.prepare('SELECT model FROM turn_usage').pluck().get()).toBe('test/model');
      expect(db.prepare('SELECT status FROM task_attempts').pluck().get()).toBe('skipped');
      expect(db.prepare('SELECT COUNT(*) FROM applied_runner_events').pluck().get()).toBe(sequence);
    } finally {
      db.close();
    }
  });

  it('rejects malformed message content without advancing the event ledger', () => {
    expect(() =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        eventId: 'bad-1',
        sequence: 1,
        event: {
          type: 'message.upsert',
          payload: {
            id: 'out-1',
            seq: 1,
            in_reply_to: null,
            timestamp: 'now',
            deliver_after: null,
            recurrence: null,
            kind: 'chat',
            platform_id: null,
            channel_type: null,
            thread_id: null,
            content: 'not-json',
          },
        },
      }),
    ).toThrow('invalid message content');

    const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) FROM applied_runner_events').pluck().get()).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM messages_out').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  it.each([
    ['too many files', { files: Array.from({ length: 33 }, (_, index) => `file-${index}.txt`) }, 'invalid outbound files'],
    ['unsafe file name', { files: ['../secret.txt'] }, 'invalid outbound files'],
    ['too many question options', { options: Array.from({ length: 51 }, (_, index) => `option-${index}`) }, 'invalid question options'],
  ])('rejects message content with %s', (_label, content, error) => {
    expect(() =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        eventId: 'bad-1',
        sequence: 1,
        event: { type: 'message.upsert', payload: messagePayload(content) },
      }),
    ).toThrow(error);
  });

  it('rejects excessively deep message content', () => {
    let content: Record<string, unknown> = { value: 'leaf' };
    for (let depth = 0; depth < 17; depth++) content = { nested: content };
    expect(() =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        eventId: 'bad-1',
        sequence: 1,
        event: { type: 'message.upsert', payload: messagePayload(content) },
      }),
    ).toThrow('message content exceeds structural limits');
  });

  it.each([
    [
      'oversized session state',
      'state.upsert',
      { key: 'continuation:native', value: 'x'.repeat(1024 * 1024 + 1), updated_at: '2026-09-01 00:00:00' },
      'invalid state.upsert payload',
    ],
    [
      'oversized declared tool timeout',
      'container.upsert',
      {
        id: 1,
        current_tool: 'Bash',
        tool_declared_timeout_ms: 6 * 60 * 60 * 1000 + 1,
        tool_started_at: '2026-09-01 00:00:00',
        updated_at: '2026-09-01 00:00:00',
      },
      'invalid container.upsert payload',
    ],
  ])('rejects %s without advancing the ledger', (_label, type, payload, error) => {
    expect(() =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        eventId: 'bad-1',
        sequence: 1,
        event: { type, payload },
      }),
    ).toThrow(error);
    const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) FROM applied_runner_events').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  it('defers response delivery until the turn persistence marker', () => {
    const messageResult = applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
      eventId: 'event-1',
      sequence: 1,
      event: {
        type: 'message.upsert',
        payload: {
          id: 'out-1',
          seq: 1,
          in_reply_to: null,
          timestamp: '2026-09-01 00:00:00',
          deliver_after: null,
          recurrence: null,
          kind: 'chat',
          platform_id: 'chat-1',
          channel_type: 'web',
          thread_id: null,
          content: '{"text":"hello","delivery_origin":"response"}',
        },
      },
    });
    expect(messageResult.deliveryReady).toBe(false);

    const turnResult = applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
      eventId: 'event-2',
      sequence: 2,
      event: { type: 'turn.persisted', payload: {} },
    });
    expect(turnResult.deliveryReady).toBe(true);
  });
});
