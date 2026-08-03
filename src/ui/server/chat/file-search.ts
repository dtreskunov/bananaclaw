import fs from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';

import { classify, resolveSafe } from './classify.js';

export const FILE_SEARCH_LIMIT = 100;
export const FILE_SEARCH_SCAN_LIMIT = 50_000;

export interface FileSearchResult {
  path: string;
  name: string;
  type: 'file';
  size?: number;
  mtime?: string;
  tier?: 'member' | 'admin';
}

export interface FileSearchResponse {
  results: FileSearchResult[];
  truncated: boolean;
}

interface RankedResult {
  result: FileSearchResult;
  rank: number;
}

function matchRank(name: string, query: string): number | null {
  const candidate = name.toLowerCase();
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 1;
  return candidate.includes(query) ? 2 : null;
}

export async function searchFilesByName(
  groupDir: string,
  rootPath: string,
  query: string,
  isAdmin: boolean,
): Promise<FileSearchResponse | null> {
  const root = resolveSafe(groupDir, rootPath);
  if (!root) return null;
  try {
    if (!(await fs.stat(root)).isDirectory()) return null;
  } catch {
    return null;
  }

  const needle = query.trim().toLowerCase();
  if (!needle) return { results: [], truncated: false };

  const queue = [{ absolute: root, relative: rootPath }];
  const matches: RankedResult[] = [];
  let directoryIndex = 0;
  let scanned = 0;
  let truncated = false;

  walk: while (directoryIndex < queue.length) {
    const directory = queue[directoryIndex++]!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory.absolute, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      scanned += 1;
      if (scanned > FILE_SEARCH_SCAN_LIMIT) {
        truncated = true;
        break walk;
      }

      const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
      const classification = classify(relative);
      if (classification.kind === 'hidden') continue;
      if (classification.tier === 'admin' && !isAdmin) continue;

      if (entry.isDirectory()) {
        const child = resolveSafe(groupDir, relative);
        if (child) queue.push({ absolute: child, relative });
        continue;
      }
      if (!entry.isFile()) continue;

      const rank = matchRank(entry.name, needle);
      if (rank == null) continue;

      const result: FileSearchResult = {
        path: relative,
        name: entry.name,
        type: 'file',
        tier: classification.tier,
      };
      try {
        const stat = await fs.stat(path.join(directory.absolute, entry.name));
        result.size = stat.size;
        result.mtime = stat.mtime.toISOString();
      } catch {
        // A matching file can disappear between readdir and stat.
      }
      matches.push({ result, rank });
    }
  }

  matches.sort((left, right) => left.rank - right.rank || left.result.path.localeCompare(right.result.path));
  if (matches.length > FILE_SEARCH_LIMIT) truncated = true;
  return {
    results: matches.slice(0, FILE_SEARCH_LIMIT).map(({ result }) => result),
    truncated,
  };
}
