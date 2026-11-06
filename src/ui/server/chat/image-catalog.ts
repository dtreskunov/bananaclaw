/**
 * Image catalog — lists docker images matching the install's image base so
 * the per-group admin UI can offer a dropdown of valid `image_tag` values.
 *
 * `image_tag` in container_configs is stored as the full image reference
 * (e.g. `nanoclaw-agent-v2-ee228f4e:ag-1779840987143-r0nb8p`) and passed
 * verbatim to `docker run`. Per-group rebuilds create one image per group;
 * the default image is also valid.
 */
import { execFileSync } from 'child_process';

import { CONTAINER_IMAGE, CONTAINER_IMAGE_BASE } from '../../../config.js';
import { CONTAINER_RUNTIME_BIN } from '../../../container-runtime.js';
import { log } from '../../../log.js';
import { epochMs } from '../../../time.js';

export interface ImageSuggestion {
  /** Full image reference (`<base>:<tag>`) — stored verbatim in container_configs.image_tag. */
  value: string;
  /** Display label (just the tag portion). */
  label: string;
  /** Epoch milliseconds (used for "age"). */
  createdAt: number | null;
  /** Image size in bytes (or null if unavailable). */
  size: number | null;
  /** True if this matches the install's default image (CONTAINER_IMAGE). */
  isDefault: boolean;
}

interface CacheEntry {
  at: number;
  images: ImageSuggestion[];
}

const CACHE_TTL_MS = 30 * 1000; // 30s — images change rarely; bust on demand later.
let cache: CacheEntry | null = null;

interface DockerImageRow {
  // Docker emits Pascal-case strings; podman (which we use here, exposed via
  // a docker-compatible CLI) emits lowercase repository/tag, numeric Created
  // (epoch seconds) and numeric Size (bytes). Accept both shapes.
  Repository?: string;
  Tag?: string;
  CreatedAt?: string;
  Size?: string | number;
  repository?: string;
  tag?: string;
  Created?: string | number;
}

function parseSizeBytes(size: string | number | undefined): number | null {
  if (size == null) return null;
  if (typeof size === 'number') return size;
  const m = /^([\d.]+)\s*([kMGT]?B)$/i.exec(size.trim());
  if (!m) return null;
  const n = parseFloat(m[1]!);
  const unit = m[2]!.toUpperCase();
  const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(n * (mult[unit] ?? 1));
}

function parseCreatedAt(row: DockerImageRow): number | null {
  if (typeof row.Created === 'number') {
    return epochMs(row.Created * 1000);
  }
  const raw = row.CreatedAt ?? (typeof row.Created === 'string' ? row.Created : undefined);
  if (!raw) return null;
  // Docker / podman emit "2026-06-04 02:10:12 +0000 UTC".
  const cleaned = raw.replace(/\s+UTC$/, '');
  const ms = Date.parse(cleaned);
  if (Number.isNaN(ms)) return null;
  return epochMs(ms);
}

export function listImages(): ImageSuggestion[] {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.images;
  let images: ImageSuggestion[] = [];
  try {
    // `docker images <ref> --format '{{json .}}'` is reliable across docker
    // versions and podman (which exposes a docker-compatible CLI).
    const out = execFileSync(CONTAINER_RUNTIME_BIN, ['images', '--format', '{{json .}}', CONTAINER_IMAGE_BASE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 5000,
    });
    const rows = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as DockerImageRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is DockerImageRow => !!r);

    images = rows
      .map((r) => ({ ...r, _tag: r.Tag ?? r.tag, _repo: r.Repository ?? r.repository }))
      .filter((r) => r._tag && r._tag !== '<none>')
      .map((r): ImageSuggestion => {
        // Use the bare base (no `localhost/` prefix) so the stored value
        // matches what container-runner.ts builds when it constructs new tags
        // (CONTAINER_IMAGE_BASE:<gid>) and what CONTAINER_IMAGE points at.
        const ref = `${CONTAINER_IMAGE_BASE}:${r._tag}`;
        return {
          value: ref,
          label: r._tag!,
          createdAt: parseCreatedAt(r),
          size: parseSizeBytes(r.Size),
          isDefault: ref === CONTAINER_IMAGE,
        };
      })
      // Newest first; falls back to label for items without timestamps.
      .sort((a, b) => {
        const ta = a.createdAt ?? 0;
        const tb = b.createdAt ?? 0;
        if (tb !== ta) return tb - ta;
        return a.label.localeCompare(b.label);
      });
  } catch (err) {
    log.warn('image catalog: docker images failed', { err: String(err) });
  }
  cache = { at: Date.now(), images };
  return images;
}
