/**
 * Model catalog for the admin UI.
 *
 * Both agent providers are served from models.dev (./models-dev-catalog.ts),
 * the catalog OpenCode itself boots against. They differ only in what the
 * stored value looks like:
 *
 *   - opencode → the suggestion id IS the canonical `<upstream>/<model-id>`
 *                wire value, so picking a model also picks the gateway.
 *                Nothing is prefixed or stripped — see src/model-wire.ts for
 *                why guessing at the prefix was unsound.
 *   - claude   → restricted to the `anthropic` upstream, with that one known
 *                prefix peeled off, because the Claude provider passes the
 *                model straight to the Anthropic Messages API, which wants a
 *                bare id (e.g. "claude-sonnet-4-5-20250929").
 *   - mock     → no UI catalog; not exposed by the admin endpoint.
 *
 * `claude` used to be served from OpenRouter's /api/v1/models filtered to
 * `anthropic/*`, which was wrong in a way that never threw on our side:
 * OpenRouter renames Anthropic's models. It publishes `claude-sonnet-4.5`
 * and `claude-opus-4.5:batch` where the Anthropic API only answers to
 * `claude-sonnet-4-5-20250929` / `claude-sonnet-4-5`. Of the 28 ids under
 * `anthropic/*` exactly 3 were spelled the way Anthropic spells them, so the
 * picker was mostly an invalid-model generator — the 404 only surfaced later,
 * from inside the container, on the group's next message. models.dev lists
 * Anthropic's own ids.
 *
 * The one remaining OpenRouter-backed path is the `openrouter` pseudo-
 * provider, used by the transcription model selector — see
 * ./voice-transcribe.ts, which posts to OpenRouter's endpoint directly and
 * therefore genuinely needs OpenRouter's spelling.
 *
 * Catalog cached in memory (~1h TTL + brief negative cache on failure).
 */
import { log } from '../../../log.js';
import { proxyFetch } from './onecli-proxy.js';
import { listOpenCodeModels } from './models-dev-catalog.js';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** models.dev provider id backing the `claude` agent provider. */
const ANTHROPIC_UPSTREAM = 'anthropic';

export interface ModelSuggestion {
  /** Bare model id (what the user sees and the input stores). */
  id: string;
  /** Human-friendly display name. */
  label: string;
  /** Short summary (context window + cost), shown next to the id. */
  detail?: string;
  /** Full description for the tooltip. */
  tooltip?: string;
  /** Numeric facets (for rendering / future filters). */
  contextWindow?: number;
  inputCostPerMTok?: number;
  outputCostPerMTok?: number;
  knowledgeCutoff?: string;
  releaseDate?: string;
  modalitiesIn?: string[];
  modalitiesOut?: string[];
}

interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
  };
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
  supported_parameters?: string[];
  knowledge_cutoff?: string;
  created?: number;
}

interface OpenRouterResponse {
  data: OpenRouterModel[];
}

interface CacheEntry {
  fetchedAt: number;
  models: OpenRouterModel[] | null; // null = last fetch failed
}

let cache: CacheEntry | null = null;
let inflight: Promise<OpenRouterModel[] | null> | null = null;

async function fetchCatalog(): Promise<OpenRouterModel[] | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS && cache.models) {
    return cache.models;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await proxyFetch(OPENROUTER_MODELS_URL, { timeout: 15_000 });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as OpenRouterResponse;
      cache = { fetchedAt: Date.now(), models: json.data };
      return json.data;
    } catch (err) {
      log.warn('OpenRouter models fetch failed', { err: String(err) });
      cache = { fetchedAt: Date.now(), models: null };
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function perTokenToPMtok(perToken: string | undefined): number | undefined {
  if (perToken == null) return undefined;
  const n = parseFloat(perToken);
  if (isNaN(n)) return undefined;
  return Math.round(n * 1_000_000 * 100) / 100; // 2 decimal places
}

function formatDetail(m: OpenRouterModel): string | undefined {
  const parts: string[] = [];
  const ctx = m.context_length;
  if (ctx) parts.push(`${Math.round(ctx / 1024)}k ctx`);
  const inCost = perTokenToPMtok(m.pricing?.prompt);
  const outCost = perTokenToPMtok(m.pricing?.completion);
  if (inCost != null && outCost != null) {
    parts.push(`$${inCost}/$${outCost} per Mtok`);
  }
  return parts.length ? parts.join(' · ') : undefined;
}

function formatTooltip(m: OpenRouterModel): string {
  const lines: string[] = [];
  lines.push(m.name?.trim() || m.id);
  if (m.context_length) {
    const maxOut = m.top_provider?.max_completion_tokens;
    const out = maxOut ? ` · output up to ${maxOut.toLocaleString()}` : '';
    lines.push(`Context: ${m.context_length.toLocaleString()} tokens${out}`);
  }
  const inCost = perTokenToPMtok(m.pricing?.prompt);
  const outCost = perTokenToPMtok(m.pricing?.completion);
  if (inCost != null && outCost != null) {
    lines.push(`Cost: $${inCost} in · $${outCost} out (per Mtok)`);
  }
  if (m.knowledge_cutoff) lines.push(`Knowledge cutoff: ${m.knowledge_cutoff}`);
  if (m.created) lines.push(`Created: ${new Date(m.created * 1000).toISOString().slice(0, 10)}`);
  if (m.architecture?.input_modalities?.length) lines.push(`Input: ${m.architecture.input_modalities.join(', ')}`);
  if (m.architecture?.output_modalities?.length) lines.push(`Output: ${m.architecture.output_modalities.join(', ')}`);
  if (m.description) lines.push(m.description.slice(0, 200));
  return lines.join('\n');
}

function mapModel(m: OpenRouterModel, bareId: string): ModelSuggestion {
  return {
    id: bareId,
    label: m.name?.trim() || bareId,
    detail: formatDetail(m),
    tooltip: formatTooltip(m),
    contextWindow: m.context_length,
    inputCostPerMTok: perTokenToPMtok(m.pricing?.prompt),
    outputCostPerMTok: perTokenToPMtok(m.pricing?.completion),
    knowledgeCutoff: m.knowledge_cutoff,
    modalitiesIn: m.architecture?.input_modalities,
    modalitiesOut: m.architecture?.output_modalities,
  };
}

export interface ModelCatalogResult {
  models: ModelSuggestion[];
  source: 'openrouter' | 'models.dev' | 'unavailable';
  /** Label for the upstream catalog (e.g. "openrouter", "anthropic"). */
  upstream: string | null;
}

export interface ModelFilterOptions {
  /** Only include models whose input modalities contain this value. */
  inputModality?: string;
  /** Only include models whose output modalities contain this value. */
  outputModality?: string;
  /** opencode only: restrict to a single models.dev upstream provider. */
  upstream?: string;
}

/** Returns suggestions whose `id` is the bare model id (no prefix). */
export async function listModelsForProvider(
  agentProvider: string,
  filter?: ModelFilterOptions,
): Promise<ModelCatalogResult> {
  // mock is intentionally not surfaced through the admin UI — it's a
  // test-only provider and the dropdown shouldn't tempt users into picking
  // it. If you need it, set via `ncl groups config update --provider mock`.
  if (agentProvider === 'mock') {
    return { models: [], source: 'unavailable', upstream: null };
  }

  // opencode is served from models.dev, where the upstream is part of every
  // id rather than a single catalog-wide value.
  if (agentProvider === 'opencode') {
    const models = await listOpenCodeModels(filter);
    if (!models) return { models: [], source: 'unavailable', upstream: null };
    return { models, source: 'models.dev', upstream: filter?.upstream ?? null };
  }

  // claude is the same catalog pinned to one upstream. Peeling the prefix is
  // safe here in a way it is not for opencode: we asked models.dev for the
  // `anthropic` provider specifically, so every id is known to be
  // `anthropic/<model-id>` and the boundary isn't being guessed at.
  if (agentProvider === 'claude') {
    const models = await listOpenCodeModels({ ...filter, upstream: ANTHROPIC_UPSTREAM });
    if (!models) return { models: [], source: 'unavailable', upstream: null };
    const prefix = `${ANTHROPIC_UPSTREAM}/`;
    const bare = models.map((m) => (m.id.startsWith(prefix) ? { ...m, id: m.id.slice(prefix.length) } : m));
    return { models: bare, source: 'models.dev', upstream: ANTHROPIC_UPSTREAM };
  }

  // Everything below is the OpenRouter-backed path, which now serves only the
  // `openrouter` pseudo-provider (the transcription model selector).
  if (agentProvider !== 'openrouter') {
    return { models: [], source: 'unavailable', upstream: null };
  }

  const allModels = await fetchCatalog();
  if (!allModels) return { models: [], source: 'unavailable', upstream: null };

  const models: ModelSuggestion[] = [];
  for (const m of allModels) {
    if (filter?.inputModality && !m.architecture?.input_modalities?.includes(filter.inputModality)) continue;
    if (filter?.outputModality && !m.architecture?.output_modalities?.includes(filter.outputModality)) continue;
    models.push(mapModel(m, m.id));
  }

  models.sort((a, b) => a.label.localeCompare(b.label));
  return { models, source: 'openrouter', upstream: 'openrouter' };
}

/** Look up details for a specific bare id (used for the "current selection" panel). */
export async function getModelDetails(agentProvider: string, bareId: string): Promise<ModelSuggestion | null> {
  const result = await listModelsForProvider(agentProvider);
  return result.models.find((m) => m.id === bareId) ?? null;
}

// ── id translation (catalog ↔ DB) ─────────────────────────────────────────
//
// Both directions are now the identity, and these functions exist only to
// keep the call sites honest about the boundary.
//
// For `claude` the `anthropic/` prefix is peeled off inside the catalog
// builder, so the ids it hands out already match the stored values. For
// `opencode` the models.dev id IS the stored value. The host no longer
// synthesizes or peels a prefix at this layer — doing so is what made the
// stored format ambiguous in the first place (src/model-wire.ts).

/** Translate a stored DB model value to the id the user sees. */
export function bareIdForResponse(_agentProvider: string | null, dbValue: string | null): string | null {
  return dbValue;
}

/** Translate a picked catalog id back to the DB wire value. */
export function dbValueFromBareId(_agentProvider: string | null, bareId: string | null): string | null {
  if (bareId == null || bareId === '') return null;
  return bareId;
}
