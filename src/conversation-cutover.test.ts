import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertConversationCutoverComplete, CONVERSATION_CUTOVER_MANIFEST } from './conversation-cutover.js';

const root = path.resolve('.test-cutover-startup');
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
describe('conversation cutover startup tripwire', () => {
  it('allows fresh installs and fully verified migrations only', () => {
    expect(() => assertConversationCutoverComplete(root)).not.toThrow();
    const file = path.join(root, CONVERSATION_CUTOVER_MANIFEST);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    expect(() => assertConversationCutoverComplete(root)).toThrow('manifest missing');
    for (const phase of ['backing-up', 'applying', 'verifying', 'failed', 'restoring', 'rolled-back', 'unexpected']) {
      fs.writeFileSync(file, JSON.stringify({ version: 1, phase }));
      expect(() => assertConversationCutoverComplete(root)).toThrow('incomplete');
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, phase: 'verified' }));
    expect(() => assertConversationCutoverComplete(root)).not.toThrow();
    fs.writeFileSync(file, JSON.stringify({ version: 2, phase: 'verified' }));
    expect(() => assertConversationCutoverComplete(root)).toThrow('incomplete');
    fs.writeFileSync(file, '{"truncated":');
    expect(() => assertConversationCutoverComplete(root)).toThrow();
  });
});
