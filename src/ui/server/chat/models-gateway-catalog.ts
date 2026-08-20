/**
 * Vercel AI Gateway catalog for the `fx` agent provider.
 *
 * fx resolves its own model list from the gateway's `/coding-agent/v1/models`
 * endpoint, so the picker is backed by that exact endpoint rather than
 * models.dev. The distinction is the same one that made the old
 * OpenRouter-backed `claude` catalog an invalid-model generator (see the
 * header of ./models-catalog.ts): a catalog that renames or over-lists models
 * relative to the endpoint actually being called produces ids that only fail
 * later, from inside the container, on the group's next message.
 *
 * `/coding-agent/v1/models` is the curated coding subset (~228 entries) rather
 * than the full `/v1/models` (~1k): it is what fx itself offers, so anything
 * listed here is known-selectable in fx.
 *
 * A suggestion's id is the canonical `<upstream>/<model-id>` wire value — the
 * exact string fx sends back in its `ai-language-model-id` request header — so
 * it is stored verbatim, with no prefix peeling (cf. src/model-wire.ts).
 *
 * Fetched without the OneCLI proxy: the endpoint is public and unauthenticated
 * (verified: HTTP 200 with no credentials).
 */
import { log } from '../../../log.js';

const DEFAULT_GATEWAY_BASE = 'https://ai-gateway.vercel.sh';
const CATALOG_PATH = '/coding-agent/v1/models';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 20_000;

/** Follows the operator's gateway override so the catalog can't describe a
 *  different endpoint than the one fx is pointed at. */
function catalogUrl(): string {
  const base = (process.env.FX_GATEWAY_BASE_URL || DEFAULT_GATEWAY_BASE).replace(/\/+$/, '');
  return `${base}${CATALOG_PATH}`;
}

interface GatewayModel {
  id?: string;
  name?: string;
  description?: string;
  owned_by?: string;
  type?: string;
  tags?: string[];
  context_window?: number;
  max_tokens?: number;
  knowledge?: string;
  released?: number;
  modalities?: { input?: string[]; output?: string[] };
  pricing?: { input?: string; output?: string };
}

interface GatewayCatalogResponse {
  data?: GatewayModel[];
}

interface CacheEntry {
  fetchedAt: number;
  models: GatewayModel[] | null; // null = last fetch failed
}

let cache: CacheEntry | null = null;
let inflight: Promise<GatewayModel[] | null> | null = null;

async function fetchGatewayCatalog(): Promise<GatewayModel[] | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS && cache.models) {
    return cache.models;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch(catalogUrl(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as GatewayCatalogResponse;
      const models = json.data ?? [];
      cache = { fetchedAt: Date.now(), models };
      return models;
    } catch (err) {
      log.warn('Vercel AI Gateway catalog fetch failed', { err: String(err) });
      cache = { fetchedAt: Date.now(), models: null };
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Test seam: drop the cached catalog. */
export function resetGatewayCatalogCache(): void {
  cache = null;
  inflight = null;
}

export interface GatewaySuggestion {
  /** Canonical wire id: `<upstream>/<model-id>`. */
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
  upstream: string;
  upstreamLabel: string;
}

/** Gateway prices are per-token decimal strings; the UI shows per-Mtok. */
function perTokenToPMtok(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 1_000_000 * 1000) / 1000;
}

function upstreamOf(id: string, m: GatewayModel): string {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : (m.owned_by ?? '');
}

function formatDetail(m: GatewayModel, upstreamLabel: string): string {
  const parts: string[] = [upstreamLabel];
  if (m.context_window) parts.push(`${Math.round(m.context_window / 1024)}k ctx`);
  const inCost = perTokenToPMtok(m.pricing?.input);
  const outCost = perTokenToPMtok(m.pricing?.output);
  if (inCost != null && outCost != null) parts.push(`$${inCost}/$${outCost} per Mtok`);
  return parts.join(' · ');
}

function formatTooltip(m: GatewayModel, id: string, upstreamLabel: string): string {
  const lines: string[] = [];
  lines.push(m.name || id);
  lines.push(`Upstream: ${upstreamLabel} (via Vercel AI Gateway)`);
  if (m.context_window) {
    const out = m.max_tokens ? ` · output up to ${m.max_tokens.toLocaleString()}` : '';
    lines.push(`Context: ${m.context_window.toLocaleString()} tokens${out}`);
  }
  const inCost = perTokenToPMtok(m.pricing?.input);
  const outCost = perTokenToPMtok(m.pricing?.output);
  if (inCost != null && outCost != null) lines.push(`Cost: $${inCost} in · $${outCost} out (per Mtok)`);
  if (m.knowledge) lines.push(`Knowledge cutoff: ${m.knowledge}`);
  if (m.tags?.length) lines.push(`Tags: ${m.tags.join(', ')}`);
  if (m.modalities?.input?.length) lines.push(`Input: ${m.modalities.input.join(', ')}`);
  if (m.description) lines.push(m.description.slice(0, 160));
  return lines.filter(Boolean).join('\n');
}

export interface GatewayFilter {
  inputModality?: string;
  outputModality?: string;
  /** Restrict to a single gateway upstream (e.g. `anthropic`). */
  upstream?: string;
}

/**
 * Every tool-calling, text-emitting model the gateway offers to coding agents.
 *
 * Returns `null` when the catalog is unreachable so the caller can report
 * `source: 'unavailable'` rather than an empty (and misleading) list.
 */
export async function listFxModels(filter?: GatewayFilter): Promise<GatewaySuggestion[] | null> {
  const catalog = await fetchGatewayCatalog();
  if (!catalog) return null;

  const out: GatewaySuggestion[] = [];
  for (const m of catalog) {
    const id = m.id;
    if (!id) continue;
    if (m.type && m.type !== 'language') continue;
    // An agent that can't call tools is useless here — same rule the
    // models.dev-backed catalog applies via `tool_call`.
    if (!m.tags?.includes('tool-use')) continue;
    const inMods = m.modalities?.input ?? [];
    const outMods = m.modalities?.output ?? [];
    if (!outMods.includes('text')) continue;
    if (filter?.inputModality && !inMods.includes(filter.inputModality)) continue;
    if (filter?.outputModality && !outMods.includes(filter.outputModality)) continue;
    const upstream = upstreamOf(id, m);
    if (filter?.upstream && upstream !== filter.upstream) continue;
    const upstreamLabel = upstream || 'unknown';
    out.push({
      id,
      label: m.name || id,
      detail: formatDetail(m, upstreamLabel),
      tooltip: formatTooltip(m, id, upstreamLabel),
      contextWindow: m.context_window,
      inputCostPerMTok: perTokenToPMtok(m.pricing?.input),
      outputCostPerMTok: perTokenToPMtok(m.pricing?.output),
      knowledgeCutoff: m.knowledge,
      releaseDate: m.released ? new Date(m.released * 1000).toISOString().slice(0, 10) : undefined,
      modalitiesIn: inMods.length ? inMods : undefined,
      modalitiesOut: outMods.length ? outMods : undefined,
      upstream,
      upstreamLabel,
    });
  }

  out.sort((a, b) => a.upstreamLabel.localeCompare(b.upstreamLabel) || a.label.localeCompare(b.label));
  return out;
}
