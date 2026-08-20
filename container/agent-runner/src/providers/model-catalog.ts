/**
 * Shared model-limit catalog for providers that have to look their own limits
 * up.
 *
 * Each provider resolves models against a different catalog — OpenCode against
 * models.dev, fx against the Vercel AI Gateway — and the two disagree about
 * the same model (minimax-m3: 128k vs 1M output). So the *source* stays
 * per-provider; only the caching, lookup and normalization are shared, because
 * that is where the two implementations had already drifted into recording
 * different things from the same data.
 *
 * Claude needs none of this: its SDK reports limits with the usage itself.
 */

/** What a catalog reports, before interpretation. Zero means "not stated". */
export interface RawLimits {
  context: number;
  output: number;
}

export interface ModelLimits {
  context_window?: number;
  max_output_tokens?: number;
}

/**
 * An output cap equal to (or above) the whole context window is the absence of
 * a cap, not a cap — recording it renders a budget bar that can never move.
 * Both catalogs do this: 47 of the gateway's 226 models and 1309 of
 * models.dev's 6652 report `output >= context`.
 */
export function normalizeLimits(raw: RawLimits | undefined): ModelLimits {
  if (!raw) return {};
  const context = raw.context > 0 ? raw.context : undefined;
  const output = raw.output > 0 && (!context || raw.output < context) ? raw.output : undefined;
  return { context_window: context, max_output_tokens: output };
}

/**
 * Gateways resolve model ids case-insensitively, so a group can be pinned to
 * `openrouter/minimax/MiniMax-M3` and run fine while the catalog only lists
 * `openrouter/minimax/minimax-m3`. Exact match first — case is meaningful when
 * it does resolve.
 */
export function lookupLimits(catalog: Map<string, RawLimits>, key: string): RawLimits | undefined {
  const exact = catalog.get(key);
  if (exact) return exact;
  const wanted = key.toLowerCase();
  for (const [k, v] of catalog) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

export interface ModelCatalog {
  limitsFor(key: string | undefined): Promise<ModelLimits>;
  /** Test seam: drop the memoized catalog. */
  reset(): void;
}

/**
 * Wraps a catalog loader with memoization, inflight dedupe and a one-shot warn
 * per unknown model. Never throws: usage is worth recording without limits, so
 * a catalog failure degrades instead of failing the turn.
 */
export function createModelCatalog(
  name: string,
  load: () => Promise<Map<string, RawLimits>>,
): ModelCatalog {
  let loaded: Promise<Map<string, RawLimits>> | null = null;
  const warned = new Set<string>();
  const log = (msg: string) => console.error(`[${name}-catalog] ${msg}`);

  return {
    async limitsFor(key) {
      if (!key) return {};
      if (!loaded) {
        loaded = (async () => {
          try {
            return await load();
          } catch (err) {
            log(`unavailable: ${err instanceof Error ? err.message : String(err)}`);
            // Not cached as a failure: the next turn is a free retry, and a
            // container can outlive a transient catalog outage by days.
            loaded = null;
            return new Map<string, RawLimits>();
          }
        })();
      }
      const catalog = await loaded;
      const hit = lookupLimits(catalog, key);
      if (!hit) {
        if (catalog.size > 0 && !warned.has(key)) {
          warned.add(key);
          log(`no limits for ${key}; context/output budgets will be blank`);
        }
        return {};
      }
      return normalizeLimits(hit);
    },
    reset() {
      loaded = null;
      warned.clear();
    },
  };
}
