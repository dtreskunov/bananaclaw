import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolSet } from 'ai';

// Native sends its final message verbatim, so the shared `<message>` wrap
// contract (module-core.md) is swapped for this one.
const NATIVE_CORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'core.md');
const SHARED_CORE = 'module-core.md';

export function nativeMediaInstructions(tools: ToolSet): string | null {
  const names = ['view_image', 'view_pdf', 'listen_audio', 'view_video'].filter((name) => tools[name]);
  if (!names.length) return null;
  const guidance = fs.readFileSync(new URL('./media.instructions.md', import.meta.url), 'utf8').trim();
  return `## Inspecting native media\n\n${names.map((name) => `- \`${name}({ path })\``).join('\n')}\n\n${guidance}`;
}

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
  mediaInstructions?: string | null,
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
      const fragment = readIfPresent(filename === SHARED_CORE ? NATIVE_CORE : path.join(fragmentsDir, filename));
      if (fragment) parts.push(fragment);
    }
  } catch {
    // Optional on freshly initialized groups.
  }

  if (mediaInstructions) parts.push(mediaInstructions);
  const local = readIfPresent('/workspace/agent/CLAUDE.local.md');
  if (local) parts.push(local);
  if (skillInstructions) parts.push(skillInstructions);
  if (todoInstructions) parts.push(todoInstructions);
  if (runtimeInstructions?.trim()) parts.push(runtimeInstructions.trim());
  return parts.join('\n\n');
}
