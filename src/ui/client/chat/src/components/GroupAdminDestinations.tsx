import './GroupAdminDestinations.css';
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { apiPath, call, errMsg } from './GroupAdminApi';
import { Combobox, type ComboboxOption } from './Combobox';
import { GroupAdminField as Field } from './GroupAdminField';
import { Tooltip } from './Tooltip';
import { showToast } from './Toast';

// ── Destinations (agent-to-agent links) ──────────────────────────────────

/**
 * Some platform_ids (e.g. resend's `resend:user@host`) are already namespaced
 * with their channel_type; others (web, cli, telegram numerics) aren't.
 * Render `<channel>:<handle>` without double-prefixing, falling back to the
 * raw messaging-group id when neither is known.
 */
function formatChannelHandle(
  channelType: string | null,
  platformId: string | null,
  targetId: string,
): string {
  if (!channelType && !platformId) return targetId;
  if (!channelType) return platformId ?? targetId;
  if (!platformId) return channelType;
  return platformId.startsWith(`${channelType}:`) ? platformId : `${channelType}:${platformId}`;
}

interface DestinationDto {
  localName: string;
  targetType: 'agent' | 'channel';
  targetId: string;
  targetName: string | null;
  channelType: string | null;
  platformId: string | null;
  reverseLink: { localName: string; viewerCanRemove: boolean } | null;
  createdAt: string;
  createdBy: string | null;
}

interface DestinationCandidate {
  id: string;
  name: string;
  folder: string;
  adminOnTarget: boolean;
}

export function DestinationsTab({ gid }: { gid: string }): JSX.Element {
  const [destinations, setDestinations] = useState<DestinationDto[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    const r = await call<{ destinations: DestinationDto[] }>(apiPath(gid, '/destinations'));
    if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
    setDestinations(r.data.destinations);
  }
  useEffect(() => { refresh(); }, [gid]);

  async function remove(d: DestinationDto): Promise<void> {
    if (!confirm(`Remove destination "${d.localName}"?`)) return;
    setBusy(true);
    try {
      const r = await call(apiPath(gid, `/destinations/${encodeURIComponent(d.localName)}`), 'DELETE');
      if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      showToast('Destination removed');
      refresh();
    } finally { setBusy(false); }
  }

  async function removeReverse(d: DestinationDto): Promise<void> {
    if (!d.reverseLink) return;
    if (!confirm(`Remove the reverse link "${d.reverseLink.localName}" in "${d.targetName ?? d.targetId}"?`)) return;
    setBusy(true);
    try {
      const r = await call(
        apiPath(gid, `/destinations/${encodeURIComponent(d.localName)}/reverse`),
        'DELETE',
      );
      if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      showToast('Reverse link removed');
      refresh();
    } finally { setBusy(false); }
  }

  if (!destinations) return <p class="muted">Loading…</p>;

  const agents = destinations.filter((d) => d.targetType === 'agent');
  const channels = destinations.filter((d) => d.targetType === 'channel');

  return (
    <section>
      <p class="muted">
        Destinations are the names this agent uses to route messages — either to channels (auto-managed, listed below) or to other agent groups (added here).
      </p>

      <h4>Agent destinations</h4>
      {agents.length === 0
        ? <p class="muted">No agent destinations yet.</p>
        : (
          <table class="settings-table ga-destinations-table">
            <thead><tr><th>Target agent</th><th>Local name</th><th>Reverse link</th><th></th></tr></thead>
            <tbody>
              {agents.map((d) => (
                <tr key={d.localName}>
                  <td>
                    <div>{d.targetName ?? <span class="muted">(unnamed)</span>}</div>
                    <code class="muted ga-id-sub">{d.targetId}</code>
                  </td>
                  <td><code>{d.localName}</code></td>
                  <td>
                    {d.reverseLink ? (
                      <span class="ga-reverse">
                        <code>{d.reverseLink.localName}</code>
                        {d.reverseLink.viewerCanRemove ? (
                          <button
                            type="button"
                            class="ga-reverse-x"
                            title={`Remove reverse link "${d.reverseLink.localName}" in target group`}
                            disabled={busy}
                            onClick={() => removeReverse(d)}
                          >×</button>
                        ) : (
                          <Tooltip text="You must be an admin of the target group to remove its destinations.">
                            <span class="muted ga-id-sub">(target-admin only)</span>
                          </Tooltip>
                        )}
                      </span>
                    ) : (
                      <span class="muted">—</span>
                    )}
                  </td>
                  <td>
                    <button type="button" class="danger" disabled={busy} onClick={() => remove(d)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      <p class="muted ga-hint">
        A "reverse link" is a destination row in the <em>target</em> group's table pointing back at this one — created either by ticking the box when you add the link, or by an admin of that group adding it independently. Either way it shows up here.
      </p>

      <h4>Add an agent link</h4>
      {adding
        ? <AddDestinationForm gid={gid} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); refresh(); }} />
        : <button type="button" onClick={() => setAdding(true)}>Link another agent…</button>}

      <h4 class="ga-section-h4">Channel destinations</h4>
      <p class="muted">
        Channels (chat platforms, email, web) are wired automatically when a messaging group is connected to this agent — read-only here.
      </p>
      {channels.length === 0
        ? <p class="muted">No channel destinations.</p>
        : (
          <table class="settings-table ga-destinations-table">
            <thead><tr><th>Channel</th><th>Local name</th></tr></thead>
            <tbody>
              {channels.map((d) => (
                <tr key={d.localName}>
                  <td>
                    <div>{d.targetName ?? <span class="muted">(unnamed)</span>}</div>
                    <code class="muted ga-id-sub">
                      {formatChannelHandle(d.channelType, d.platformId, d.targetId)}
                    </code>
                  </td>
                  <td><code>{d.localName}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </section>
  );
}

function AddDestinationForm({ gid, onCancel, onDone }: { gid: string; onCancel: () => void; onDone: () => void }): JSX.Element {
  const [candidates, setCandidates] = useState<DestinationCandidate[] | null>(null);
  const [targetId, setTargetId] = useState('');
  const [localName, setLocalName] = useState('');
  const [alsoReverse, setAlsoReverse] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await call<{ candidates: DestinationCandidate[] }>(apiPath(gid, '/destinations/candidates'));
      if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      setCandidates(r.data.candidates);
    })();
  }, [gid]);

  const selected = candidates?.find((c) => c.id === targetId) ?? null;

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (!targetId || !localName.trim()) return;
    setBusy(true);
    try {
      const r = await call<{ status: 'applied' | 'pending_approval' }>(
        apiPath(gid, '/destinations'),
        'POST',
        { targetAgentGroupId: targetId, localName: localName.trim(), alsoReverse },
      );
      if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      showToast(r.data.status === 'applied' ? 'Destination added' : 'Approval requested');
      onDone();
    } finally { setBusy(false); }
  }

  if (!candidates) return <p class="muted">Loading candidates…</p>;
  if (candidates.length === 0) return (
    <div>
      <p class="muted">No eligible target groups. You must be an admin (or member, when admin-on-target) of another agent group to link it.</p>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  );

  const options: ComboboxOption[] = candidates.map((c) => ({
    value: c.id,
    label: c.name,
    detail: c.adminOnTarget ? c.folder : `${c.folder} · needs approval`,
    tooltip: c.adminOnTarget
      ? `You are an admin of "${c.name}". Linking will apply immediately.`
      : `You are not an admin of "${c.name}". An admin of that group will be asked to approve the link.`,
  }));

  return (
    <form onSubmit={submit} class="ga-add-link-form">
      <Field label="Target agent group">
        <Combobox
          value={targetId || null}
          options={options}
          placeholder="Search by name or id…"
          disabled={busy}
          freeform={false}
          onChange={(v) => {
            const nextTargetId = v ?? '';
            setTargetId(nextTargetId);
            setLocalName(candidates.find((candidate) => candidate.id === nextTargetId)?.folder ?? '');
          }}
        />
      </Field>
      <Field label="Local name">
        <input
          type="text"
          value={localName}
          onInput={(e) => setLocalName((e.target as HTMLInputElement).value)}
          placeholder={selected?.folder ?? 'e.g. research-bot'}
          disabled={busy}
        />
      </Field>
      <Field label="Reverse link">
        <label class="ga-checkbox">
          <input
            type="checkbox"
            checked={alsoReverse}
            onChange={(e) => setAlsoReverse((e.target as HTMLInputElement).checked)}
            disabled={busy}
          />
          Also let the target agent send back to this one
        </label>
      </Field>
      {selected && !selected.adminOnTarget ? (
        <p class="muted ga-hint">
          You are not an admin of "{selected.name}" — an admin of that group will be asked to approve this link.
        </p>
      ) : null}
      <div class="settings-actions">
        <button type="submit" disabled={busy || !targetId || !localName.trim()}>
          {selected?.adminOnTarget ? 'Add' : 'Request'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}