import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { clearStaleProcessingAcks, closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { getMessageIn, getPendingMessages, markProcessing, type MessageInRow } from './db/messages-in.js';
import type { AgentProvider, AgentQuery, SteeringInput } from './providers/types.js';
import { processPendingInputEdits, readInputEditReceipt, writeInputState } from './steering.js';

let sequence = 0;
const owner = '00000000-0000-0000-0000-000000000001';
const provider: AgentProvider = {
  supportsNativeSlashCommands: false,
  supportsInputEditing: true,
  isSessionInvalid: () => false,
  query: () => { throw new Error('No model call expected'); },
};
beforeEach(() => {
  initTestSessionDb({ unifiedHostProjection: true });
  sequence = 0;
});
afterEach(closeSessionDb);

function insert(id: string, content: Record<string, unknown>, kind = 'chat'): MessageInRow {
  getInboundDb().prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, channel_type, platform_id, thread_id,
      sender_user_id, sender_identity, trigger, content)
     VALUES (?, ?, ?, datetime('now'), 'web', 'room', 'thread', ?, 'web:owner', ?, ?)`,
  ).run(id, sequence += 2, kind, owner, kind === 'system' ? 0 : 1, JSON.stringify(content));
  return getMessageIn(id)!;
}

function edit(messageId = 'target', expectedText = 'before', replacementText = 'after') {
  const requestId = randomUUID();
  insert(`edit-${requestId}`, { action: 'edit_input', requestId, messageId, expectedText, replacementText }, 'system');
  return requestId;
}

function activeBuffer(message: MessageInRow, accepts = true) {
  const replacements: SteeringInput[] = [];
  const query: AgentQuery = {
    replaceSteering(input) { replacements.push(input); return accepts; },
    push: () => false,
    end() {},
    abort() {},
    events: (async function* () {})(),
  };
  return { query, steeringInputs: new Map([[message.id, message]]), replacements };
}

describe('pending input edit CAS', () => {
  it('changes only queued text, preserving attachments, position, ID and intent without a provider call', () => {
    const before = insert('target', {
      text: 'before', files: [{ path: '/workspace/image.png', mime: 'image/png', filename: 'image.png' }],
      inputHandling: { mode: 'queue', turnId: 'turn' }, custom: 'kept',
    });
    insert('later', { text: 'later' });
    const requestId = edit();
    processPendingInputEdits(provider);
    expect(getMessageIn('target')).toEqual({
      ...before, content: JSON.stringify({ ...JSON.parse(before.content), text: 'after' }),
    });
    expect(getPendingMessages().map((row) => row.id)).toEqual(['target', 'later']);
    expect(readInputEditReceipt(requestId)).toEqual({ requestId, messageId: 'target', status: 'accepted' });
    expect(getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(`edit-${requestId}`))
      .toEqual({ status: 'completed' });
    const events = getOutboundDb().prepare("SELECT payload FROM pending_runner_events WHERE event_type = 'state.upsert'").all();
    expect(JSON.stringify(events)).toContain(`input-edit:${requestId}`);
  });

  it('replaces the accepted steering buffer and in-process row synchronously', () => {
    const before = insert('target', { text: 'before', inputHandling: { mode: 'steer', turnId: 'turn' } });
    const active = activeBuffer(before);
    const requestId = edit();
    processPendingInputEdits(provider, 'continuation', active);
    expect(active.replacements).toHaveLength(1);
    expect(active.replacements[0].prompt).toContain('after');
    expect(active.replacements[0].id).toBe('target');
    expect(active.steeringInputs.get('target')).toEqual(getMessageIn('target'));
    expect(readInputEditReceipt(requestId)?.status).toBe('accepted');
  });

  it('rejects preparation/consumption races without changing the buffer or projection', () => {
    const before = insert('target', { text: 'before' });
    const active = activeBuffer(before, false);
    const requestId = edit();
    processPendingInputEdits(provider, 'continuation', active);
    expect(readInputEditReceipt(requestId)).toMatchObject({ status: 'conflict', reason: 'steering_consumed' });
    expect(getMessageIn('target')).toEqual(before);
    expect(active.steeringInputs.get('target')).toEqual(before);
  });

  it.each(['processing', 'completed', 'applied'] as const)('rejects %s targets, including provider crash recovery', (state) => {
    const before = insert('target', { text: 'before' });
    if (state === 'processing') markProcessing(['target']);
    if (state === 'completed') getInboundDb().prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run('target');
    const active = activeBuffer(before);
    const requestId = edit();
    processPendingInputEdits({
      ...provider, appliedSteering: () => state === 'applied' ? ['target'] : [],
    }, 'continuation', active);
    expect(readInputEditReceipt(requestId)).toMatchObject({ status: 'conflict', reason: 'not_pending' });
    expect(getMessageIn('target')?.content).toBe(before.content);
    expect(active.replacements).toEqual([]);
  });

  it('rejects stale text and unsupported providers explicitly', () => {
    insert('target', { text: 'before' });
    const stale = edit('target', 'stale');
    processPendingInputEdits(provider);
    expect(readInputEditReceipt(stale)).toMatchObject({ status: 'conflict', reason: 'text_changed' });
    const unsupported = edit();
    processPendingInputEdits({ ...provider, supportsInputEditing: false });
    expect(readInputEditReceipt(unsupported)).toMatchObject({ status: 'conflict', reason: 'unsupported' });
  });

  it.each(['current', 'legacy'] as const)('retains %s ordinary input claims across crash cleanup and late edit delivery', (version) => {
    const before = insert('target', { text: 'before' });
    if (version === 'current') markProcessing(['target']);
    else getOutboundDb().prepare(
      "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('target', 'processing', datetime('now'))",
    ).run();
    clearStaleProcessingAcks();
    expect(getPendingMessages().map((row) => row.id)).toEqual(['target']);
    expect(getOutboundDb().prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get('target')).toBeNull();
    // Even if a retry later displays queued again, the immutable claim survives.
    writeInputState({ messageId: 'target', status: 'queued' });
    const requestId = edit();
    processPendingInputEdits({ ...provider, appliedSteering: () => [] }, 'continuation');
    expect(readInputEditReceipt(requestId)).toMatchObject({ status: 'conflict', reason: 'not_pending' });
    expect(getMessageIn('target')).toEqual(before);
  });

  it.each(['processing', 'applied'] as const)('rejects durable %s dispositions even without acknowledgements', (status) => {
    const before = insert('target', { text: 'before' });
    writeInputState({ messageId: 'target', status });
    const requestId = edit();
    processPendingInputEdits(provider);
    expect(readInputEditReceipt(requestId)).toMatchObject({ status: 'conflict', reason: 'not_pending' });
    expect(getMessageIn('target')).toEqual(before);
  });

  it.each([
    ["sender_user_id", '00000000-0000-0000-0000-000000000002'],
    ['sender_identity', 'web:other'], ['channel_type', 'telegram'], ['platform_id', 'elsewhere'],
    ['thread_id', 'other-thread'], ['kind', 'task'], ['source_session_id', 'source'],
    ['source_session_id', ''], ['trigger', 0],
  ])('rejects mismatched target %s', (field, value) => {
    const before = insert('target', { text: 'before' });
    const requestId = edit();
    getInboundDb().prepare(`UPDATE messages_in SET ${field} = ? WHERE id = 'target'`).run(value);
    processPendingInputEdits(provider);
    expect(readInputEditReceipt(requestId)).toMatchObject({ status: 'conflict', reason: 'not_pending' });
    expect(getMessageIn('target')?.content).toBe(before.content);
  });

  it('replays the receipt without reverting later edits or calling the provider after recovery', () => {
    insert('target', { text: 'before' });
    const first = edit();
    processPendingInputEdits(provider);
    const second = edit('target', 'after', 'latest');
    processPendingInputEdits(provider);
    // Simulate a replayed request after a crash with its durable receipt retained.
    getOutboundDb().prepare('DELETE FROM processing_ack WHERE message_id = ?').run(`edit-${first}`);
    const active = activeBuffer(getMessageIn('target')!);
    processPendingInputEdits(provider, 'continuation', active);
    expect(active.replacements).toEqual([]);
    expect(JSON.parse(getMessageIn('target')!.content).text).toBe('latest');
    expect(readInputEditReceipt(first)?.status).toBe('accepted');
    expect(readInputEditReceipt(second)?.status).toBe('accepted');
  });

  it('keeps conflict receipts immutable when the same UUID is retried with now-valid text', () => {
    const before = insert('target', { text: 'before' });
    const requestId = edit('target', 'stale');
    processPendingInputEdits(provider);
    const receipt = getOutboundDb().prepare('SELECT * FROM session_state WHERE key = ?')
      .get(`input-edit:${requestId}`);
    const stateEvents = () => getOutboundDb().prepare(
      "SELECT COUNT(*) AS n FROM pending_runner_events WHERE event_type = 'state.upsert'",
    ).get();
    const journalBefore = stateEvents();
    getInboundDb().prepare('UPDATE messages_in SET content = ? WHERE id = ?').run(JSON.stringify({
      action: 'edit_input', requestId, messageId: 'target', expectedText: 'before', replacementText: 'after',
    }), `edit-${requestId}`);
    getOutboundDb().prepare('DELETE FROM processing_ack WHERE message_id = ?').run(`edit-${requestId}`);
    processPendingInputEdits(provider);
    expect(getOutboundDb().prepare('SELECT * FROM session_state WHERE key = ?')
      .get(`input-edit:${requestId}`)).toEqual(receipt);
    expect(readInputEditReceipt(requestId)).toEqual({
      requestId, messageId: 'target', status: 'conflict', reason: 'text_changed',
    });
    expect(stateEvents()).toEqual(journalBefore);
    expect(getMessageIn('target')).toEqual(before);
  });

  it('finds edits before the prompt cap without starving ordinary input or consuming other system messages', () => {
    insert('target', { text: 'before' });
    const requests = Array.from({ length: 20 }, (_, index) => edit('target', index === 0 ? 'before' : `edit-${index - 1}`, `edit-${index}`));
    insert('unrelated-system', { action: 'ask_user_question', text: 'response' }, 'system');
    expect(getPendingMessages().map((row) => row.id)).toEqual(['target', 'unrelated-system']);
    processPendingInputEdits(provider);
    expect(requests.every((id) => readInputEditReceipt(id)?.status === 'accepted')).toBe(true);
    expect(JSON.parse(getMessageIn('target')!.content).text).toBe('edit-19');
    expect(getOutboundDb().prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get('unrelated-system')).toBeNull();
  });
});
