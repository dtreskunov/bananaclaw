/**
 * models.dev-backed catalog for the `opencode` agent provider.
 *
 * OpenCode itself boots against https://models.dev/api.json — that file is
 * what tells it each provider's API base URL and each model's real limits.
 * Backing the picker with the same source has two consequences that matter:
 *
 *   1. A suggestion's id is `<provider>/<model-id>`, i.e. the exact canonical
 *      value we store in `container_configs.model` (see src/model-wire.ts).
 *      Picking a model therefore *selects the upstream too* — there is no
 *      separate provider dropdown to keep in sync, and no way to pick a
 *      combination OpenCode can't resolve.
 *   2. Context and cost are the numbers for that specific upstream. The
 *      OpenRouter-backed catalog can only ever report OpenRouter's figures,
 *      which is how a group ends up believing MiniMax-M3 has a 1,048,576
 *      token window (OpenRouter's model-level max) when the endpoint it was
 *      actually routed to caps out at 524,288. models.dev lists the direct
 *      `minimax` provider at its true 1,000,000.
 *
 * Only tool-calling, text-emitting models are surfaced — an agent that can't
 * call tools is useless here, and offering it invites a confusing failure
 * much later.
 *
 * Fetched without the OneCLI proxy: models.dev is public, unauthenticated,
 * and already exempted from the container's proxy via NO_PROXY
 * (src/providers/opencode.ts).
 */
import { log } from '../../../log.js';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 20_000;

interface ModelsDevModel {
  id?: string;
  name?: string;
  description?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  knowledge?: string;
  release_date?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
}

interface ModelsDevProvider {
  id?: string;
  name?: string;
  api?: string;
  doc?: string;
  models?: Record<string, ModelsDevModel>;
}

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

interface CacheEntry {
  fetchedAt: number;
  catalog: ModelsDevCatalog | null; // null = last fetch failed
}

let cache: CacheEntry | null = null;
let inflight: Promise<ModelsDevCatalog | null> | null = null;

async function fetchModelsDev(): Promise<ModelsDevCatalog | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS && cache.catalog) {
    return cache.catalog;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as ModelsDevCatalog;
      cache = { fetchedAt: Date.now(), catalog: json };
      return json;
    } catch (err) {
      log.warn('models.dev catalog fetch failed', { err: String(err) });
      cache = { fetchedAt: Date.now(), catalog: null };
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export interface ModelsDevSuggestion {
  /** Canonical wire id: `<provider>/<model-id>`. */
  id: string;
  label: string;
  detail?: string;
  tooltip?: string;
  contextWindow?: number;
  inputCostPerMTok?: number;
  outputCostPerMTok?: number;
  knowledgeCutoff?: string;
  releaseDate?: string;
  modalitiesIn?: string[];
  modalitiesOut?: string[];
  /** models.dev provider id — the value written to `upstream_provider`. */
  upstream: string;
  /** Human name of that provider, for the "which gateway is this" hint. */
  upstreamLabel: string;
}

function formatDetail(m: ModelsDevModel, providerLabel: string): string {
  const parts: string[] = [providerLabel];
  const ctx = m.limit?.context;
  if (ctx) parts.push(`${Math.round(ctx / 1024)}k ctx`);
  const inCost = m.cost?.input;
  const outCost = m.cost?.output;
  if (inCost != null && outCost != null) parts.push(`$${inCost}/$${outCost} per Mtok`);
  return parts.join(' · ');
}

function formatTooltip(m: ModelsDevModel, p: ModelsDevProvider, providerId: string): string {
  const lines: string[] = [];
  lines.push(m.name || m.id || '');
  lines.push(`Upstream: ${p.name || providerId}${p.api ? ` (${p.api})` : ''}`);
  if (m.limit?.context) {
    const out = m.limit.output ? ` · output up to ${m.limit.output.toLocaleString()}` : '';
    lines.push(`Context: ${m.limit.context.toLocaleString()} tokens${out}`);
  }
  if (m.cost?.input != null && m.cost?.output != null) {
    lines.push(`Cost: $${m.cost.input} in · $${m.cost.output} out (per Mtok)`);
  }
  if (m.knowledge) lines.push(`Knowledge cutoff: ${m.knowledge}`);
  if (m.release_date) lines.push(`Released: ${m.release_date}`);
  if (m.modalities?.input?.length) lines.push(`Input: ${m.modalities.input.join(', ')}`);
  // Descriptions run long and this list is ~5k entries — a truncated line
  // keeps the payload roughly a third smaller than the full text.
  if (m.description) lines.push(m.description.slice(0, 160));
  return lines.filter(Boolean).join('\n');
}

export interface ModelsDevFilter {
  inputModality?: string;
  outputModality?: string;
  /** Restrict to a single models.dev provider id. */
  upstream?: string;
}

/**
 * Every tool-calling model models.dev knows about, as canonical wire ids.
 *
 * Returns `null` when the catalog is unreachable so the caller can report
 * `source: 'unavailable'` rather than an empty (and misleading) list.
 */
export async function listOpenCodeModels(filter?: ModelsDevFilter): Promise<ModelsDevSuggestion[] | null> {
  const catalog = await fetchModelsDev();
  if (!catalog) return null;

  const out: ModelsDevSuggestion[] = [];
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (filter?.upstream && providerId !== filter.upstream) continue;
    const providerLabel = provider.name || providerId;
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      if (!model.tool_call) continue;
      const outMods = model.modalities?.output ?? [];
      const inMods = model.modalities?.input ?? [];
      if (!outMods.includes('text')) continue;
      if (filter?.inputModality && !inMods.includes(filter.inputModality)) continue;
      if (filter?.outputModality && !outMods.includes(filter.outputModality)) continue;
      out.push({
        id: `${providerId}/${modelId}`,
        label: model.name || modelId,
        detail: formatDetail(model, providerLabel),
        tooltip: formatTooltip(model, provider, providerId),
        contextWindow: model.limit?.context,
        inputCostPerMTok: model.cost?.input,
        outputCostPerMTok: model.cost?.output,
        knowledgeCutoff: model.knowledge,
        releaseDate: model.release_date,
        modalitiesIn: inMods.length ? inMods : undefined,
        modalitiesOut: outMods.length ? outMods : undefined,
        upstream: providerId,
        upstreamLabel: providerLabel,
      });
    }
  }

  // Group visually by upstream, then by model name.
  out.sort((a, b) => a.upstreamLabel.localeCompare(b.upstreamLabel) || a.label.localeCompare(b.label));
  return out;
}

/**
 * Infer the upstream provider from a canonical wire id.
 *
 * This is the whole point of the models.dev backing: `minimax/MiniMax-M3`
 * resolves to upstream `minimax`, so the caller never has to ask the user
 * which gateway they meant.
 *
 * Matching is exact against the catalog — the longest provider id that both
 * prefixes the value and actually owns the remaining segment wins. A value
 * that doesn't correspond to a real (provider, model) pair returns `null`
 * rather than a plausible-looking guess, so freeform entries are stored
 * verbatim instead of silently rewriting the group's upstream.
 */
export async function resolveUpstreamForWireId(wireId: string): Promise<{ upstream: string; modelId: string } | null> {
  const catalog = await fetchModelsDev();
  if (!catalog) return null;

  let best: { upstream: string; modelId: string } | null = null;
  for (const [providerId, provider] of Object.entries(catalog)) {
    const prefix = `${providerId}/`;
    if (!wireId.startsWith(prefix)) continue;
    const modelId = wireId.slice(prefix.length);
    if (!(provider.models ?? {})[modelId]) continue;
    // Prefer the longest provider id: `google/gemini-x` must not be claimed
    // by a hypothetical provider `g` that also happens to list that key.
    if (!best || providerId.length > best.upstream.length) best = { upstream: providerId, modelId };
  }
  return best;
}
