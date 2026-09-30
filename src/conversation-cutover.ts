import fs from 'node:fs';
import path from 'node:path';

export const CONVERSATION_CUTOVER_MANIFEST = '.conversation-cutover/manifest.json';

/** A partial multi-file migration must never be mistaken for a ready install. */
export function assertConversationCutoverComplete(dataDir: string): void {
  const file = path.join(dataDir, CONVERSATION_CUTOVER_MANIFEST);
  if (!fs.existsSync(path.dirname(file))) return;
  if (!fs.existsSync(file)) throw new Error('Conversation cutover manifest missing; see docs/conversation-cutover.md');
  const manifest: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !('version' in manifest) ||
    manifest.version !== 1 ||
    !('phase' in manifest) ||
    manifest.phase !== 'verified'
  ) {
    throw new Error('Conversation cutover incomplete; see docs/conversation-cutover.md. Do not start either peer.');
  }
}
