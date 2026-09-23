/**
 * Reading a vendored skill's provenance out of git.
 *
 * A skill installed from a catalog is a symlink into a sparse clone of that
 * catalog under `<group>/skills/.catalogs/<id>@<commit>`. Everything we need to know
 * about it — where it came from, which commit, whether the agent has changed
 * it — is already recorded by git, so nothing custom is written into the repo.
 */
import fs from 'fs';
import path from 'path';

import { gitOrNull } from './git.js';

export interface SkillGitInfo {
  /** Root of the clone the skill lives in. */
  repoDir: string;
  /** `origin` remote URL, or null for a repo with no remote. */
  remote: string | null;
  commit: string | null;
  /** Path of this skill within the source repo, from the sparse-checkout list. */
  sourcePath: string | null;
  /** Uncommitted edits in the worktree. */
  modified: boolean;
  /** Commits the agent made on top of what was fetched. */
  localCommits: number;
}

/** Walk up from `dir` to find the enclosing git worktree, if any. */
export function findRepoRoot(dir: string): string | null {
  let current = path.resolve(dir);
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Provenance for a skill directory, or null when it isn't inside a clone.
 * `skillDir` is the resolved (symlink-followed) content directory.
 */
export function readSkillGit(skillDir: string): SkillGitInfo | null {
  const repoDir = findRepoRoot(skillDir);
  if (!repoDir) return null;

  const relative = path.relative(repoDir, path.resolve(skillDir)).split(path.sep).join('/');
  // Prefer the recorded sparse path; fall back to the skill's actual position,
  // which is what a full (non-sparse) clone gives.
  const sparse = gitOrNull(['sparse-checkout', 'list'], repoDir);
  const sourcePath =
    sparse
      ?.split('\n')
      .map((line) => line.trim().replace(/^\/+/, ''))
      .find((line) => line !== '' && (line === relative || relative.startsWith(`${line}/`))) ??
    (relative || null);

  const status = gitOrNull(['status', '--porcelain', '--', '.'], skillDir);
  const ahead =
    gitOrNull(['rev-list', '--count', 'origin/HEAD..HEAD'], repoDir) ??
    gitOrNull(['rev-list', '--count', '@{u}..HEAD'], repoDir);

  return {
    repoDir,
    remote: gitOrNull(['remote', 'get-url', 'origin'], repoDir),
    commit: gitOrNull(['rev-parse', 'HEAD'], repoDir),
    sourcePath,
    modified: status !== null && status !== '',
    localCommits: Number.parseInt(ahead ?? '0', 10) || 0,
  };
}

/**
 * Fetch and report whether the catalog clone has moved on. Network-bound, so
 * callers should treat a null as "unknown" rather than "up to date".
 */
export function checkForUpdate(repoDir: string): boolean | null {
  if (gitOrNull(['fetch', '--depth', '1', 'origin'], repoDir) === null) return null;
  const local = gitOrNull(['rev-parse', 'HEAD'], repoDir);
  const remote = gitOrNull(['rev-parse', 'FETCH_HEAD'], repoDir);
  if (!local || !remote) return null;
  return local !== remote;
}
