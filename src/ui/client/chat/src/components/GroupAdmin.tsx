// Per-group admin modal — config, members, scoped admin grants.
// Visible only when the active group's `isAdmin` is true. Shared dialog
// chrome keeps desktop and mobile presentation consistent.
import './GroupAdmin.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import {
  groupAdminOpen,
  groupId,
  groups,
  isMobile,
} from '../state';
import { returnToUserMenu, selectGroup } from '../actions';
import { Combobox, type ComboboxOption } from './Combobox';
import { ModelPickerDialog } from './ModelPickerDialog';
import { Tooltip } from './Tooltip';
import { showToast } from './Toast';
import { useBackButtonCloses } from '../modalBackButton';
import { TabBar, type TabItem } from './TabBar';
import { MobileDialog, MobileDialogFooter, MobileDialogItem, MobileDialogList } from './MobileDialog';
import { MembersTab, RolesTab } from './GroupAdminAccess';
import { apiPath, call, errMsg } from './GroupAdminApi';
import { DestinationsTab } from './GroupAdminDestinations';
import { GroupAdminField as Field } from './GroupAdminField';
import { McpServersSection, type McpProbeResultDto, type McpServerConfigDto } from './GroupAdminMcp';
import { ModelParamsEditor } from './GroupAdminModelParams';
import { PackagesSection } from './GroupAdminPackages';
import { SkillsSection } from './GroupAdminSkills';

type Tab = 'models' | 'settings' | 'packages' | 'mcp' | 'skills' | 'members' | 'roles' | 'destinations';

const SETTINGS_SECTIONS = new Set<Tab>(['models', 'settings', 'packages', 'mcp', 'skills']);

const TAB_ITEMS: TabItem[] = [
  { id: 'settings', label: 'Settings', sublabel: 'Image, scope, public site' },
  { id: 'models', label: 'Models', sublabel: 'Provider, model, voice' },
  { id: 'packages', label: 'Packages', sublabel: 'apt / npm / pip in the image' },
  { id: 'mcp', label: 'MCP servers', sublabel: 'External tools wired to the agent' },
  { id: 'skills', label: 'Skills', sublabel: 'Container skills mounted at runtime' },
  { id: 'members', label: 'Members', sublabel: 'Who can use this group' },
  { id: 'roles', label: 'Admins', sublabel: 'Admins for this group' },
  { id: 'destinations', label: 'Destinations', sublabel: 'Where this group can send messages' },
];

interface HeaderActions {
  refresh: () => void;
  apply: () => void;
  busy: boolean;
  canSave: boolean;
}

interface SettingsResponse {
  id: string;
  name: string;
  folder: string;
  createdAt: string;
  updatedAt: string | null;
  config: {
    provider: string | null;
    model: string | null;
    small_model: string | null;
    effort: string | null;
    image_tag: string | null;
    assistant_name: string | null;
    max_messages_per_prompt: number | null;
    cli_scope: string | null;
    voice_mode: string | null;
    transcription_model: string | null;
  };
  modelParams: Record<string, unknown>;
  packages: { apt: string[]; npm: string[]; pip: string[] };
  mcpServers: Record<string, McpServerConfigDto>;
  skills: string[] | 'all';
  defaults: {
    provider: string | null;
    model: string | null;
    image_tag: string | null;
    transcription_model: string | null;
  };
  validProviders: string[];
  validCliScopes: string[];
  validVoiceModes: string[];
  runningSessionCount: number;
  selectedModelDetail: { label: string; detail?: string; tooltip?: string } | null;
  selectedImageDetail: { label: string; createdAt: string | null; size: number | null } | null;
  actorIsElevated: boolean;
  providesAgentSurfaces: boolean;
  site: {
    available: boolean;
    baseDomain: string | null;
    slug: string | null;
    fqdn: string | null;
    url: string | null;
    enabled: boolean;
  };
}

interface ImageSuggestion {
  value: string;
  label: string;
  createdAt: string | null;
  size: number | null;
  isDefault: boolean;
}

interface ImagesResponse {
  images: ImageSuggestion[];
}

const PROVIDER_INFO: Record<string, string> = {
  claude: 'Claude — Anthropic models via the official SDK. Uses your OneCLI-injected Anthropic API key.',
  opencode: 'OpenCode — multi-provider gateway (OpenRouter, DeepSeek, OpenCode Zen, Anthropic, etc.) selected by host OPENCODE_PROVIDER. Wire prefix is handled automatically.',
};

function formatAge(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diffMs = Date.now() - t;
  const day = 24 * 3600 * 1000;
  const hour = 3600 * 1000;
  if (diffMs < hour) return 'just now';
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  const days = Math.floor(diffMs / day);
  if (days < 7) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  if (days < 730) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function formatSize(bytes: number | null): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function GroupAdmin(): JSX.Element | null {
  const open = groupAdminOpen.value;
  const gid = groupId.value;
  const mobile = isMobile.value;
  const [tab, setTab] = useState<Tab | null>(() => (isMobile.value ? null : 'settings'));
  const actionsRef = useRef<HeaderActions | null>(null);
  const [, forceRender] = useState(0);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [returnToMenuAfterDiscard, setReturnToMenuAfterDiscard] = useState(false);
  useEffect(() => {
    setTab(isMobile.value ? null : 'settings');
    setCloseConfirmOpen(false);
    setReturnToMenuAfterDiscard(false);
  }, [open, gid]);
  useBackButtonCloses(open, () => { groupAdminOpen.value = false; });

  if (!open || !gid) return null;
  const group = groups.value.find((g) => g.id === gid);
  const title = group ? `Agent Settings · ${group.name}` : 'Agent Settings';

  function hardClose(returnToMenu = false): void {
    if (returnToMenu) returnToUserMenu(groupAdminOpen);
    else groupAdminOpen.value = false;
  }
  function attemptClose(returnToMenu = false): void {
    if (actionsRef.current?.canSave) {
      setReturnToMenuAfterDiscard(returnToMenu);
      setCloseConfirmOpen(true);
    } else {
      hardClose(returnToMenu);
    }
  }
  function onKey(e: KeyboardEvent): void { if (e.key === 'Escape') attemptClose(); }

  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const ha = actionsRef.current;
  const setActions = (a: HeaderActions | null) => { actionsRef.current = a; forceRender((n) => n + 1); };
  const activeTab = tab ?? (mobile ? null : 'settings');

  return (
    <MobileDialog
      title={title}
      onClose={() => attemptClose()}
      onBack={mobile ? (activeTab !== null ? () => setTab(null) : () => attemptClose(true)) : undefined}
      backLabel={activeTab !== null ? 'Back to all sections' : 'Back to account menu'}
      actions={activeTab !== null && SETTINGS_SECTIONS.has(activeTab) && ha ? (
        <Tooltip text={ha.canSave ? 'Save changes' : 'Nothing to save'}>
          <button type="button" class="mobile-dialog-icon" aria-label="Save" onClick={ha.apply} disabled={ha.busy || !ha.canSave}>&#x2713;</button>
        </Tooltip>
      ) : null}
    >
      {!mobile ? (
        <TabBar
          ariaLabel="Group settings sections"
          mobileSheetTitle="Settings sections"
          activeId={activeTab}
          items={TAB_ITEMS}
          onSelect={(id) => setTab(id as Tab)}
          className="group-admin-tab-bar tab-bar-header"
        />
      ) : null}
      {mobile && activeTab === null ? (
        <MobileSectionList items={TAB_ITEMS} onSelect={(id) => setTab(id as Tab)} />
      ) : (
        <div class={`settings-body${activeTab === 'mcp' ? ' ga-mcp-settings-body' : ''}`}>
          {activeTab !== null && SETTINGS_SECTIONS.has(activeTab)
            ? <SettingsTab gid={gid} section={activeTab as 'models' | 'settings' | 'packages' | 'mcp' | 'skills'} onClose={hardClose} onActions={setActions} />
            : null}
          {activeTab === 'members' ? <MembersTab gid={gid} /> : null}
          {activeTab === 'roles' ? <RolesTab gid={gid} /> : null}
          {activeTab === 'destinations' ? <DestinationsTab gid={gid} /> : null}
        </div>
      )}
      {closeConfirmOpen ? (
        <MobileDialog
          title="Discard unsaved changes?"
          onClose={() => { setCloseConfirmOpen(false); setReturnToMenuAfterDiscard(false); }}
          maxWidth="420px"
          className="ga-confirm-modal"
        >
          <div class="settings-body">
            <p class="group-admin-help">You have unsaved changes. Closing now discards them.</p>
          </div>
          <MobileDialogFooter className="ga-confirm-foot">
            <button type="button" onClick={() => { setCloseConfirmOpen(false); setReturnToMenuAfterDiscard(false); }}>Keep editing</button>
            <button type="button" class="danger" data-testid="discard-and-close-btn" onClick={() => { setCloseConfirmOpen(false); hardClose(returnToMenuAfterDiscard); }}>
              Discard &amp; close
            </button>
          </MobileDialogFooter>
        </MobileDialog>
      ) : null}
    </MobileDialog>
  );
}
function MobileSectionList({ items, onSelect }: { items: TabItem[]; onSelect: (id: string) => void }): JSX.Element {
  return (
    <MobileDialogList>
      {items.map((it) => (
        <MobileDialogItem key={it.id} label={it.label} sublabel={it.sublabel} chevron onClick={() => onSelect(it.id)} />
      ))}
    </MobileDialogList>
  );
}
function SettingsTab({ gid, section, onClose, onActions }: { gid: string; section: 'models' | 'settings' | 'packages' | 'mcp' | 'skills'; onClose: () => void; onActions: (a: HeaderActions | null) => void }): JSX.Element {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<SettingsResponse['config'] | null>(null);
  const [draftName, setDraftName] = useState('');
  const [siteEnabled, setSiteEnabled] = useState(false);
  const [siteSlug, setSiteSlug] = useState('');
  const [draftModelParams, setDraftModelParams] = useState<Record<string, unknown>>({});
  const [draftPackages, setDraftPackages] = useState<{ apt: string[]; npm: string[]; pip: string[] }>({ apt: [], npm: [], pip: [] });
  const [draftMcpServers, setDraftMcpServers] = useState<Record<string, McpServerConfigDto>>({});
  const [draftSkills, setDraftSkills] = useState<string[] | 'all'>([]);
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState<ImagesResponse | null>(null);

  async function refresh(): Promise<void> {
    setBusy(true);
    try {
      const r = await call<SettingsResponse>(apiPath(gid, '/settings'));
      if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      setData(r.data);
      setDraft({ ...r.data.config });
      setDraftName(r.data.name);
      setSiteEnabled(r.data.site.enabled);
      setSiteSlug(r.data.site.slug ?? '');
      setDraftModelParams(r.data.modelParams);
      setDraftPackages({
        apt: [...(r.data.packages?.apt ?? [])],
        npm: [...(r.data.packages?.npm ?? [])],
        pip: [...(r.data.packages?.pip ?? [])],
      });
      setDraftMcpServers({ ...(r.data.mcpServers ?? {}) });
      setDraftSkills(r.data.skills === 'all' ? 'all' : [...(r.data.skills ?? [])]);
    } finally { setBusy(false); }
  }

  useEffect(() => { refresh(); }, [gid]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await call<ImagesResponse>(apiPath(gid, '/images'));
      if (!cancelled) setImages(r.ok ? r.data : { images: [] });
    })();
    return () => { cancelled = true; };
  }, [gid]);

  const provider = draft?.provider ?? null;
  if (!data || !draft) return <p class="muted">Loading…</p>;

  function update<K extends keyof SettingsResponse['config']>(k: K, v: SettingsResponse['config'][K]): void {
    setDraft((d) => (d ? { ...d, [k]: v } : d));
  }

  async function runRestart(rebuild: boolean): Promise<{ ok: boolean; restarted?: number }> {
    const r = await call<{ restarted: number; rebuilt: boolean }>(apiPath(gid, '/restart'), 'POST', { rebuild });
    if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return { ok: false }; }
    return { ok: true, restarted: r.data.restarted };
  }

  async function testMcpServer(name: string, server: McpServerConfigDto): Promise<McpProbeResultDto> {
    const r = await call<McpProbeResultDto>(apiPath(gid, '/mcp-servers/test'), 'POST', { name, server });
    if (!r.ok) {
      return { ok: false, latencyMs: 0, phase: 'container', error: errMsg(r.data, `HTTP ${r.status}`) };
    }
    return r.data;
  }

  const RESTART_REQUIRING_FIELDS = new Set([
    'provider', 'model', 'small_model', 'effort', 'image_tag', 'assistant_name', 'max_messages_per_prompt',
    'model_params', 'mcp_servers', 'skills', 'packages_apt', 'packages_npm', 'packages_pip',
  ]);

  function changedFields(): Set<string> {
    const out = new Set<string>();
    if (!data || !draft) return out;
    if (draftName.trim() !== data.name) out.add('name');
    for (const k of Object.keys(draft) as (keyof SettingsResponse['config'])[]) {
      if (draft[k] !== data.config[k]) out.add(k);
    }
    if (data.site.available) {
      if (siteEnabled !== data.site.enabled) out.add('site_enabled');
      if (data.actorIsElevated && siteSlug.trim() !== (data.site.slug ?? '')) out.add('site_slug');
    }
    if (JSON.stringify(draftModelParams) !== JSON.stringify(data.modelParams ?? {})) out.add('model_params');
    const dataPkg = data.packages ?? { apt: [], npm: [], pip: [] };
    if (JSON.stringify(draftPackages.apt) !== JSON.stringify(dataPkg.apt)) out.add('packages_apt');
    if (JSON.stringify(draftPackages.npm) !== JSON.stringify(dataPkg.npm)) out.add('packages_npm');
    if (JSON.stringify(draftPackages.pip) !== JSON.stringify(dataPkg.pip)) out.add('packages_pip');
    if (JSON.stringify(draftMcpServers) !== JSON.stringify(data.mcpServers ?? {})) out.add('mcp_servers');
    if (JSON.stringify(draftSkills) !== JSON.stringify(data.skills ?? [])) out.add('skills');
    return out;
  }

  const pending = changedFields();
  const changed = pending.size > 0;
  const needsRestart = [...pending].some((f) => RESTART_REQUIRING_FIELDS.has(f));
  const imageRebuildNeeded = pending.has('image_tag')
    && draft.image_tag != null
    && !!images
    && !images.images.some((i) => i.value === draft.image_tag);
  const packagesChanged = pending.has('packages_apt') || pending.has('packages_npm') || pending.has('packages_pip');
  const needsRebuild = imageRebuildNeeded || packagesChanged;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restartChecked, setRestartChecked] = useState(false);
  const [rebuildChecked, setRebuildChecked] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState('');
  const [archiveBusy, setArchiveBusy] = useState(false);
  const effectiveRestart = restartChecked || rebuildChecked;
  const effectiveRebuild = rebuildChecked;
  const canSave = changed;

  useEffect(() => {
    onActions({ refresh, apply, busy, canSave });
    return () => onActions(null);
  }, [busy, canSave, needsRestart, needsRebuild]);

  function apply(): void {
    if (!changed) return;
    setRestartChecked(needsRestart || needsRebuild);
    setRebuildChecked(needsRebuild);
    setConfirmOpen(true);
  }

  async function doApply(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    try {
      const JSON_FIELDS = new Set([
        'model_params', 'mcp_servers', 'skills',
        'packages_apt', 'packages_npm', 'packages_pip',
      ]);
      const settingsChanged = [...pending].some((f) => !JSON_FIELDS.has(f));
      if (settingsChanged) {
        const body: Record<string, unknown> = { ...draft };
        if (data && draftName.trim() !== data.name) body.name = draftName.trim();
        if (pending.has('site_enabled')) body.site_enabled = siteEnabled;
        if (pending.has('site_slug')) body.site_slug = siteSlug.trim() || null;
        const r = await call<SettingsResponse>(apiPath(gid, '/settings'), 'PATCH', body);
        if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      }
      if (pending.has('model_params')) {
        const r = await call(apiPath(gid, '/model-params'), 'PATCH', { params: draftModelParams });
        if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      }
      if (pending.has('packages_apt') || pending.has('packages_npm') || pending.has('packages_pip')) {
        const body: Record<string, string[]> = {};
        if (pending.has('packages_apt')) body.apt = draftPackages.apt;
        if (pending.has('packages_npm')) body.npm = draftPackages.npm;
        if (pending.has('packages_pip')) body.pip = draftPackages.pip;
        const r = await call(apiPath(gid, '/packages'), 'PATCH', body);
        if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      }
      if (pending.has('mcp_servers')) {
        const r = await call(apiPath(gid, '/mcp-servers'), 'PATCH', { servers: draftMcpServers });
        if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      }
      if (pending.has('skills')) {
        const r = await call(apiPath(gid, '/skills'), 'PATCH', { skills: draftSkills });
        if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      }

      const fresh = await call<SettingsResponse>(apiPath(gid, '/settings'));
      if (fresh.ok) {
        setData(fresh.data);
        setDraft({ ...fresh.data.config });
        setDraftName(fresh.data.name);
        setSiteEnabled(fresh.data.site.enabled);
        setSiteSlug(fresh.data.site.slug ?? '');
        setDraftModelParams(fresh.data.modelParams);
        setDraftPackages({
          apt: [...(fresh.data.packages?.apt ?? [])],
          npm: [...(fresh.data.packages?.npm ?? [])],
          pip: [...(fresh.data.packages?.pip ?? [])],
        });
        setDraftMcpServers({ ...(fresh.data.mcpServers ?? {}) });
        setDraftSkills(fresh.data.skills === 'all' ? 'all' : [...(fresh.data.skills ?? [])]);
        groups.value = groups.value.map((g) => g.id === gid ? { ...g, name: fresh.data.name } : g);
      }
      if (effectiveRebuild || effectiveRestart) {
        const r = await runRestart(effectiveRebuild);
        if (!r.ok) return;
        showToast(effectiveRebuild
          ? `Rebuilt image and restarted ${r.restarted} session${r.restarted === 1 ? '' : 's'}.`
          : `Restarted ${r.restarted} session${r.restarted === 1 ? '' : 's'}.`);
      } else {
        showToast('Saved.');
      }
      setConfirmOpen(false);
      onClose();
    } finally { setBusy(false); }
  }

  async function doArchive(): Promise<void> {
    if (archiveBusy) return;
    setArchiveBusy(true);
    try {
      const r = await call<{ ok: boolean; folder: string; archivedFolder: string }>(
        apiPath(gid, '/archive'), 'POST', { confirm_folder: archiveConfirm.trim() },
      );
      if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      const remaining = groups.value.filter((g) => g.id !== gid);
      groups.value = remaining;
      setArchiveOpen(false);
      onClose();
      showToast(`Archived. Restore on the host with: ncl groups restore --folder ${r.data.folder}`);
      if (groupId.value === gid && remaining[0]) void selectGroup(remaining[0].id);
    } finally { setArchiveBusy(false); }
  }

  const imageOptions: ComboboxOption[] = (images?.images ?? []).map((i) => {
    const age = formatAge(i.createdAt);
    const size = formatSize(i.size);
    const detailParts = [age, size, i.isDefault ? 'default' : null].filter(Boolean) as string[];
    return {
      value: i.value,
      label: i.label,
      detail: detailParts.length ? detailParts.join(' · ') : undefined,
      tooltip: [
        i.value,
        i.createdAt ? `Created: ${new Date(i.createdAt).toLocaleString()}` : null,
        size ? `Size: ${size}` : null,
        i.isDefault ? 'Install default image (used when image_tag is unset).' : null,
      ].filter(Boolean).join('\n'),
    };
  });
  const selectedImg = images?.images.find((i) => i.value === draft.image_tag) ?? null;
  const selectedImgAge = formatAge(selectedImg?.createdAt ?? null);
  const selectedImgSize = formatSize(selectedImg?.size ?? null);

  return (
    <section class={section === 'mcp' ? 'ga-mcp-tab' : undefined}>
      {section === 'settings' ? (
        <div class="group-admin-toolbar">
          <p class="muted ga-folder-line">
            Folder <code>{data.folder}</code> <code class="ga-folder-id">{data.id}</code>{data.updatedAt ? ` · last updated ${new Date(data.updatedAt).toLocaleString()}` : ''}
            {data.runningSessionCount > 0 ? ` · ${data.runningSessionCount} running session${data.runningSessionCount === 1 ? '' : 's'}` : ' · no running sessions'}
          </p>
        </div>
      ) : null}
      {section === 'models' ? (
        <>
          <Field label="Provider" info={draft.provider ? PROVIDER_INFO[draft.provider] ?? `Provider "${draft.provider}".` : undefined}>
            <Combobox
              value={draft.provider}
              options={(() => {
                const selectable = data.validProviders.slice();
                if (draft.provider && !selectable.includes(draft.provider)) selectable.push(draft.provider);
                return selectable.map((p) => ({ value: p, label: p, tooltip: PROVIDER_INFO[p] }));
              })()}
              placeholder={data.defaults.provider ? `default: ${data.defaults.provider}` : 'pick a provider'}
              disabled={busy}
              freeform={false}
              onChange={(v) => update('provider', v)}
            />
            {data.providesAgentSurfaces ? (
              <p class="group-admin-help">
                This provider composes its own instructions and discovers skills its own way, so the
                Skills selection and Assistant name don't apply while it's active.
              </p>
            ) : null}
          </Field>
          <Field label="Model">
            <ModelPickerDialog
              value={draft.model}
              provider={provider ?? data.defaults.provider}
              placeholder={data.defaults.model ? `default: ${data.defaults.model}` : 'pick or type a model id'}
              disabled={busy}
              apiBasePath={apiPath(gid, '')}
              outputModality="text"
              onChange={(v) => update('model', v)}
            />
          </Field>
          <Field label="Small model" info="Lighter model for background tasks like compaction and summaries (cost optimization). Used by OpenCode; other providers may use in future.">
            <ModelPickerDialog
              value={draft.small_model}
              provider={provider ?? data.defaults.provider}
              placeholder="same as main model"
              disabled={busy}
              apiBasePath={apiPath(gid, '')}
              outputModality="text"
              onChange={(v) => update('small_model', v)}
            />
          </Field>
          <Field label="Transcription model" info={'OpenRouter model used when the main model cannot accept audio directly. When set, a mic button appears in the chat composer.\nLeave blank to disable voice input.'}>
            <ModelPickerDialog
              value={draft.transcription_model}
              provider="openrouter"
              placeholder={data.defaults.transcription_model || 'google/gemini-2.0-flash-lite-001'}
              disabled={busy}
              apiBasePath={apiPath(gid, '')}
              inputModality="audio"
              onChange={(v) => update('transcription_model', v)}
            />
          </Field>
          <ModelParamsEditor gid={gid} provider={draft.provider} value={draftModelParams} busy={busy} onChange={setDraftModelParams} />
        </>
      ) : null}
      {section === 'settings' ? (
        <>
      <Field label="Name">
        <input type="text" value={draftName} disabled={busy} maxLength={100} onInput={(e) => setDraftName((e.target as HTMLInputElement).value)} />
      </Field>
      <Field label="Effort">
        <input
          type="text"
          value={draft.effort ?? ''}
          disabled={busy}
          onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => update('effort', e.currentTarget.value || null)}
          placeholder="provider-specific (e.g. high)"
        />
      </Field>

      <Field label="Image tag">
        <div class="group-admin-stack">
          <Combobox
            value={draft.image_tag}
            options={imageOptions}
            placeholder={data.defaults.image_tag ? `default: ${data.defaults.image_tag}` : 'pick an image'}
            disabled={busy}
            onChange={(v) => update('image_tag', v)}
          />
          {selectedImg ? (
            <div class="group-admin-selected-info">
              <div class="selected-title">
                {selectedImg.label}
                {(selectedImgAge || selectedImgSize) ? (
                  <span class="selected-detail"> · {[selectedImgAge, selectedImgSize].filter(Boolean).join(' · ')}</span>
                ) : null}
                {selectedImg.isDefault ? <span class="selected-detail"> · default</span> : null}
              </div>
              {selectedImg.createdAt ? (
                <pre class="selected-tooltip">Created: {new Date(selectedImg.createdAt).toLocaleString()}</pre>
              ) : null}
            </div>
          ) : (draft.image_tag && images) ? (
            <p class="group-admin-help">Tag not in local image list — will fail at container start if not pulled.</p>
          ) : null}
        </div>
      </Field>

      <Field label="Assistant name">
        <input
          type="text"
          value={draft.assistant_name ?? ''}
          disabled={busy}
          onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => update('assistant_name', e.currentTarget.value || null)}
        />
      </Field>

      <Field
        label="Max messages / prompt"
        info="Hard cap on how many history messages get included in each model call. Higher = more context but more cost; lower = faster + cheaper but the agent forgets sooner. Leave blank for the provider default."
      >
        <input
          type="number"
          min={1}
          max={1000}
          value={draft.max_messages_per_prompt ?? ''}
          disabled={busy}
          onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => {
            const v = e.currentTarget.value;
            update('max_messages_per_prompt', v ? Number(v) : null);
          }}
        />
      </Field>

      <Field
        label="CLI scope"
        info={'Controls which `ncl` commands an agent in this group can run.\n' +
          'disabled = no CLI access.\n' +
          'group = limited to the group\'s own resources.\n' +
          'global = unrestricted (owner / global admin only — use sparingly).'}
      >
        <Combobox
          value={draft.cli_scope}
          options={data.validCliScopes
            // `global` is privilege escalation for a scoped admin (the agent
            // can run any `ncl` command system-wide), so hide it from
            // non-elevated admins. Server enforces independently.
            .filter((s) => s !== 'global' || data.actorIsElevated || draft.cli_scope === 'global')
            .map((s) => ({
              value: s,
              label: s,
              tooltip: s === 'global' && !data.actorIsElevated
                ? 'Owner / global admin only.'
                : undefined,
            }))}
          placeholder="pick a scope"
          disabled={busy}
          freeform={false}
          onChange={(v) => update('cli_scope', v)}
        />
      </Field>

      {data.site.available ? (
        <Field
          label="Website"
          info={'Serve a public static website for this group from a folder in its workspace. Files in the FQDN-named folder become readable by anyone with the link \u2014 no login required. Separate from private file-share links.'}
        >
          <div class="group-admin-stack">
            <label class="group-admin-check">
              <input
                type="checkbox"
                checked={siteEnabled}
                disabled={busy}
                onChange={(e) => setSiteEnabled((e.target as HTMLInputElement).checked)}
              />
              <span>Enable website</span>
            </label>
            {data.actorIsElevated ? (
              <input
                type="text"
                value={siteSlug}
                disabled={busy}
                maxLength={63}
                placeholder={data.site.baseDomain ? `subdomain (.${data.site.baseDomain})` : 'subdomain'}
                onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setSiteSlug(e.currentTarget.value)}
              />
            ) : null}
            {siteEnabled && data.site.url ? (
              <p class="group-admin-help">
                Live at <a href={data.site.url} target="_blank" rel="noopener noreferrer">{data.site.url}</a>{' '}
                — publish by writing files into the <code>{data.site.fqdn}</code> folder in the workspace.
              </p>
            ) : siteEnabled ? (
              <p class="group-admin-help">Save to allocate a subdomain and go live.</p>
            ) : (
              <p class="group-admin-help">Disabled — enable to publish a public static site on its own subdomain.</p>
            )}
          </div>
        </Field>
      ) : null}

      <div class="group-admin-danger-zone" data-testid="danger-zone">
        <button
          type="button"
          class="danger"
          data-testid="archive-btn"
          disabled={busy || archiveBusy}
          onClick={() => { setArchiveConfirm(''); setArchiveOpen(true); }}
        >
          Archive group…
        </button>
      </div>
        </>
      ) : null}

      {section === 'packages' ? (
        <PackagesSection
          value={draftPackages}
          busy={busy}
          onChange={setDraftPackages}
        />
      ) : null}

      {section === 'mcp' ? (
        <McpServersSection
          value={draftMcpServers}
          busy={busy}
          onChange={setDraftMcpServers}
          onTest={testMcpServer}
        />
      ) : null}

      {section === 'skills' ? (
        <SkillsSection
          value={draftSkills}
          busy={busy}
          onChange={setDraftSkills}
        />
      ) : null}

      <div class="settings-row group-admin-actions" style="margin-top:16px">
        <p class="group-admin-help">
          {changed
            ? `${pending.size} unsaved change${pending.size === 1 ? '' : 's'}. Click Save (✓) above to review and apply.`
            : 'No unsaved changes.'}
        </p>
      </div>

      {confirmOpen ? (
        <MobileDialog
          title="Apply changes"
          onClose={() => setConfirmOpen(false)}
          closeDisabled={busy}
          maxWidth="440px"
          className="ga-confirm-modal"
        >
            <div class="settings-body">
              <p class="group-admin-help" style="margin-bottom:12px">
                {pending.size} setting{pending.size === 1 ? '' : 's'} will be saved:{' '}
                <code>{[...pending].join(', ')}</code>
              </p>
              <div class="ga-confirm-options">
                <label class="group-admin-check">
                  <input
                    type="checkbox"
                    checked={effectiveRestart}
                    disabled={busy || rebuildChecked /* rebuild always restarts */}
                    onChange={(e) => setRestartChecked((e.target as HTMLInputElement).checked)}
                  />
                  <span>Restart sessions</span>
                  <Tooltip text={'Stop and respawn all running container sessions for this group so they pick up the saved config.\nDefaults on when you change provider, model, effort, image tag, assistant name, or max messages per prompt. CLI scope alone does not need a restart — it is re-read on every CLI call.\nActive conversations resume on the next user message.'}>
                    <span class="info-icon" aria-label="More info">i</span>
                  </Tooltip>
                </label>
                <label class="group-admin-check">
                  <input
                    type="checkbox"
                    checked={rebuildChecked}
                    disabled={busy}
                    onChange={(e) => setRebuildChecked((e.target as HTMLInputElement).checked)}
                  />
                  <span>Rebuild image</span>
                  <Tooltip text={'Rebuild the container image before restarting.\nDefaults on when the chosen image tag does not exist locally. Otherwise normally only needed after `ncl groups config add-package` / `add-mcp-server` or a base-image change — that workflow lives in the CLI today, not this UI.\nA rebuild always implies a restart and takes minutes, not seconds.'}>
                    <span class="info-icon" aria-label="More info">i</span>
                  </Tooltip>
                </label>
              </div>
              {needsRestart && !effectiveRestart ? (
                <p class="ga-confirm-warn">
                  These changes won&rsquo;t take effect until the sessions restart.
                </p>
              ) : null}
            </div>
            <MobileDialogFooter className="ga-confirm-foot">
              <button type="button" disabled={busy} onClick={() => setConfirmOpen(false)}>Cancel</button>
              <button type="button" class="primary" disabled={busy} onClick={doApply}>
                {busy
                  ? 'Applying…'
                  : effectiveRebuild
                    ? 'Save & rebuild'
                    : effectiveRestart
                      ? 'Save & restart'
                      : 'Save'}
              </button>
            </MobileDialogFooter>
        </MobileDialog>
      ) : null}

      {archiveOpen ? (
        <MobileDialog
          title="Archive group"
          onClose={() => setArchiveOpen(false)}
          closeDisabled={archiveBusy}
          maxWidth="440px"
          className="ga-confirm-modal"
        >
            <div class="settings-body">
              <p class="group-admin-help" style="margin-bottom:12px">
                Running container sessions will stop and the group will be removed from this UI.
                Its folder is renamed with a <code>~</code> suffix — nothing is deleted.
              </p>
              <p class="group-admin-help" style="margin-bottom:12px">
                Restore is host-only: <code>ncl groups restore --folder {data.folder}</code>.
              </p>
              <p class="group-admin-help" style="margin-bottom:8px">
                Type <code>{data.folder}</code> to confirm:
              </p>
              <input
                type="text"
                data-testid="archive-confirm-input"
                value={archiveConfirm}
                disabled={archiveBusy}
                placeholder={data.folder}
                onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setArchiveConfirm(e.currentTarget.value)}
              />
            </div>
            <MobileDialogFooter className="ga-confirm-foot">
              <button type="button" disabled={archiveBusy} onClick={() => setArchiveOpen(false)}>Cancel</button>
              <button
                type="button"
                class="danger"
                data-testid="archive-confirm-btn"
                disabled={archiveBusy || archiveConfirm.trim() !== data.folder}
                onClick={doArchive}
              >
                {archiveBusy ? 'Archiving…' : 'Archive group'}
              </button>
            </MobileDialogFooter>
        </MobileDialog>
      ) : null}
    </section>
  );
}
