/**
 * ModelPickerDialog — a dialog-based model picker with sidebar filters.
 *
 * Replaces the inline ModelSelector combobox. Shows a trigger field that opens
 * a full dialog with:
 *   - Left sidebar: faceted checkbox filters (modalities, cost tier, context window)
 *   - Main area: search input + two-line scrollable model list
 *   - Footer: free-form ID entry for models not in the catalog
 *
 * Fetches the same `/models?provider=...` endpoint as the old ModelSelector.
 */
import './ModelPickerDialog.css';
import { protocolFetch } from '../api';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { isMobile } from '../state';
import { MobileDialog } from './MobileDialog';
import { CredentialsContent } from './CredentialsPage';
import { credentialRequest, errorMessage } from './CredentialsApi';
import { showToast } from './Toast';
import type { AccessRequirements } from '../../../../shared/access-authentication';

// ── types ─────────────────────────────────────────────────────────────────

interface ModelSuggestion {
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
  /** models.dev only: the gateway this model is served through. */
  upstream?: string;
  upstreamLabel?: string;
}

interface ModelsResponse {
  models: ModelSuggestion[];
  source: 'openrouter' | 'models.dev' | 'unavailable';
  upstream: string | null;
}

export interface ModelPickerDialogProps {
  /** Current model value (bare id). */
  value: string | null;
  fallbackValue?: string | null;
  /** Provider to fetch models for. */
  provider: string | null;
  /** Placeholder text when no model is selected. */
  placeholder?: string;
  /** Whether the field is disabled. */
  disabled?: boolean;
  /** API base path for fetching (e.g. '/ui/chat/api/groups/:gid/admin'). */
  apiBasePath: string;
  /** Pre-filter: only models accepting this input modality. */
  inputModality?: string;
  /** Pre-filter: only models producing this output modality. */
  outputModality?: string;
  /**
   * opencode only: restrict the catalog to one models.dev upstream. Used by
   * the small-model picker so background tasks can't be pointed at a gateway
   * the group isn't connected to.
   */
  upstream?: string | null;
  /** Called when the user picks or types a model id. */
  onChange: (value: string | null) => void;
}

// ── filter definitions ────────────────────────────────────────────────────

type CostTier = 'free' | 'low' | 'mid' | 'high' | 'premium';
type CtxTier = '32k' | '128k' | '200k' | '1m';

const COST_TIERS: { id: CostTier; label: string; test: (m: ModelSuggestion) => boolean }[] = [
  { id: 'free', label: 'Free', test: (m) => (m.inputCostPerMTok ?? 0) === 0 && (m.outputCostPerMTok ?? 0) === 0 },
  {
    id: 'low',
    label: '< $1/Mtok',
    test: (m) => (m.outputCostPerMTok ?? Infinity) > 0 && (m.outputCostPerMTok ?? Infinity) < 1,
  },
  {
    id: 'mid',
    label: '$1 – $5',
    test: (m) => (m.outputCostPerMTok ?? 0) >= 1 && (m.outputCostPerMTok ?? Infinity) <= 5,
  },
  {
    id: 'high',
    label: '$5 – $20',
    test: (m) => (m.outputCostPerMTok ?? 0) > 5 && (m.outputCostPerMTok ?? Infinity) <= 20,
  },
  { id: 'premium', label: '> $20', test: (m) => (m.outputCostPerMTok ?? 0) > 20 },
];

const CTX_TIERS: { id: CtxTier; label: string; min: number }[] = [
  { id: '32k', label: '≥ 32k', min: 32_000 },
  { id: '128k', label: '≥ 128k', min: 128_000 },
  { id: '200k', label: '≥ 200k', min: 200_000 },
  { id: '1m', label: '≥ 1M', min: 1_000_000 },
];

const ALL_INPUT_MODALITIES = ['text', 'image', 'pdf', 'audio', 'video'];
const ALL_OUTPUT_MODALITIES = ['text', 'image'];

/**
 * Cap on rendered rows. The models.dev catalog is ~5k entries; painting all of
 * them locks up a phone for seconds. Anyone past the cap is better served by
 * typing than by scrolling, so we prompt for that instead of virtualizing.
 */
const MAX_RENDERED = 200;

// ── helpers ───────────────────────────────────────────────────────────────

function formatDetailLine(m: ModelSuggestion): string {
  const parts: string[] = [];
  // Lead with the gateway: the models.dev catalog lists the same model under
  // many providers, so "DeepSeek Chat" alone is ambiguous — and the gateway
  // is what actually decides price and context window.
  if (m.upstreamLabel) parts.push(m.upstreamLabel);
  if (m.contextWindow) {
    const k =
      m.contextWindow >= 1_000_000
        ? `${(m.contextWindow / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
        : `${Math.round(m.contextWindow / 1024)}k`;
    parts.push(`${k} ctx`);
  }
  if (m.inputCostPerMTok != null && m.outputCostPerMTok != null) {
    if (m.inputCostPerMTok === 0 && m.outputCostPerMTok === 0) {
      parts.push('free');
    } else {
      parts.push(`$${m.inputCostPerMTok}/$${m.outputCostPerMTok} per Mtok`);
    }
  }
  const modIn = m.modalitiesIn?.filter((x) => x !== 'text');
  if (modIn?.length) parts.push(modIn.join('+') + ' in');
  return parts.join(' · ');
}

// ── client-side catalog cache ─────────────────────────────────────────────

interface CacheEntry {
  fetchedAt: number;
  promise: Promise<CatalogResult>;
}

type CatalogResult = { ok: true; data: ModelsResponse } | { ok: false; error: string };

const catalogCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function fetchModels(url: string): Promise<CatalogResult> {
  const now = Date.now();
  const cached = catalogCache.get(url);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.promise;
  }
  const promise = (async (): Promise<CatalogResult> => {
    try {
      const res = await protocolFetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Model catalog request failed (HTTP ${res.status}).`);
      const data = (await res.json()) as ModelsResponse;
      if (!data || !Array.isArray(data.models) || !['models.dev', 'openrouter', 'unavailable'].includes(data.source))
        throw new Error('The model catalog returned an invalid response.');
      if (data.source === 'unavailable') throw new Error('Model catalog unavailable. Please try again.');
      return { ok: true, data };
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error) };
    }
  })();
  const entry = { fetchedAt: now, promise };
  catalogCache.set(url, entry);
  void promise.then((result) => {
    if (!result.ok && catalogCache.get(url) === entry) catalogCache.delete(url);
  });
  return promise;
}

// ── component ─────────────────────────────────────────────────────────────

export function ModelPickerDialog({
  value,
  fallbackValue,
  provider,
  placeholder,
  disabled,
  apiBasePath,
  inputModality,
  outputModality,
  upstream,
  onChange,
}: ModelPickerDialogProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [{ models, source, error: catalogError }, setCatalog] = useState<ModelsResponse & { error?: string }>({
    models: [],
    source: 'unavailable',
    upstream: null,
  });
  const [loading, setLoading] = useState(false);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [connection, setConnection] = useState<AccessRequirements | null>(null);
  const [editingConnection, setEditingConnection] = useState<AccessRequirements | null>(null);
  const [configuredProviders, setConfiguredProviders] = useState<Set<string>>(new Set());
  const [providerError, setProviderError] = useState('');
  const effectiveModel = value || fallbackValue;

  useEffect(() => {
    setConnection(null);
    if (!provider || !effectiveModel) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ provider, model: effectiveModel });
    void credentialRequest<{ connection: AccessRequirements | null }>(
      `${apiBasePath}/model-connection?${params}`, 'GET', undefined, controller.signal,
    ).then(({ connection }) => {
      if (!controller.signal.aborted) setConnection(connection);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) showToast(errorMessage(error), 'err');
    });
    return () => controller.abort();
  }, [provider, effectiveModel, apiBasePath]);

  // Filters
  const [search, setSearch] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedInputMods, setSelectedInputMods] = useState<Set<string>>(new Set());
  const [selectedOutputMods, setSelectedOutputMods] = useState<Set<string>>(new Set());
  const [selectedCostTiers, setSelectedCostTiers] = useState<Set<CostTier>>(new Set());
  const [selectedCtxTier, setSelectedCtxTier] = useState<CtxTier | null>(null);

  // Free-form
  const [freeformValue, setFreeformValue] = useState('');

  const searchRef = useRef<HTMLInputElement>(null);

  // Build the catalog URL for this picker's configuration.
  const catalogUrl = useMemo(() => {
    if (!provider) return null;
    const params = new URLSearchParams({ provider });
    if (inputModality) params.set('inputModality', inputModality);
    if (outputModality) params.set('outputModality', outputModality);
    if (upstream) params.set('upstream', upstream);
    return `${apiBasePath}/models?${params.toString()}`;
  }, [provider, apiBasePath, inputModality, outputModality, upstream]);

  useEffect(() => {
    setSelectedProvider('');
  }, [catalogUrl]);

  useEffect(() => {
    if (!open || editingConnection || (provider !== 'native' && provider !== 'opencode')) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ provider });
    if (upstream) params.set('upstream', upstream);
    if (inputModality) params.set('inputModality', inputModality);
    if (outputModality) params.set('outputModality', outputModality);
    setConfiguredProviders(new Set());
    setProviderError('');
    void credentialRequest<{ configuredProviders: string[] }>(
      `${apiBasePath}/configured-model-providers?${params}`,
      'GET',
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setConfiguredProviders(new Set(result.configuredProviders));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setProviderError(`Could not load configured providers: ${errorMessage(error)}`);
      });
    return () => controller.abort();
  }, [open, provider, apiBasePath, upstream, inputModality, outputModality, editingConnection]);

  // Eagerly fetch models when provider is set (even while dialog is closed)
  // so the trigger can show the detail line for the current value.
  // Uses a module-level cache so multiple pickers with the same URL share one request.
  useEffect(() => {
    if (!catalogUrl) {
      setCatalog((current) => ({ ...current, models: [] }));
      return;
    }
    let cancelled = false;
    fetchModels(catalogUrl).then((r) => {
      if (cancelled) return;
      setCatalog(r.ok ? r.data : { models: [], source: 'unavailable', upstream: null, error: r.error });
    });
    return () => {
      cancelled = true;
    };
  }, [catalogUrl]);

  // When dialog opens, re-resolve from cache (instant if fresh) to show loading state.
  useEffect(() => {
    if (!open || !catalogUrl) return;
    let cancelled = false;
    setLoading(true);
    fetchModels(catalogUrl).then((r) => {
      if (cancelled) return;
      setCatalog(r.ok ? r.data : { models: [], source: 'unavailable', upstream: null, error: r.error });
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, catalogUrl, catalogAttempt]);

  // Focus search on open
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open]);

  // Apply filters
  const providers = useMemo(() => {
    const choices = new Map<string, string>();
    for (const model of models) {
      if (model.upstream) choices.set(model.upstream, model.upstreamLabel || model.upstream);
    }
    return [...choices].sort(
      ([a, aLabel], [b, bLabel]) =>
        Number(configuredProviders.has(b)) - Number(configuredProviders.has(a)) || aLabel.localeCompare(bLabel),
    );
  }, [models, configuredProviders]);

  const filtered = useMemo(() => {
    let result = models;

    if (selectedProvider) result = result.filter((model) => model.upstream === selectedProvider);

    // Text search
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
    }

    // Input modality filter
    if (selectedInputMods.size > 0) {
      result = result.filter((m) => [...selectedInputMods].every((mod) => m.modalitiesIn?.includes(mod)));
    }

    // Output modality filter
    if (selectedOutputMods.size > 0) {
      result = result.filter((m) => [...selectedOutputMods].every((mod) => m.modalitiesOut?.includes(mod)));
    }

    // Cost tier filter (union — model matches if it fits ANY selected tier)
    if (selectedCostTiers.size > 0) {
      const activeTiers = COST_TIERS.filter((t) => selectedCostTiers.has(t.id));
      result = result.filter((m) => activeTiers.some((t) => t.test(m)));
    }

    // Context window threshold (single selection — largest selected)
    if (selectedCtxTier) {
      const tier = CTX_TIERS.find((t) => t.id === selectedCtxTier);
      if (tier) {
        result = result.filter((m) => (m.contextWindow ?? 0) >= tier.min);
      }
    }

    return result;
  }, [models, selectedProvider, search, selectedInputMods, selectedOutputMods, selectedCostTiers, selectedCtxTier]);

  const handleSelect = useCallback(
    (id: string) => {
      onChange(id);
      setOpen(false);
    },
    [onChange],
  );

  const handleFreeformSubmit = useCallback(() => {
    const trimmed = freeformValue.trim();
    if (trimmed) {
      onChange(trimmed);
      setOpen(false);
      setFreeformValue('');
    }
  }, [freeformValue, onChange]);

  const handleClear = useCallback(() => {
    onChange(null);
    setOpen(false);
  }, [onChange]);

  const toggleSet = <T extends string>(set: Set<T>, val: T): Set<T> => {
    const next = new Set(set);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    return next;
  };

  // Resolve display info for the current value
  const matched = models.find((m) => m.id === value);
  const triggerName = matched?.label ?? value;
  const triggerDetail = matched ? formatDetailLine(matched) : null;

  // Close on Escape
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
  }, []);

  return (
    <>
      {/* Trigger button */}
      <button
        type="button"
        class="mpd-trigger"
        disabled={disabled || !provider}
        onClick={() => {
          setOpen(true);
          setSearch('');
          setSelectedProvider('');
        }}
      >
        <span class="mpd-trigger-label">
          {value ? (
            <>
              <span class="mpd-trigger-name">{triggerName}</span>
              {triggerDetail && <span class="mpd-trigger-detail">{triggerDetail}</span>}
            </>
          ) : (
            <span class="mpd-trigger-placeholder">{placeholder || 'pick or type a model id'}</span>
          )}
        </span>
        <span class="mpd-trigger-icon">▾</span>
      </button>
      {connection ? (
        <p class="group-admin-help">
          API: <span title={connection.resource_url}>{new URL(connection.resource_url).host}</span>
          {' · '}
          <button
            type="button"
            class="ga-cred-link"
            disabled={disabled}
            onClick={() => setEditingConnection(connection)}
          >
            Credentials
          </button>
        </p>
      ) : null}
      {editingConnection ? (
        <CredentialsContent initialRequest={editingConnection} onClose={() => setEditingConnection(null)} />
      ) : null}

      {/* Dialog */}
      {open && (
        <MobileDialog
          title="Pick a model"
          onClose={() => setOpen(false)}
          onBack={isMobile.value ? () => setOpen(false) : undefined}
          backLabel="Back to agent settings"
          onKeyDown={(e) => handleKeyDown(e)}
          maxWidth="720px"
          className="mpd-dialog"
          actions={
            value ? (
              <button type="button" class="mpd-clear" title="Clear selection" onClick={handleClear}>
                {'\u2715'} Clear
              </button>
            ) : null
          }
        >
          <div class="mpd-content">
            {/* Sidebar filters */}
            <div class="mpd-sidebar">
              {providers.length > 0 && (provider === 'native' || provider === 'opencode') ? (
                <div class="mpd-filter-group">
                  <label class="mpd-filter-group-title mpd-provider-label">
                    Provider
                    <select
                      class="mpd-provider"
                      aria-label="Provider"
                      value={selectedProvider}
                      title="Credential configured means a matching credential in your account, not permission for this agent."
                      onChange={(event) => setSelectedProvider(event.currentTarget.value)}
                    >
                      <option value="">All providers</option>
                      {providers.map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                          {configuredProviders.has(id) ? ' — Credential configured' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {providerError ? (
                    <p class="mpd-provider-error" role="alert">
                      {providerError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div class="mpd-filter-group">
                <div class="mpd-filter-group-title">Input</div>
                {ALL_INPUT_MODALITIES.map((mod) => (
                  <div class="mpd-filter-option" key={mod}>
                    <input
                      type="checkbox"
                      id={`mpd-in-${mod}`}
                      checked={selectedInputMods.has(mod)}
                      onChange={() => setSelectedInputMods(toggleSet(selectedInputMods, mod))}
                    />
                    <label for={`mpd-in-${mod}`}>{mod}</label>
                  </div>
                ))}
              </div>

              <div class="mpd-filter-group">
                <div class="mpd-filter-group-title">Output</div>
                {ALL_OUTPUT_MODALITIES.map((mod) => (
                  <div class="mpd-filter-option" key={mod}>
                    <input
                      type="checkbox"
                      id={`mpd-out-${mod}`}
                      checked={selectedOutputMods.has(mod)}
                      onChange={() => setSelectedOutputMods(toggleSet(selectedOutputMods, mod))}
                    />
                    <label for={`mpd-out-${mod}`}>{mod}</label>
                  </div>
                ))}
              </div>

              <div class="mpd-filter-group">
                <div class="mpd-filter-group-title">Cost (output)</div>
                {COST_TIERS.map((tier) => (
                  <div class="mpd-filter-option" key={tier.id}>
                    <input
                      type="checkbox"
                      id={`mpd-cost-${tier.id}`}
                      checked={selectedCostTiers.has(tier.id)}
                      onChange={() => setSelectedCostTiers(toggleSet(selectedCostTiers, tier.id))}
                    />
                    <label for={`mpd-cost-${tier.id}`}>{tier.label}</label>
                  </div>
                ))}
              </div>

              <div class="mpd-filter-group">
                <div class="mpd-filter-group-title">Context window</div>
                {CTX_TIERS.map((tier) => (
                  <div class="mpd-filter-option" key={tier.id}>
                    <input
                      type="checkbox"
                      id={`mpd-ctx-${tier.id}`}
                      checked={selectedCtxTier === tier.id}
                      onChange={() => setSelectedCtxTier(selectedCtxTier === tier.id ? null : tier.id)}
                    />
                    <label for={`mpd-ctx-${tier.id}`}>{tier.label}</label>
                  </div>
                ))}
              </div>
            </div>

            {/* Main list */}
            <div class="mpd-main">
              <div class="mpd-search">
                <input
                  ref={searchRef}
                  type="text"
                  placeholder="Search models…"
                  value={search}
                  onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
                />
              </div>

              <div class="mpd-list">
                {loading && <div class="mpd-empty">Loading…</div>}
                {!loading && source === 'unavailable' && (
                  <div class="mpd-empty" role="alert">
                    {catalogError || 'Model catalog unavailable.'}
                    <button type="button" class="mpd-retry" onClick={() => setCatalogAttempt((attempt) => attempt + 1)}>
                      Retry
                    </button>
                  </div>
                )}
                {!loading && source !== 'unavailable' && filtered.length === 0 && (
                  <div class="mpd-empty">No models match filters.</div>
                )}
                {!loading &&
                  filtered.slice(0, MAX_RENDERED).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      class={`mpd-item${m.id === value ? ' selected' : ''}`}
                      onClick={() => handleSelect(m.id)}
                    >
                      <div class="mpd-item-name">{m.label}</div>
                      <div class="mpd-item-detail">{formatDetailLine(m)}</div>
                    </button>
                  ))}
                {!loading && filtered.length > MAX_RENDERED && (
                  <div class="mpd-empty">
                    Showing {MAX_RENDERED} of {filtered.length} — search or filter to narrow down.
                  </div>
                )}
              </div>

              {/* Free-form entry */}
              <div class="mpd-freeform">
                <input
                  type="text"
                  placeholder="Or type a custom model ID…"
                  value={freeformValue}
                  onInput={(e) => setFreeformValue((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleFreeformSubmit();
                  }}
                />
                <button type="button" disabled={!freeformValue.trim()} onClick={handleFreeformSubmit}>
                  Use
                </button>
              </div>
            </div>
          </div>
        </MobileDialog>
      )}
    </>
  );
}
