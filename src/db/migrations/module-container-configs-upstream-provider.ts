import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-group OpenCode upstream provider.
 *
 * The OpenCode agent provider fans out to an upstream gateway (OpenRouter,
 * DeepSeek, MiniMax, …) selected by `OPENCODE_PROVIDER`. That env var is
 * global, so every opencode group was forced onto the same upstream. This
 * column lets a single group point somewhere else — e.g. straight at
 * MiniMax's Anthropic-compatible API for the full 1M context window, while
 * the rest of the fleet stays on OpenRouter.
 *
 * NULL keeps the existing behavior (fall back to `OPENCODE_PROVIDER`).
 */
export const moduleContainerConfigsUpstreamProvider: Migration = {
  version: 28,
  name: 'container-configs-upstream-provider',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN upstream_provider TEXT').run();
  },
};
