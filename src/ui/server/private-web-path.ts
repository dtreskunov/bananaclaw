import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import type { AgentGroup } from '../../types.js';
import { classify, resolveSafe } from './chat/classify.js';

export function resolvePrivateWebEntry(group: Pick<AgentGroup, 'folder'>, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath) || !/\.html?$/i.test(relativePath)) return null;
  const segments = relativePath.split('/');
  if (
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0') || segment.includes('\\'),
    )
  )
    return null;
  const classification = classify(relativePath);
  if (classification.kind !== 'visible' || classification.tier !== 'member') return null;
  const groupRoot = path.resolve(GROUPS_DIR, group.folder);
  const absolute = resolveSafe(groupRoot, relativePath);
  if (!absolute) return null;
  try {
    let lexical = groupRoot;
    for (const segment of segments) {
      lexical = path.join(lexical, segment);
      if (fs.lstatSync(lexical).isSymbolicLink()) return null;
    }
    if (!fs.statSync(absolute).isFile()) return null;
    return absolute;
  } catch {
    return null;
  }
}
