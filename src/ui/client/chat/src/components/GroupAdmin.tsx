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
import { InfoIcon, Tooltip } from './Tooltip';
import { showToast } from './Toast';
import { useBackButtonCloses } from '../modalBackButton';
import { TabBar, type TabItem } from './TabBar';
import { MobileDialog, MobileDialogFooter, MobileDialogItem, MobileDialogList } from './MobileDialog';

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

interface McpStdioServerDto {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
  timeout?: number;
}

interface McpHttpServerDto {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  instructions?: string;
  timeout?: number;
}

type McpServerConfigDto = McpStdioServerDto | McpHttpServerDto;


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
  /** Freeform provider knobs. Edited via PATCH /model-params or `ncl groups config set-param`. */
  modelParams: Record<string, unknown>;
  /** Installed packages — image rebuild required to take effect. */
  packages: { apt: string[]; npm: string[]; pip: string[] };
  /** Per-group MCP servers — restart required to take effect. */
  mcpServers: Record<string, McpServerConfigDto>;
  /** Container skill selection. `'all'` mounts every available container skill. */
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
  /**
   * When true the effective provider owns its own agent-facing surfaces, so
   * the Skills tab and assistant-name field are no-ops. The UI annotates them.
   */
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

interface MemberDto {
  userId: string;
  displayName: string | null;
  primaryHandle: string | null;
  primaryChannel: string | null;
  isExplicitMember: boolean;
  isAdmin: boolean;
}

interface RoleDto {
  userId: string;
  displayName: string | null;
  primaryHandle: string | null;
  primaryChannel: string | null;
  grantedAt: string;
  grantedBy: string | null;
}

interface UserSearchDto {
  userId: string;
  displayName: string | null;
  kind: string;
  primaryHandle: string | null;
  primaryChannel: string | null;
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

function apiPath(gid: string, sub: string): string {
  return `/ui/chat/api/groups/${encodeURIComponent(gid)}/admin${sub}`;
}

async function call<T>(
  url: string,
  method: string = 'GET',
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T }> {
  const r = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: T = {} as T;
  try { data = (await r.json()) as T; } catch { /* non-JSON */ }
  return { ok: r.ok, status: r.status, data };
}

function errMsg(d: unknown, fallback: string): string {
  const e = (d as { error?: unknown })?.error;
  return typeof e === 'string' && e ? e : fallback;
}

function userLabel(u: { displayName?: string | null; primaryHandle?: string | null; primaryChannel?: string | null; userId: string }): string {
  if (u.displayName) return u.displayName;
  if (u.primaryHandle) return `${u.primaryChannel ?? '?'}:${u.primaryHandle}`;
  return u.userId;
}

export function GroupAdmin(): JSX.Element | null {
  const open = groupAdminOpen.value;
  const gid = groupId.value;
  const mobile = isMobile.value;
  // On mobile we open into a section list (no section selected). Desktop
  // always has an active tab so the body is never empty.
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
            <>
              {activeTab !== null && SETTINGS_SECTIONS.has(activeTab)
                ? <SettingsTab gid={gid} section={activeTab as 'models' | 'settings' | 'packages' | 'mcp' | 'skills'} onClose={hardClose} onActions={setActions} />
                : null}
              {activeTab === 'members' ? <MembersTab gid={gid} /> : null}
              {activeTab === 'roles' ? <RolesTab gid={gid} /> : null}
              {activeTab === 'destinations' ? <DestinationsTab gid={gid} /> : null}
            </>
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
                <p class="group-admin-help">
                  You have unsaved changes. Closing now discards them.
                </p>
              </div>
              <MobileDialogFooter className="ga-confirm-foot">
                <button type="button" onClick={() => { setCloseConfirmOpen(false); setReturnToMenuAfterDiscard(false); }}>Keep editing</button>
                <button
                  type="button"
                  class="danger"
                  data-testid="discard-and-close-btn"
                  onClick={() => { setCloseConfirmOpen(false); hardClose(returnToMenuAfterDiscard); }}
                >
                  Discard &amp; close
                </button>
              </MobileDialogFooter>
          </MobileDialog>
        ) : null}
    </MobileDialog>
  );
}

// Mobile-only: vertical list of section rows shown as the modal body
// before the user has drilled into a section.
function MobileSectionList({ items, onSelect }: { items: TabItem[]; onSelect: (id: string) => void }): JSX.Element {
  return (
    <MobileDialogList>
      {items.map((it) => (
        <MobileDialogItem
          key={it.id}
          label={it.label}
          sublabel={it.sublabel}
          chevron
          onClick={() => onSelect(it.id)}
        />
      ))}
    </MobileDialogList>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────

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

  // Image list is global (not per-provider) — fetch once when the modal opens.
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

  // Which fields actually require a container restart to take effect?
  // model_params, mcp_servers, skills, and packages all need restart; only
  // packages require an image rebuild (handled separately via needsRebuild).
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
    // JSON columns — compare by serialized form so key order doesn't matter.
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
  // Restart needed if any restart-requiring field changed.
  const needsRestart = [...pending].some((f) => RESTART_REQUIRING_FIELDS.has(f));
  // Rebuild auto-suggested when (a) the new image_tag isn't in the local image
  // list, or (b) any package list changed (apt/npm/pip).
  const imageRebuildNeeded = pending.has('image_tag')
    && draft.image_tag != null
    && !!images
    && !images.images.some((i) => i.value === draft.image_tag);
  const packagesChanged = pending.has('packages_apt') || pending.has('packages_npm') || pending.has('packages_pip');
  const needsRebuild = imageRebuildNeeded || packagesChanged;

  // Restart / rebuild are confirmed in a dialog opened on Apply, rather than
  // toggled inline in the form. The checkboxes default to checked when the
  // pending changes only take effect after a restart / rebuild.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restartChecked, setRestartChecked] = useState(false);
  const [rebuildChecked, setRebuildChecked] = useState(false);

  // Danger zone (archive): typed-confirmation flow. The string the user
  // types must equal the group's folder slug exactly; the server re-checks.
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState('');
  const [archiveBusy, setArchiveBusy] = useState(false);

  // Rebuild implies restart. Force it on if the user ticks rebuild.
  const effectiveRestart = restartChecked || rebuildChecked;
  const effectiveRebuild = rebuildChecked;

  // Report actions to parent header. Apply only opens the confirmation
  // dialog — the actual save/restart happens in `doApply`.
  const canSave = changed;
  useEffect(() => {
    onActions({ refresh, apply, busy, canSave });
    return () => onActions(null);
  }, [busy, canSave, needsRestart, needsRebuild]);

  // Open the confirmation dialog, seeding the checkboxes from the suggested
  // defaults for the current pending changes.
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
      // Split saves by endpoint. Each is full-replace on its slice. /settings
      // covers scalar config + name + site; the others mirror their CLI
      // counterparts (set-param / add-package / add-mcp-server).
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
        const r = await call<{ modelParams: Record<string, unknown> }>(
          apiPath(gid, '/model-params'), 'PATCH', { params: draftModelParams },
        );
        if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      }
      if (pending.has('packages_apt') || pending.has('packages_npm') || pending.has('packages_pip')) {
        const body: Record<string, string[]> = {};
        if (pending.has('packages_apt')) body.apt = draftPackages.apt;
        if (pending.has('packages_npm')) body.npm = draftPackages.npm;
        if (pending.has('packages_pip')) body.pip = draftPackages.pip;
        const r = await call<unknown>(apiPath(gid, '/packages'), 'PATCH', body);
        if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      }
      if (pending.has('mcp_servers')) {
        const r = await call<unknown>(apiPath(gid, '/mcp-servers'), 'PATCH', { servers: draftMcpServers });
        if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      }
      if (pending.has('skills')) {
        const r = await call<unknown>(apiPath(gid, '/skills'), 'PATCH', { skills: draftSkills });
        if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      }

      // Re-fetch so all drafts re-baseline from authoritative server state.
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
      // Restart / rebuild as chosen in the confirmation dialog.
      if (effectiveRebuild || effectiveRestart) {
        const r = await runRestart(effectiveRebuild);
        if (!r.ok) return;
        const msg = effectiveRebuild
          ? `Rebuilt image and restarted ${r.restarted} session${r.restarted === 1 ? '' : 's'}.`
          : `Restarted ${r.restarted} session${r.restarted === 1 ? '' : 's'}.`;
        showToast(msg);
      } else {
        showToast('Saved.');
      }
      setConfirmOpen(false);
      onClose();
    } finally { setBusy(false); }
  }

  async function doArchive(): Promise<void> {
    if (!data || archiveBusy) return;
    setArchiveBusy(true);
    try {
      const r = await call<{ ok: boolean; folder: string; archivedFolder: string }>(
        apiPath(gid, '/archive'),
        'POST',
        { confirm_folder: archiveConfirm.trim() },
      );
      if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      // Drop the archived group locally; the next sync tick would do this too
      // but doing it now keeps the UI responsive.
      const archivedId = gid;
      const remaining = groups.value.filter((g) => g.id !== archivedId);
      groups.value = remaining;
      setArchiveOpen(false);
      onClose();
      showToast(`Archived. Restore on the host with: ncl groups restore --folder ${r.data.folder}`);
      // If the archived group was current, switch to the first remaining one.
      if (groupId.value === archivedId && remaining[0]) {
        void selectGroup(remaining[0].id);
      }
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

  // Find the selected image's metadata for the "underneath the box" panel.
  const selectedImg = images?.images.find((i) => i.value === draft.image_tag) ?? null;
  const selectedImgAge = formatAge(selectedImg?.createdAt ?? null);
  const selectedImgSize = formatSize(selectedImg?.size ?? null);

  return (
    <section class={section === 'mcp' ? 'ga-mcp-tab' : undefined}>
      <div class="group-admin-toolbar">
        <p class="muted ga-folder-line">
          Folder <code>{data.folder}</code> <code class="ga-folder-id">{data.id}</code>{data.updatedAt ? ` · last updated ${new Date(data.updatedAt).toLocaleString()}` : ''}
          {data.runningSessionCount > 0 ? ` · ${data.runningSessionCount} running session${data.runningSessionCount === 1 ? '' : 's'}` : ' · no running sessions'}
        </p>
      </div>

      {section === 'models' ? (
        <>
          <Field
            label="Provider"
            info={draft.provider ? PROVIDER_INFO[draft.provider] ?? `Provider "${draft.provider}".` : undefined}
          >
            <Combobox
              value={draft.provider}
              options={(() => {
                const selectable = data.validProviders.slice();
                // If the saved provider isn't in the selectable list (e.g. legacy
                // 'mock'), keep it visible so the user can see their state and
                // still switch away to a supported value.
                if (draft.provider && !selectable.includes(draft.provider)) {
                  selectable.push(draft.provider);
                }
                return selectable.map((p) => ({
                  value: p,
                  label: p,
                  tooltip: PROVIDER_INFO[p],
                }));
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

          <Field
            label="Small model"
            info="Lighter model for background tasks like compaction and summaries (cost optimization). Used by OpenCode; other providers may use in future."
          >
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

          <Field
            label="Transcription model"
            info={'OpenRouter model used when the main model cannot accept audio directly. When set, a mic button appears in the chat composer.\nLeave blank to disable voice input.'}
          >
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

          <ModelParamsEditor
            gid={gid}
            provider={draft.provider}
            value={draftModelParams}
            busy={busy}
            onChange={setDraftModelParams}
          />
        </>
      ) : null}

      {section === 'settings' ? (
        <>
      <Field label="Name">
        <input
          type="text"
          value={draftName}
          disabled={busy}
          maxLength={100}
          onInput={(e) => setDraftName((e.target as HTMLInputElement).value)}
        />
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

function Field({
  label,
  info,
  children,
}: {
  label: string;
  info?: string;
  children: preact.ComponentChildren;
}): JSX.Element {
  return (
    <div class="settings-row group-admin-field">
      <label class="group-admin-label">
        {label}
        {info ? <InfoIcon text={info} /> : null}
      </label>
      <div class="group-admin-control">{children}</div>
    </div>
  );
}

// ── Members ───────────────────────────────────────────────────────────────

function MembersTab({ gid }: { gid: string }): JSX.Element {
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    const r = await call<{ members: MemberDto[] }>(apiPath(gid, '/members'));
    if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
    setMembers(r.data.members);
  }
  useEffect(() => { refresh(); }, [gid]);

  async function add(userId: string): Promise<void> {
    setBusy(true);
    try {
      const r = await call(apiPath(gid, '/members'), 'POST', { userId });
      if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      showToast('Member added');
      refresh();
    } finally { setBusy(false); }
  }

  async function remove(m: MemberDto): Promise<void> {
    setBusy(true);
    try {
      const r = await call(apiPath(gid, `/members/${encodeURIComponent(m.userId)}`), 'DELETE');
      if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      showToast('Member removed');
      refresh();
    } finally { setBusy(false); }
  }

  if (!members) return <p class="muted">Loading…</p>;

  return (
    <section>
      <p class="muted">
        Members can interact with this group when channel routing requires "known" senders. Admins of the group are implicit members (shown below for context).
      </p>
      {members.length === 0
        ? <p class="muted">No members yet.</p>
        : (
          <table class="settings-table">
            <thead><tr><th>Name</th><th>Identity</th><th></th></tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId}>
                  <td>
                    {m.displayName || <span class="muted">(no name)</span>}
                    {m.isAdmin ? <span class="group-admin-badge" title="Admin of this group">admin</span> : null}
                  </td>
                  <td>{m.primaryHandle ? <code>{m.primaryChannel}:{m.primaryHandle}</code> : <code class="muted">{m.userId}</code>}</td>
                  <td>
                    {m.isExplicitMember && !m.isAdmin
                      ? <button type="button" class="danger" disabled={busy} onClick={() => remove(m)}>Remove</button>
                      : <span class="muted">{m.isAdmin ? 'implicit' : ''}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <h4>Add a member</h4>
      <UserPicker
        gid={gid}
        excludeUserIds={new Set(members.map((m) => m.userId))}
        disabled={busy}
        onPick={add}
      />
    </section>
  );
}

// ── Roles (scoped admin grants on this group) ─────────────────────────────

function RolesTab({ gid }: { gid: string }): JSX.Element {
  const [admins, setAdmins] = useState<RoleDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    const r = await call<{ admins: RoleDto[] }>(apiPath(gid, '/roles'));
    if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
    setAdmins(r.data.admins);
  }
  useEffect(() => { refresh(); }, [gid]);

  async function grant(userId: string): Promise<void> {
    setBusy(true);
    try {
      const r = await call<{ ok?: boolean; alreadyGranted?: boolean }>(
        apiPath(gid, '/roles'), 'POST', { userId },
      );
      if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      showToast(r.data.alreadyGranted ? 'Already an admin' : 'Admin granted');
      refresh();
    } finally { setBusy(false); }
  }

  async function revoke(a: RoleDto): Promise<void> {
    setBusy(true);
    try {
      const r = await call(apiPath(gid, `/roles/${encodeURIComponent(a.userId)}`), 'DELETE');
      if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      showToast('Admin revoked');
      refresh();
    } finally { setBusy(false); }
  }

  if (!admins) return <p class="muted">Loading…</p>;

  return (
    <section>
      <p class="muted">
        Admins of this group can change its settings, manage members, and grant/revoke admin on this group only. Global owner and global admins are not shown here — they manage all groups system-wide.
      </p>
      {admins.length === 0
        ? <p class="muted">No scoped admins. (Global admins still have full access.)</p>
        : (
          <table class="settings-table">
            <thead><tr><th>Name</th><th>Identity</th><th></th></tr></thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.userId}>
                  <td>{a.displayName || <span class="muted">(no name)</span>}</td>
                  <td>{a.primaryHandle ? <code>{a.primaryChannel}:{a.primaryHandle}</code> : <code class="muted">{a.userId}</code>}</td>
                  <td><button type="button" class="danger" disabled={busy} onClick={() => revoke(a)}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <h4>Grant admin</h4>
      <UserPicker
        gid={gid}
        excludeUserIds={new Set(admins.map((a) => a.userId))}
        disabled={busy}
        onPick={grant}
      />
    </section>
  );
}

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

function DestinationsTab({ gid }: { gid: string }): JSX.Element {
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

// ── shared user picker ────────────────────────────────────────────────────

function UserPicker({
  gid,
  excludeUserIds,
  disabled,
  onPick,
}: {
  gid: string;
  excludeUserIds: Set<string>;
  disabled?: boolean;
  onPick: (userId: string) => Promise<void>;
}): JSX.Element {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserSearchDto[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await call<{ users: UserSearchDto[] }>(
          apiPath(gid, `/users-search?q=${encodeURIComponent(q)}`),
        );
        if (!cancelled && r.ok) setResults(r.data.users);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, gid]);

  const visible = results.filter((u) => !excludeUserIds.has(u.userId)).slice(0, 20);

  return (
    <>
      <div class="settings-row">
        <input
          type="text"
          placeholder="Search name, handle, or user id"
          value={q}
          onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setQ(e.currentTarget.value)}
          disabled={disabled}
        />
      </div>
      {searching && visible.length === 0 ? <p class="muted">Searching…</p> : null}
      {visible.length > 0 ? (
        <ul class="group-admin-search-results">
          {visible.map((u) => (
            <li key={u.userId}>
              <button
                type="button"
                class="group-admin-search-row"
                disabled={disabled}
                onClick={() => onPick(u.userId)}
              >
                <span class="group-admin-search-name">{u.displayName || u.userId}</span>
                <span class="group-admin-search-handle">
                  {u.primaryHandle ? `${u.primaryChannel}:${u.primaryHandle}` : u.kind}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {!searching && q && visible.length === 0 ? <p class="muted">No matches.</p> : null}
    </>
  );
}

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

function ModelParamsEditor({
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

// ---------------------------------------------------------------------------
// Packages / MCP / Skills editors (per-group container_configs JSON columns)
// ---------------------------------------------------------------------------

// Liberal but bounded: covers `pkg`, `pkg@1.2.3`, `@scope/pkg`, `pkg>=1`, etc.
const PACKAGE_TOKEN_RE = /^[A-Za-z0-9@._/+=<>~^!*-]+$/;
const MCP_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function PackagesSection({
  value,
  busy,
  onChange,
}: {
  value: { apt: string[]; npm: string[]; pip: string[] };
  busy: boolean;
  onChange: (next: { apt: string[]; npm: string[]; pip: string[] }) => void;
}): JSX.Element {
  return (
    <>
      <div class="group-admin-toolbar">
        <p class="group-admin-help">
          Packages baked into the container image. Changes require an image rebuild — the Apply
          dialog suggests rebuild when any list here changes. Mirrors{' '}
          <code>ncl groups config add-package / remove-package</code>.
        </p>
      </div>
      <PackageListField
        label="apt packages"
        info="Debian packages installed via apt-get in the agent image. Example: ripgrep, jq, postgresql-client."
        placeholder="apt package (e.g. ripgrep, jq, postgresql-client)"
        items={value.apt}
        disabled={busy}
        onChange={(apt) => onChange({ ...value, apt })}
      />
      <PackageListField
        label="npm packages"
        info="Node packages installed globally via pnpm/npm in the agent image. Example: typescript@5, prettier."
        placeholder="npm package (e.g. typescript@5, prettier)"
        items={value.npm}
        disabled={busy}
        onChange={(npm) => onChange({ ...value, npm })}
      />
      <PackageListField
        label="pip packages"
        info="Python packages installed via pip in the agent image. Example: requests, pandas==2.0.0."
        placeholder="pip package (e.g. requests, pandas==2.0.0)"
        items={value.pip}
        disabled={busy}
        onChange={(pip) => onChange({ ...value, pip })}
      />
    </>
  );
}

function PackageListField({
  label,
  info,
  placeholder,
  items,
  disabled,
  onChange,
}: {
  label: string;
  info: string;
  placeholder: string;
  items: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();
  const isDup = trimmed !== '' && items.includes(trimmed);
  const isInvalid = trimmed !== '' && !PACKAGE_TOKEN_RE.test(trimmed);
  const canAdd = trimmed !== '' && !isDup && !isInvalid;

  function add(): void {
    if (!canAdd) return;
    onChange([...items, trimmed]);
    setDraft('');
  }

  function remove(idx: number): void {
    onChange(items.filter((_, i) => i !== idx));
  }

  return (
    <Field label={label} info={info}>
      <div class="group-admin-stack ga-model-params">
        {items.length === 0 ? (
          <p class="group-admin-help">No packages.</p>
        ) : (
          <ul class="ga-chip-list">
            {items.map((p, i) => (
              <li key={`${p}-${i}`} class="ga-chip">
                <span class="ga-chip-label">{p}</span>
                <button
                  type="button"
                  class="ga-chip-remove"
                  aria-label={`Remove ${p}`}
                  disabled={disabled}
                  onClick={() => remove(i)}
                >
                  {'\u2715'}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div class="ga-mp-actions">
          <input
            type="text"
            class="ga-chip-input"
            placeholder={placeholder}
            value={draft}
            disabled={disabled}
            onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setDraft(e.currentTarget.value)}
            onKeyDown={(e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') { e.preventDefault(); add(); }
            }}
          />
          <button type="button" disabled={disabled || !canAdd} onClick={add}>
            + Add
          </button>
        </div>
        {isInvalid ? (
          <p class="ga-confirm-warn">"{trimmed}" has invalid characters.</p>
        ) : isDup ? (
          <p class="ga-confirm-warn">"{trimmed}" is already in the list.</p>
        ) : null}
      </div>
    </Field>
  );
}

function McpServersSection({
  value,
  busy,
  onChange,
}: {
  value: Record<string, McpServerConfigDto>;
  busy: boolean;
  onChange: (next: Record<string, McpServerConfigDto>) => void;
}): JSX.Element {
  const mobile = isMobile.value;
  const names = Object.keys(value);
  const [selectedName, setSelectedName] = useState<string | null>(() => names[0] ?? null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const trimmedNew = newName.trim();
  const newNameInvalid = trimmedNew !== '' && !MCP_NAME_RE.test(trimmedNew);
  const newNameDup = trimmedNew !== '' && trimmedNew in value;
  const canAdd = trimmedNew !== '' && !newNameInvalid && !newNameDup;
  const selectedValue = selectedName ? value[selectedName] : undefined;

  useEffect(() => {
    if (selectedName && selectedName in value) return;
    setSelectedName(names[0] ?? null);
  }, [JSON.stringify(names)]);

  useEffect(() => {
    if (!mobile) setEditorOpen(false);
  }, [mobile]);

  function addServer(): void {
    if (!canAdd) return;
    const config: McpServerConfigDto = newType === 'stdio'
      ? { type: 'stdio', command: '' }
      : { type: newType, url: '' };
    onChange({ ...value, [trimmedNew]: config });
    setSelectedName(trimmedNew);
    setNewName('');
    setAddOpen(false);
    if (mobile) setEditorOpen(true);
  }

  function removeServer(name: string): void {
    const next = { ...value };
    delete next[name];
    onChange(next);
    const nextName = Object.keys(next)[0] ?? null;
    setSelectedName(nextName);
    setEditorOpen(false);
  }

  function updateServer(name: string, patch: McpServerConfigDto): void {
    onChange({ ...value, [name]: patch });
  }

  function selectServer(name: string): void {
    setSelectedName(name);
    setAddOpen(false);
    if (mobile) setEditorOpen(true);
  }

  function beginAdd(): void {
    setNewName('');
    setNewType('stdio');
    setAddOpen(true);
  }

  const addForm = (
    <McpAddServerForm
      name={newName}
      type={newType}
      disabled={busy}
      invalid={newNameInvalid}
      duplicate={newNameDup}
      canAdd={canAdd}
      onNameChange={setNewName}
      onTypeChange={setNewType}
      onAdd={addServer}
      onCancel={() => setAddOpen(false)}
    />
  );

  const editor = selectedName && selectedValue ? (
    <McpServerEditor
      key={selectedName}
      name={selectedName}
      value={selectedValue}
      disabled={busy}
      onChange={(next) => updateServer(selectedName, next)}
      onRemove={() => removeServer(selectedName)}
    />
  ) : null;

  return (
    <div class="ga-mcp-section">
      <div class="ga-mcp-section-head">
        <p class="group-admin-help">
          MCP (Model Context Protocol) servers wired into this group's agents. Restart required to
          take effect — the SDK builds the MCP map at session start. Mirrors{' '}
          <code>ncl groups config add-mcp-server / remove-mcp-server</code>.
        </p>
        <button type="button" class="ga-mcp-add" disabled={busy} onClick={beginAdd}>
          + Add server
        </button>
      </div>

      {mobile ? (
        <McpServerList names={names} value={value} selectedName={selectedName} onSelect={selectServer} />
      ) : (
        <div class="ga-mcp-workspace">
          <McpServerList names={names} value={value} selectedName={selectedName} onSelect={selectServer} />
          <div class="ga-mcp-editor-pane">
            {addOpen ? addForm : editor ?? (
              <div class="ga-mcp-empty">
                <strong>No MCP servers configured</strong>
                <span>Add a server to expose external tools to this agent.</span>
                <button type="button" disabled={busy} onClick={beginAdd}>+ Add server</button>
              </div>
            )}
          </div>
        </div>
      )}

      {mobile && addOpen ? (
        <MobileDialog
          title="Add MCP server"
          onBack={() => setAddOpen(false)}
          backLabel="Back to MCP servers"
          onClose={() => setAddOpen(false)}
        >
          <div class="settings-body ga-mcp-mobile-editor">{addForm}</div>
        </MobileDialog>
      ) : null}

      {mobile && editorOpen && editor ? (
        <MobileDialog
          title={selectedName ?? 'MCP server'}
          onBack={() => setEditorOpen(false)}
          backLabel="Back to MCP servers"
          onClose={() => setEditorOpen(false)}
        >
          <div class="settings-body ga-mcp-mobile-editor">{editor}</div>
        </MobileDialog>
      ) : null}
    </div>
  );
}

function mcpServerType(value: McpServerConfigDto): 'stdio' | 'http' | 'sse' {
  const rawType = (value as { type?: string }).type;
  return rawType === 'http' || rawType === 'sse' ? rawType : 'stdio';
}

function mcpServerSummary(value: McpServerConfigDto): string {
  const type = mcpServerType(value);
  if (type === 'stdio') {
    const stdio = value as McpStdioServerDto;
    return [stdio.command, ...(stdio.args ?? [])].filter(Boolean).join(' ') || 'Command required';
  }
  return (value as McpHttpServerDto).url || 'URL required';
}

function mcpServerIssue(value: McpServerConfigDto): string | null {
  const type = mcpServerType(value);
  if (type === 'stdio' && !(value as McpStdioServerDto).command.trim()) return 'Command required';
  if (type !== 'stdio') {
    const url = (value as McpHttpServerDto).url.trim();
    if (!url) return 'URL required';
    if (!/^https?:\/\//.test(url)) return 'Invalid URL';
  }
  if (value.timeout != null && (value.timeout < 1000 || value.timeout > 600000)) return 'Invalid timeout';
  return null;
}

function McpServerList({
  names,
  value,
  selectedName,
  onSelect,
}: {
  names: string[];
  value: Record<string, McpServerConfigDto>;
  selectedName: string | null;
  onSelect: (name: string) => void;
}): JSX.Element {
  return (
    <nav class="ga-mcp-list" aria-label="Configured MCP servers">
      {names.length === 0 ? (
        <p class="ga-mcp-list-empty">No servers yet.</p>
      ) : names.map((name) => {
        const config = value[name]!;
        const issue = mcpServerIssue(config);
        return (
          <button
            type="button"
            key={name}
            class={`ga-mcp-list-item${selectedName === name ? ' active' : ''}`}
            aria-current={selectedName === name ? 'true' : undefined}
            onClick={() => onSelect(name)}
          >
            <span class="ga-mcp-list-name">{name}</span>
            <span class="ga-mcp-transport-badge">{mcpServerType(config)}</span>
            <span class="ga-mcp-list-summary">{mcpServerSummary(config)}</span>
            {issue ? <span class="ga-mcp-list-issue">{issue}</span> : null}
            <span class="ga-mcp-list-chevron" aria-hidden="true">{'\u203A'}</span>
          </button>
        );
      })}
    </nav>
  );
}

function McpAddServerForm({
  name,
  type,
  disabled,
  invalid,
  duplicate,
  canAdd,
  onNameChange,
  onTypeChange,
  onAdd,
  onCancel,
}: {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  disabled: boolean;
  invalid: boolean;
  duplicate: boolean;
  canAdd: boolean;
  onNameChange: (name: string) => void;
  onTypeChange: (type: 'stdio' | 'http' | 'sse') => void;
  onAdd: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div class="ga-mcp-add-form">
      <div>
        <h3>Add MCP server</h3>
        <p class="group-admin-help">The name is how the agent identifies this server's tools.</p>
      </div>
      <label class="ga-mcp-row">
        <span class="ga-mcp-row-label">Server name</span>
        <input
          type="text"
          class="ga-mcp-input"
          placeholder="e.g. context7 or home_assistant"
          value={name}
          disabled={disabled}
          autoFocus
          onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => onNameChange(e.currentTarget.value)}
          onKeyDown={(e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') { e.preventDefault(); onAdd(); }
          }}
        />
      </label>
      {invalid ? <p class="ga-confirm-warn">Start with a letter or _, then use letters, digits, _, ., or -.</p> : null}
      {duplicate ? <p class="ga-confirm-warn">A server named "{name.trim()}" already exists.</p> : null}
      <McpTransportControl value={type} disabled={disabled} onChange={onTypeChange} />
      <div class="ga-mcp-form-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" class="primary" disabled={disabled || !canAdd} onClick={onAdd}>Add server</button>
      </div>
    </div>
  );
}

function McpServerEditor({
  name,
  value,
  disabled,
  onChange,
  onRemove,
}: {
  name: string;
  value: McpServerConfigDto;
  disabled: boolean;
  onChange: (next: McpServerConfigDto) => void;
  onRemove: () => void;
}): JSX.Element {
  const type = mcpServerType(value);
  const [removeOpen, setRemoveOpen] = useState(false);

  function setType(next: 'stdio' | 'http' | 'sse'): void {
    if (next === 'stdio') {
      const stdio = value as McpStdioServerDto;
      onChange({
        type: 'stdio',
        command: stdio.command ?? '',
        ...(stdio.args ? { args: stdio.args } : {}),
        ...(stdio.env ? { env: stdio.env } : {}),
        ...(value.instructions ? { instructions: value.instructions } : {}),
        ...(value.timeout ? { timeout: value.timeout } : {}),
      });
    } else {
      const http = value as McpHttpServerDto;
      onChange({
        type: next,
        url: http.url ?? '',
        ...(http.headers ? { headers: http.headers } : {}),
        ...(value.instructions ? { instructions: value.instructions } : {}),
        ...(value.timeout ? { timeout: value.timeout } : {}),
      });
    }
  }

  return (
    <div class="ga-mcp-editor">
      <div class="ga-mcp-editor-head">
        <div>
          <h3>{name}</h3>
          <p class="group-admin-help">Configure how the agent connects to this server.</p>
        </div>
        <McpTransportControl value={type} disabled={disabled} onChange={setType} />
      </div>

      {type === 'stdio' ? (
        <McpStdioFields
          value={value as McpStdioServerDto}
          disabled={disabled}
          onChange={onChange}
        />
      ) : (
        <McpHttpFields
          value={value as McpHttpServerDto}
          disabled={disabled}
          onChange={onChange}
        />
      )}

      <details class="ga-mcp-advanced">
        <summary>Advanced settings</summary>
        <div class="ga-mcp-advanced-body">
          {type === 'stdio' ? (
            <McpKeyValueEditor
              label="Environment variables"
              value={(value as McpStdioServerDto).env ?? {}}
              disabled={disabled}
              keyPlaceholder="VARIABLE_NAME"
              valuePlaceholder="value"
              onChange={(env) => {
                const next = { ...value } as McpStdioServerDto;
                if (Object.keys(env).length) next.env = env;
                else delete next.env;
                onChange(next);
              }}
            />
          ) : (
            <McpKeyValueEditor
              label="Request headers"
              value={(value as McpHttpServerDto).headers ?? {}}
              disabled={disabled}
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer …"
              onChange={(headers) => {
                const next = { ...value } as McpHttpServerDto;
                if (Object.keys(headers).length) next.headers = headers;
                else delete next.headers;
                onChange(next);
              }}
            />
          )}
          <label class="ga-mcp-row">
            <span class="ga-mcp-row-label">Instructions</span>
            <textarea
              class="ga-mcp-textarea"
              placeholder="When should the agent use these tools?"
              rows={3}
              value={value.instructions ?? ''}
              disabled={disabled}
              onInput={(e: JSX.TargetedEvent<HTMLTextAreaElement>) => {
                const instructions = e.currentTarget.value;
                onChange({ ...value, instructions: instructions || undefined } as McpServerConfigDto);
              }}
            />
          </label>
          <label class="ga-mcp-row ga-mcp-timeout">
            <span class="ga-mcp-row-label">Timeout (ms)</span>
            <input
              type="number"
              class="ga-mcp-input"
              placeholder="60000"
              min={1000}
              max={600000}
              step={1000}
              value={value.timeout ?? ''}
              disabled={disabled}
              onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => {
                const raw = e.currentTarget.value.trim();
                const timeout = raw === '' ? undefined : Number(raw);
                onChange({
                  ...value,
                  timeout: timeout != null && Number.isFinite(timeout) ? timeout : undefined,
                } as McpServerConfigDto);
              }}
            />
          </label>
        </div>
      </details>

      <div class="ga-mcp-editor-danger">
        <button type="button" class="danger" disabled={disabled} onClick={() => setRemoveOpen(true)}>Remove server…</button>
      </div>

      {removeOpen ? (
        <MobileDialog
          title="Remove MCP server?"
          role="alertdialog"
          maxWidth="420px"
          onClose={() => setRemoveOpen(false)}
        >
          <div class="settings-body">
            <p class="group-admin-help">
              Remove <code>{name}</code> from this agent's MCP configuration?
            </p>
          </div>
          <MobileDialogFooter>
            <button type="button" onClick={() => setRemoveOpen(false)}>Cancel</button>
            <button type="button" class="danger" onClick={onRemove}>Remove server</button>
          </MobileDialogFooter>
        </MobileDialog>
      ) : null}
    </div>
  );
}

function McpTransportControl({
  value,
  disabled,
  onChange,
}: {
  value: 'stdio' | 'http' | 'sse';
  disabled: boolean;
  onChange: (type: 'stdio' | 'http' | 'sse') => void;
}): JSX.Element {
  return (
    <div class="ga-mcp-transport" role="group" aria-label="Transport">
      {(['stdio', 'http', 'sse'] as const).map((type) => (
        <button
          type="button"
          key={type}
          class={value === type ? 'active' : ''}
          aria-pressed={value === type}
          disabled={disabled}
          onClick={() => onChange(type)}
        >
          {type.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function McpStdioFields({
  value,
  disabled,
  onChange,
}: {
  value: McpStdioServerDto;
  disabled: boolean;
  onChange: (next: McpStdioServerDto) => void;
}): JSX.Element {
  return (
    <>
      <label class="ga-mcp-row">
        <span class="ga-mcp-row-label">command</span>
        <input
          type="text"
          class="ga-mcp-input"
          placeholder="e.g. npx, uvx, /usr/local/bin/my-tool"
          value={value.command ?? ''}
          disabled={disabled}
          onInput={(e: JSX.TargetedEvent<HTMLInputElement>) =>
            onChange({ ...value, command: e.currentTarget.value })
          }
        />
        {!value.command.trim() ? <span class="ga-mcp-field-error">Command is required.</span> : null}
      </label>
      <McpArgumentsEditor
        value={value.args ?? []}
        disabled={disabled}
        onChange={(args) => {
          const next = { ...value };
          if (args.length) next.args = args;
          else delete next.args;
          onChange(next);
        }}
      />
    </>
  );
}

function McpHttpFields({
  value,
  disabled,
  onChange,
}: {
  value: McpHttpServerDto;
  disabled: boolean;
  onChange: (next: McpHttpServerDto) => void;
}): JSX.Element {
  const urlInvalid = value.url && !/^https?:\/\//.test(value.url);

  return (
    <label class="ga-mcp-row">
      <span class="ga-mcp-row-label">URL</span>
      <input
        type="url"
        class={`ga-mcp-input${urlInvalid ? ' ga-mp-key-unknown' : ''}`}
        placeholder="https://example.com/mcp"
        value={value.url ?? ''}
        disabled={disabled}
        onInput={(e: JSX.TargetedEvent<HTMLInputElement>) =>
          onChange({ ...value, url: e.currentTarget.value })
        }
      />
      {!value.url.trim() ? <span class="ga-mcp-field-error">URL is required.</span> : null}
      {urlInvalid ? <span class="ga-mcp-field-error">URL must start with http:// or https://.</span> : null}
    </label>
  );
}

function McpArgumentsEditor({
  value,
  disabled,
  onChange,
}: {
  value: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  function add(): void {
    if (!draft) return;
    onChange([...value, draft]);
    setDraft('');
  }
  return (
    <div class="ga-mcp-collection">
      <span class="ga-mcp-row-label">Arguments</span>
      {value.map((argument, index) => (
        <div class="ga-mcp-collection-row" key={`${index}-${argument}`}>
          <input
            type="text"
            class="ga-mcp-input"
            aria-label={`Argument ${index + 1}`}
            value={argument}
            disabled={disabled}
            onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => {
              const next = [...value];
              next[index] = e.currentTarget.value;
              onChange(next);
            }}
          />
          <button type="button" class="icon-btn" aria-label={`Remove argument ${index + 1}`} disabled={disabled} onClick={() => onChange(value.filter((_, i) => i !== index))}>{'\u2715'}</button>
        </div>
      ))}
      <div class="ga-mcp-collection-row">
        <input
          type="text"
          class="ga-mcp-input"
          aria-label="New argument"
          placeholder="Add an argument"
          value={draft}
          disabled={disabled}
          onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setDraft(e.currentTarget.value)}
          onKeyDown={(e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') { e.preventDefault(); add(); }
          }}
        />
        <button type="button" disabled={disabled || !draft} onClick={add}>Add</button>
      </div>
    </div>
  );
}

function McpKeyValueEditor({
  label,
  value,
  disabled,
  keyPlaceholder,
  valuePlaceholder,
  onChange,
}: {
  label: string;
  value: Record<string, string>;
  disabled: boolean;
  keyPlaceholder: string;
  valuePlaceholder: string;
  onChange: (next: Record<string, string>) => void;
}): JSX.Element {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const trimmedKey = newKey.trim();
  const duplicate = trimmedKey !== '' && trimmedKey in value;
  function add(): void {
    if (!trimmedKey || duplicate) return;
    onChange({ ...value, [trimmedKey]: newValue });
    setNewKey('');
    setNewValue('');
  }
  return (
    <div class="ga-mcp-collection">
      <span class="ga-mcp-row-label">{label}</span>
      {Object.entries(value).map(([key, entryValue]) => (
        <div class="ga-mcp-kv-row" key={key}>
          <code title={key}>{key}</code>
          <input
            type="text"
            class="ga-mcp-input"
            aria-label={`${key} value`}
            value={entryValue}
            disabled={disabled}
            onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => onChange({ ...value, [key]: e.currentTarget.value })}
          />
          <button
            type="button"
            class="icon-btn"
            aria-label={`Remove ${key}`}
            disabled={disabled}
            onClick={() => {
              const next = { ...value };
              delete next[key];
              onChange(next);
            }}
          >
            {'\u2715'}
          </button>
        </div>
      ))}
      <div class="ga-mcp-kv-row ga-mcp-kv-new">
        <input type="text" class="ga-mcp-input" aria-label={`New ${label} key`} placeholder={keyPlaceholder} value={newKey} disabled={disabled} onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setNewKey(e.currentTarget.value)} />
        <input
          type="text"
          class="ga-mcp-input"
          aria-label={`New ${label} value`}
          placeholder={valuePlaceholder}
          value={newValue}
          disabled={disabled}
          onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setNewValue(e.currentTarget.value)}
          onKeyDown={(e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') { e.preventDefault(); add(); }
          }}
        />
        <button type="button" disabled={disabled || !trimmedKey || duplicate} onClick={add}>Add</button>
      </div>
      {duplicate ? <span class="ga-mcp-field-error">That key already exists.</span> : null}
    </div>
  );
}

function SkillsSection({
  value,
  busy,
  onChange,
}: {
  value: string[] | 'all';
  busy: boolean;
  onChange: (next: string[] | 'all') => void;
}): JSX.Element {
  const isAll = value === 'all';
  const list = isAll ? [] : value;
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();
  const isInvalid = trimmed !== '' && !SKILL_SLUG_RE.test(trimmed);
  const isDup = trimmed !== '' && list.includes(trimmed);
  const canAdd = !isAll && trimmed !== '' && !isInvalid && !isDup;

  function add(): void {
    if (!canAdd) return;
    onChange([...list, trimmed]);
    setDraft('');
  }
  function remove(idx: number): void {
    onChange(list.filter((_, i) => i !== idx));
  }

  return (
    <>
      <div class="group-admin-toolbar">
        <p class="group-admin-help">
          Container skills mounted into every session in this group. Restart required to take
          effect — skill mounts are computed at container spawn. Use "all" to mount every
          available container skill, or pick specific slugs from <code>container/skills/</code>.
        </p>
      </div>

      <Field label="Selection">
        <div class="group-admin-stack">
          <label class="group-admin-check">
            <input
              type="radio"
              name="skills-mode"
              checked={isAll}
              disabled={busy}
              onChange={() => onChange('all')}
            />
            <span>All available skills</span>
          </label>
          <label class="group-admin-check">
            <input
              type="radio"
              name="skills-mode"
              checked={!isAll}
              disabled={busy}
              onChange={() => onChange([])}
            />
            <span>Specific skills only</span>
          </label>
        </div>
      </Field>

      {!isAll ? (
        <Field label="Skills" info="Slug per skill (lowercase a–z, 0–9, hyphen). Must match a folder under container/skills/ or a group-local skill.">
          <div class="group-admin-stack ga-model-params">
            {list.length === 0 ? (
              <p class="group-admin-help">No skills selected.</p>
            ) : (
              <ul class="ga-chip-list">
                {list.map((s, i) => (
                  <li key={`${s}-${i}`} class="ga-chip">
                    <span class="ga-chip-label">{s}</span>
                    <button
                      type="button"
                      class="ga-chip-remove"
                      aria-label={`Remove ${s}`}
                      disabled={busy}
                      onClick={() => remove(i)}
                    >
                      {'\u2715'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div class="ga-mp-actions">
              <input
                type="text"
                class="ga-chip-input"
                placeholder="skill slug (e.g. welcome, agent-browser)"
                value={draft}
                disabled={busy}
                onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setDraft(e.currentTarget.value)}
                onKeyDown={(e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter') { e.preventDefault(); add(); }
                }}
              />
              <button type="button" disabled={busy || !canAdd} onClick={add}>
                + Add
              </button>
            </div>
            {isInvalid ? (
              <p class="ga-confirm-warn">"{trimmed}" must be lowercase a–z, 0–9, hyphen.</p>
            ) : isDup ? (
              <p class="ga-confirm-warn">"{trimmed}" is already in the list.</p>
            ) : null}
          </div>
        </Field>
      ) : null}
    </>
  );
}
