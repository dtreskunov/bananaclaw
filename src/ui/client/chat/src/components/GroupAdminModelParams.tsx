import './GroupAdminModelParams.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { GroupAdminField as Field } from './GroupAdminField';

// ---------------------------------------------------------------------------
// Model parameters editor (per-group `model_params` bag)
// ---------------------------------------------------------------------------

// Keys each provider actually consumes today. Mirrors the constants in
// container/agent-runner/src/providers/{opencode,claude}.ts.
const MODEL_PARAM_RECOGNIZED: Record<string, string[]> = {
  opencode: ['max_tokens', 'temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'seed', 'stop'],
  claude: ['max_tokens', 'thinking_budget_tokens'],
};

const MODEL_PARAM_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

interface ParamRow {
  /** Stable identity so React keys survive key edits. */
  uid: number;
  key: string;
  /** Raw text in the value input. Parsed to JSON on save. */
  valueText: string;
}

let _rowUid = 0;
function nextRowUid(): number { _rowUid += 1; return _rowUid; }

function paramsToRows(params: Record<string, unknown>): ParamRow[] {
  return Object.entries(params).map(([k, v]) => ({
    uid: nextRowUid(),
    key: k,
    // Stringify in a JSON-roundtrippable form so the user can edit & resave.
    valueText: typeof v === 'string' ? v : JSON.stringify(v),
  }));
}

/** Mirror the server's parse: JSON first, string fallback. */
function parseRowValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  try { return JSON.parse(trimmed); } catch { return raw; }
}

function rowsToParams(rows: ParamRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const r of rows) {
    const k = r.key.trim();
    if (k === '' && r.valueText.trim() === '') continue;
    if (!k || !MODEL_PARAM_KEY_RE.test(k) || seen.has(k)) continue;
    seen.add(k);
    out[k] = parseRowValue(r.valueText);
  }
  return out;
}

export function ModelParamsEditor({
  gid,
  provider,
  value,
  busy,
  onChange,
}: {
  gid: string;
  provider: string | null;
  value: Record<string, unknown>;
  busy: boolean;
  onChange: (next: Record<string, unknown>) => void;
}): JSX.Element {
  const [rows, setRows] = useState<ParamRow[]>(() => paramsToRows(value));
  // Track the last JSON we emitted so external re-baselining (parent refresh /
  // save success) resets rows, but our own onChange echo doesn't.
  const lastEmittedRef = useRef<string>(JSON.stringify(value));

  useEffect(() => {
    const incoming = JSON.stringify(value);
    if (incoming === lastEmittedRef.current) return;
    setRows(paramsToRows(value));
    lastEmittedRef.current = incoming;
  }, [value]);

  const recognized = provider ? MODEL_PARAM_RECOGNIZED[provider] ?? [] : [];

  function emit(next: ParamRow[]): void {
    const params = rowsToParams(next);
    lastEmittedRef.current = JSON.stringify(params);
    onChange(params);
  }

  function update(uid: number, patch: Partial<Pick<ParamRow, 'key' | 'valueText'>>): void {
    setRows((rs) => {
      const next = rs.map((r) => (r.uid === uid ? { ...r, ...patch } : r));
      emit(next);
      return next;
    });
  }
  function remove(uid: number): void {
    setRows((rs) => {
      const next = rs.filter((r) => r.uid !== uid);
      emit(next);
      return next;
    });
  }
  function addBlank(presetKey: string = ''): void {
    setRows((rs) => {
      const next = [...rs, { uid: nextRowUid(), key: presetKey, valueText: '' }];
      emit(next);
      return next;
    });
  }

  // Validation: duplicate keys, bad key format, empty key with non-empty value.
  const issues: string[] = [];
  const seenKeys = new Set<string>();
  for (const r of rows) {
    const k = r.key.trim();
    if (k === '' && r.valueText.trim() === '') continue;
    if (k === '') { issues.push('A row is missing a key.'); continue; }
    if (!MODEL_PARAM_KEY_RE.test(k)) { issues.push(`Invalid key "${k}".`); continue; }
    if (seenKeys.has(k)) { issues.push(`Duplicate key "${k}".`); continue; }
    seenKeys.add(k);
  }

  const suggestions = recognized.filter((k) => !rows.some((r) => r.key.trim() === k));

  return (
    <Field
      label="Model parameters"
      info={
        'Per-group knobs passed to the provider when it builds requests (max_tokens, temperature, …).\n' +
        'Values are parsed as JSON first (so 8192 is a number, "high" is a string, true is a boolean), then fall back to a plain string if JSON parsing fails.\n' +
        'Changes take effect on next container restart. Providers warn once per startup about keys they do not recognize.'
      }
    >
      <div class="group-admin-stack ga-model-params">
        {rows.length === 0 ? (
          <p class="group-admin-help">No parameters set — using provider defaults.</p>
        ) : (
          <ul class="ga-mp-list">
            {rows.map((r) => {
              const trimmedKey = r.key.trim();
              const isRecognized = trimmedKey !== '' && recognized.includes(trimmedKey);
              return (
                <li key={r.uid} class="ga-mp-row">
                  <input
                    type="text"
                    class={`ga-mp-key${trimmedKey !== '' && !isRecognized && recognized.length > 0 ? ' ga-mp-key-unknown' : ''}`}
                    placeholder="key (e.g. max_tokens)"
                    value={r.key}
                    disabled={busy}
                    list={`ga-mp-keys-${gid}`}
                    onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => update(r.uid, { key: e.currentTarget.value })}
                  />
                  <input
                    type="text"
                    class="ga-mp-value"
                    placeholder="value (JSON or string)"
                    value={r.valueText}
                    disabled={busy}
                    onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => update(r.uid, { valueText: e.currentTarget.value })}
                  />
                  <button
                    type="button"
                    class="icon-btn"
                    aria-label="Remove"
                    disabled={busy}
                    onClick={() => remove(r.uid)}
                  >
                    {'\u2715'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Datalist shared by all key inputs so the browser autocompletes recognized keys. */}
        <datalist id={`ga-mp-keys-${gid}`}>
          {recognized.map((k) => <option key={k} value={k} />)}
        </datalist>

        <div class="ga-mp-actions">
          <button type="button" disabled={busy} onClick={() => addBlank()}>
            + Add parameter
          </button>
          {suggestions.length > 0 ? (
            <span class="ga-mp-suggest">
              <span class="group-admin-help">Common for {provider}:</span>
              {suggestions.map((k) => (
                <button
                  key={k}
                  type="button"
                  class="ga-mp-suggest-chip"
                  disabled={busy}
                  onClick={() => addBlank(k)}
                  title={`Add ${k}`}
                >
                  + {k}
                </button>
              ))}
            </span>
          ) : null}
        </div>

        {issues.length > 0 ? (
          <p class="ga-confirm-warn">{issues[0]}</p>
        ) : null}
      </div>
    </Field>
  );
}