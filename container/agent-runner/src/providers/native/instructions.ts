import fs from 'node:fs';
import path from 'node:path';

function readIfPresent(filename: string): string | null {
  try {
    return fs.readFileSync(filename, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function loadNativeInstructions(
  runtimeInstructions?: string,
  skillInstructions?: string | null,
  todoInstructions?: string | null,
): string {
  const parts: string[] = [];
  const shared = readIfPresent('/app/CLAUDE.md');
  if (shared) parts.push(shared);

  const fragmentsDir = '/workspace/agent/.claude-fragments';
  try {
    for (const filename of fs
      .readdirSync(fragmentsDir)
      .filter((entry) => entry.endsWith('.md'))
      .sort()) {
      const fragment = readIfPresent(path.join(fragmentsDir, filename));
      if (fragment) parts.push(fragment);
    }
  } catch {
    // Optional on freshly initialized groups.
  }

  const local = readIfPresent('/workspace/agent/CLAUDE.local.md');
  if (local) parts.push(local);
  if (skillInstructions) parts.push(skillInstructions);
  if (todoInstructions) parts.push(todoInstructions);
  if (runtimeInstructions?.trim()) parts.push(runtimeInstructions.trim());
  return parts.join('\n\n');
}
