import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  fxSessionDir,
  readFxCommitPosition,
  rewindFxCommitPosition,
  type FxCommitPosition,
} from './fx-session-store.js';

const GEN = '364ab86065059b45a9392c4f10e0cf42';
const OTHER_GEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SESSION_ID = '1787261026998-1787261026998058391-b511a420ce84c188';

function eventLine(seq: number, generation = GEN): string {
  return (
    JSON.stringify({
      schema_version: 1,
      log_generation: generation,
      seq,
      event_id: seq.toString(16).padStart(32, '0'),
      timestamp_ms: 1787261026998 + seq,
      kind: seq === 1 ? 'session_started' : 'history_turn_committed',
      payload: {},
    }) + '\n'
  );
}

/** A three-event log whose watermark sits at the last event. */
function makeSession(overrides: Partial<FxCommitPosition> = {}, generation = GEN): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-store-'));
  const dir = fxSessionDir(root, SESSION_ID);
  fs.mkdirSync(dir, { recursive: true });

  let log = '';
  const offsets: number[] = [];
  for (const seq of [1, 2, 3]) {
    log += eventLine(seq, generation);
    offsets.push(Buffer.byteLength(log));
  }
  fs.writeFileSync(path.join(dir, 'events.jsonl'), log);
  fs.writeFileSync(
    path.join(dir, `commit.${generation}.json`),
    JSON.stringify({
      schema_version: 1,
      session_id: SESSION_ID,
      log_generation: generation,
      through_seq: 3,
      through_event_id: (3).toString(16).padStart(32, '0'),
      through_event_log_bytes: offsets[2],
      ...overrides,
    }),
  );
  return dir;
}

/** The position a checkpoint would have captured after turn 2. */
function turn2Position(dir: string): FxCommitPosition {
  const log = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  const bytes = Buffer.byteLength(eventLine(1) + eventLine(2));
  expect(log.length).toBeGreaterThan(bytes);
  return {
    schema_version: 1,
    session_id: SESSION_ID,
    log_generation: GEN,
    through_seq: 2,
    through_event_id: (2).toString(16).padStart(32, '0'),
    through_event_log_bytes: bytes,
  };
}

describe('readFxCommitPosition', () => {
  test('resolves the watermark via the log generation', () => {
    const dir = makeSession();
    expect(readFxCommitPosition(dir)?.through_seq).toBe(3);
  });

  test('returns null when the watermark names a different generation', () => {
    // The filename is derived from the log, so a mismatched body means the
    // session was tampered with or the format moved.
    const dir = makeSession({ log_generation: OTHER_GEN });
    expect(readFxCommitPosition(dir)).toBeNull();
  });

  test('returns null on an unknown schema version', () => {
    const dir = makeSession({ schema_version: 2 });
    expect(readFxCommitPosition(dir)).toBeNull();
  });

  test('returns null when there is no session on disk', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-store-'));
    expect(readFxCommitPosition(fxSessionDir(root, SESSION_ID))).toBeNull();
  });
});

describe('rewindFxCommitPosition', () => {
  test('lowers the watermark and leaves the event log untouched', () => {
    const dir = makeSession();
    const before = fs.readFileSync(path.join(dir, 'events.jsonl'));
    expect(rewindFxCommitPosition(dir, turn2Position(dir))).toBe(true);
    expect(readFxCommitPosition(dir)?.through_seq).toBe(2);
    expect(fs.readFileSync(path.join(dir, 'events.jsonl'))).toEqual(before);
  });

  test('writes exactly the six fields fx accepts, and no others', () => {
    const dir = makeSession();
    rewindFxCommitPosition(dir, turn2Position(dir));
    const raw = fs.readFileSync(path.join(dir, `commit.${GEN}.json`), 'utf8');
    expect(Object.keys(JSON.parse(raw) as object)).toEqual([
      'schema_version',
      'session_id',
      'log_generation',
      'through_seq',
      'through_event_id',
      'through_event_log_bytes',
    ]);
    // fx's own encoder emits no trailing newline.
    expect(raw.endsWith('}')).toBe(true);
  });

  test('declines when a pending commit intent is present', () => {
    const dir = makeSession();
    fs.writeFileSync(path.join(dir, 'commit.pending.json'), '{}');
    expect(rewindFxCommitPosition(dir, turn2Position(dir))).toBe(false);
    expect(readFxCommitPosition(dir)?.through_seq).toBe(3);
  });

  test('declines when a pending authority intent is present', () => {
    const dir = makeSession();
    fs.writeFileSync(path.join(dir, 'authority.pending.json'), '{}');
    expect(rewindFxCommitPosition(dir, turn2Position(dir))).toBe(false);
  });

  test('declines when compaction rolled the log generation', () => {
    const dir = makeSession({}, OTHER_GEN);
    // Anchor captured under the old generation; its offsets mean nothing now.
    expect(rewindFxCommitPosition(dir, { ...turn2Position(dir), log_generation: GEN })).toBe(false);
  });

  test('declines when the target is past the end of the log', () => {
    const dir = makeSession();
    const beyond = { ...turn2Position(dir), through_event_log_bytes: 10_000_000 };
    expect(rewindFxCommitPosition(dir, beyond)).toBe(false);
  });

  test('declines a position belonging to another session', () => {
    const dir = makeSession();
    expect(rewindFxCommitPosition(dir, { ...turn2Position(dir), session_id: 'someone-else' })).toBe(false);
  });

  test('declines a malformed position rather than writing it', () => {
    const dir = makeSession();
    const bad = { ...turn2Position(dir), through_seq: 1.5 };
    expect(rewindFxCommitPosition(dir, bad)).toBe(false);
    expect(readFxCommitPosition(dir)?.through_seq).toBe(3);
  });

  test('leaves no temp file behind', () => {
    const dir = makeSession();
    rewindFxCommitPosition(dir, turn2Position(dir));
    expect(fs.readdirSync(dir).filter((f) => f.includes('nanoclaw-tmp'))).toEqual([]);
  });
});
