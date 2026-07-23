/**
 * Per-group admin API mounted under /ui/chat/api/groups/:gid/admin/*.
 *
 * Access gate: authenticated chat session + `hasAdminPrivilege(userId, gid)`
 * — covers owner, global admin, and scoped admin of the group.
 *
 * Mutations call DB helpers directly (no approval routing). This matches the
 * CLI host path; the CLI's `access: 'approval'` tag exists to gate agent-
 * initiated calls (see src/cli/dispatch.ts), not host operators. Every
 * mutation funnels through `recordAdminAction()` so Phase 2 can swap the
 * audit seam for a real DB table without touching handlers.
 */
import http from 'http';
import { URL } from 'url';

import { CONTAINER_IMAGE } from '../../../config.js';
import { readEnvFile } from '../../../env.js';
import { buildAgentGroupImage, isContainerRunning, runMcpProbeContainer } from '../../../container-runner.js';
import { restartAgentGroupContainers } from '../../../container-restart.js';
import { getDb } from '../../../db/connection.js';
import { getAgentGroup, getAgentGroupBySiteSlug, updateAgentGroup } from '../../../db/agent-groups.js';
import { getMessagingGroup } from '../../../db/messaging-groups.js';
import {
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../../../db/container-configs.js';
import { log } from '../../../log.js';
import { archiveAgentGroup } from '../../../modules/archive/archive-group.js';
import {
  addMember,
  getMembers,
  hasMembershipRow,
  removeMember,
} from '../../../modules/permissions/db/agent-group-members.js';
import { getIdentitiesForUser } from '../../../modules/permissions/db/identities.js';
import { getAllUsers, getUser } from '../../../modules/permissions/db/users.js';
import {
  getAdminsOfAgentGroup,
  grantRole,
  hasAdminPrivilege,
  isAdminOfAgentGroup,
  isGlobalAdmin,
  isOwner,
} from '../../../modules/permissions/db/user-roles.js';
import { listAccessibleAgentGroups } from '../../../modules/permissions/access.js';
import {
  getDestinations,
  deleteDestination,
  getDestinationByTarget,
} from '../../../modules/agent-to-agent/db/agent-destinations.js';
import { authorizeAgentLink, authorizeAgentLinkRemoval } from '../../../modules/agent-to-agent/authorize.js';
import { applyAgentLink, AgentLinkError, validateLocalName } from '../../../modules/agent-to-agent/apply-link.js';
import { writeDestinations } from '../../../modules/agent-to-agent/write-destinations.js';
import { getSessionsByAgentGroup } from '../../../db/sessions.js';
import { requestApproval } from '../../../modules/approvals/primitive.js';
import type { Session } from '../../../types.js';
import type { AgentGroup, ContainerConfigRow } from '../../../types.js';
import { authenticate } from '../auth.js';
import type { McpServerConfig } from '../../../container-config.js';
import { providerProvidesAgentSurfaces } from '../../../providers/provider-container-registry.js';
import { SELECTABLE_AGENT_PROVIDERS, VALID_AGENT_PROVIDERS } from './agent-providers.js';
import { recordAdminAction } from './audit.js';
import { listImages } from './image-catalog.js';
import { bareIdForResponse, dbValueFromBareId, getModelDetails, listModelsForProvider } from './models-catalog.js';
import { deriveVoiceMode } from './voice-mode.js';
import { allocateSiteSlug, isValidSlug, pagesBaseDomain, pagesEnabled, siteFqdn, siteUrl } from '../pages/site.js';

// ── allowed scalar config fields (mirrors ncl groups config update) ───────

const SCALAR_FIELDS = [
  'provider',
  'model',
  'small_model',
  'effort',
  'image_tag',
  'assistant_name',
  'max_messages_per_prompt',
  'cli_scope',
  'transcription_model',
] as const;

// Provider list is parsed once at startup from the agent-runner's
// registration barrel (container/agent-runner/src/providers/index.ts) so the
// admin UI and server validation stay in sync with whatever providers the
// runtime actually loads — see ./agent-providers.ts. `mock` is accepted
// server-side (existing groups may have it set via the CLI) but is excluded
// from the picker the client shows.
const VALID_PROVIDERS = VALID_AGENT_PROVIDERS;
const SELECTABLE_PROVIDERS = SELECTABLE_AGENT_PROVIDERS;
const VALID_CLI_SCOPES = ['disabled', 'group', 'global'] as const;
const VALID_VOICE_MODES = ['off', 'transcribe', 'audio'] as const;

// ── dispatcher ────────────────────────────────────────────────────────────

interface MatchedRoute {
  method: string;
  gid: string;
  rest: string;
}

function matchRoute(method: string, pathname: string): MatchedRoute | null {
  // /api/groups/:gid/admin/<rest>
  const m = /^\/api\/groups\/([^/]+)\/admin(\/.*)?$/.exec(pathname);
  if (!m) return null;
  return {
    method,
    gid: decodeURIComponent(m[1]!),
    rest: m[2] || '/',
  };
}

/**
 * Try to handle a chat-admin request. Returns true if the URL matched a
 * group-admin route (response was written), false otherwise so the caller
 * can fall through to the next dispatcher.
 */
export async function handleGroupAdminRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const route = matchRoute(req.method || 'GET', pathname);
  if (!route) return false;

  const session = authenticate(req);
  if (!session) {
    writeJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  // Existence + access gate together: a group the user can't admin should
  // return 403 whether or not it exists (don't leak existence).
  const group = getAgentGroup(route.gid);
  if (!group || !hasAdminPrivilege(session.userId, route.gid)) {
    writeJson(res, 403, { error: 'forbidden' });
    return true;
  }

  try {
    await dispatch(req, res, session.userId, route, group.id);
  } catch (err) {
    if (err instanceof BadRequest) {
      writeJson(res, 400, { error: err.message });
      return true;
    }
    log.error('group-admin handler threw', { gid: route.gid, rest: route.rest, err });
    writeJson(res, 500, { error: 'internal_error' });
  }
  return true;
}

class BadRequest extends Error {}

async function dispatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actorUserId: string,
  route: MatchedRoute,
  gid: string,
): Promise<void> {
  const { method, rest } = route;

  if (rest === '/settings' && method === 'GET') return handleGetSettings(res, gid, actorUserId);
  if (rest === '/settings' && method === 'PATCH') return handlePatchSettings(req, res, actorUserId, gid);
  if (rest === '/model-params' && method === 'PATCH') return handlePatchModelParams(req, res, actorUserId, gid);
  if (rest === '/packages' && method === 'PATCH') return handlePatchPackages(req, res, actorUserId, gid);
  if (rest === '/mcp-servers' && method === 'PATCH') return handlePatchMcpServers(req, res, actorUserId, gid);
  if (rest === '/mcp-servers/test' && method === 'POST') return handleTestMcpServer(req, res, actorUserId, gid);
  if (rest === '/skills' && method === 'PATCH') return handlePatchSkills(req, res, actorUserId, gid);
  if (rest === '/restart' && method === 'POST') return handleRestart(req, res, actorUserId, gid);
  if (rest === '/archive' && method === 'POST') return handleArchive(req, res, actorUserId, gid);

  if (rest === '/members' && method === 'GET') return handleGetMembers(res, gid);
  if (rest === '/members' && method === 'POST') return handleAddMember(req, res, actorUserId, gid);
  {
    const m = /^\/members\/([^/]+)$/.exec(rest);
    if (m && method === 'DELETE') return handleRemoveMember(res, actorUserId, gid, decodeURIComponent(m[1]!));
  }

  if (rest === '/roles' && method === 'GET') return handleGetRoles(res, gid);
  if (rest === '/roles' && method === 'POST') return handleGrantRole(req, res, actorUserId, gid);
  {
    const m = /^\/roles\/([^/]+)$/.exec(rest);
    if (m && method === 'DELETE') return handleRevokeRole(res, actorUserId, gid, decodeURIComponent(m[1]!));
  }

  if (rest === '/users-search' && method === 'GET') return handleUsersSearch(req, res);

  if (rest === '/destinations' && method === 'GET') return handleListDestinations(res, actorUserId, gid);
  if (rest === '/destinations' && method === 'POST') return handleAddDestination(req, res, actorUserId, gid);
  if (rest === '/destinations/candidates' && method === 'GET')
    return handleListDestinationCandidates(res, actorUserId, gid);
  {
    const m = /^\/destinations\/([^/]+)\/reverse$/.exec(rest);
    if (m && method === 'DELETE')
      return handleRemoveReverseDestination(res, actorUserId, gid, decodeURIComponent(m[1]!));
  }
  {
    const m = /^\/destinations\/([^/]+)$/.exec(rest);
    if (m && method === 'DELETE') return handleRemoveDestination(res, actorUserId, gid, decodeURIComponent(m[1]!));
  }

  if (rest === '/models' && method === 'GET') return handleListModels(req, res);
  if (rest === '/images' && method === 'GET') return handleListImages(res);

  writeJson(res, 404, { error: 'not_found' });
}

// ── settings ──────────────────────────────────────────────────────────────

interface SettingsResponse {
  id: string;
  name: string;
  folder: string;
  createdAt: string;
  updatedAt: string | null;
  config: Pick<
    ContainerConfigRow,
    | 'provider'
    | 'model'
    | 'small_model'
    | 'effort'
    | 'image_tag'
    | 'assistant_name'
    | 'max_messages_per_prompt'
    | 'cli_scope'
    | 'voice_mode'
    | 'transcription_model'
  >;
  /** Freeform provider knobs (e.g. `{ max_tokens: 8192 }`). Edited via PATCH /model-params. */
  modelParams: Record<string, unknown>;
  /** Installed packages — image rebuild required to take effect. */
  packages: { apt: string[]; npm: string[]; pip: string[] };
  /** Per-group MCP servers — restart required to take effect. */
  mcpServers: Record<string, McpServerConfig>;
  /** Container skill selection. `'all'` mounts every available container skill. */
  skills: string[] | 'all';
  /** Resolved defaults for nullable config fields (shown as placeholders). */
  defaults: {
    provider: string | null;
    model: string | null;
    image_tag: string | null;
    transcription_model: string | null;
  };
  validProviders: readonly string[];
  validCliScopes: readonly string[];
  validVoiceModes: readonly string[];
  /** Per-group static website. `available` reflects PAGES_BASE_DOMAIN being set. */
  site: {
    available: boolean;
    baseDomain: string | null;
    slug: string | null;
    fqdn: string | null;
    url: string | null;
    enabled: boolean;
  };
  runningSessionCount: number;
  /** Tooltip / detail / age for the currently-selected model and image. */
  selectedModelDetail: { label: string; detail?: string; tooltip?: string } | null;
  selectedImageDetail: { label: string; createdAt: string | null; size: number | null } | null;
  /** True iff the acting admin is owner or global admin (controls UI gating
   * of privilege-escalating options like cli_scope=global). */
  actorIsElevated: boolean;
  /**
   * True iff the effective provider owns its own agent-facing surfaces
   * (instructions, skills, project doc) — see `providesAgentSurfaces` on the
   * provider capability seam. When true the host does NOT compose CLAUDE.md /
   * mount container skills / seed CLAUDE.local.md, so the Skills tab and
   * assistant-name field are no-ops; the client annotates them accordingly.
   */
  providesAgentSurfaces: boolean;
}

async function handleGetSettings(res: http.ServerResponse, gid: string, actorUserId: string): Promise<void> {
  const group = getAgentGroup(gid)!; // already validated by caller
  const cfg = getContainerConfig(gid);
  if (!cfg) {
    writeJson(res, 500, { error: 'container_config_missing' });
    return;
  }
  const runningSessionCount = getSessionsByAgentGroup(gid).filter(
    (session) => session.status === 'active' && isContainerRunning(session.id),
  ).length;

  // Translate DB model value → bare id for the wire. Client never sees the
  // OPENCODE_PROVIDER prefix.
  const bareModelId = bareIdForResponse(cfg.provider, cfg.model);

  let selectedModelDetail: SettingsResponse['selectedModelDetail'] = null;
  if (cfg.provider && bareModelId) {
    const m = await getModelDetails(cfg.provider, bareModelId);
    if (m) selectedModelDetail = { label: m.label, detail: m.detail, tooltip: m.tooltip };
  }

  let selectedImageDetail: SettingsResponse['selectedImageDetail'] = null;
  if (cfg.image_tag) {
    const match = listImages().find((i) => i.value === cfg.image_tag);
    if (match) {
      selectedImageDetail = { label: match.label, createdAt: match.createdAt, size: match.size };
    }
  }

  // Resolve effective defaults for fields the UI shows as placeholders.
  const envDefaults = readEnvFile(['DEFAULT_PROVIDER', 'DEFAULT_MODEL', 'DEFAULT_TRANSCRIPTION_MODEL']);
  const defaultProvider = envDefaults.DEFAULT_PROVIDER || 'claude';
  const defaultModel = envDefaults.DEFAULT_MODEL || null;
  const defaultTranscriptionModel = envDefaults.DEFAULT_TRANSCRIPTION_MODEL || null;
  const defaultImage = CONTAINER_IMAGE || null;

  const body: SettingsResponse = {
    id: group.id,
    name: group.name,
    folder: group.folder,
    createdAt: group.created_at,
    updatedAt: cfg.updated_at ?? null,
    config: {
      provider: cfg.provider,
      model: bareModelId,
      small_model: bareIdForResponse(cfg.provider, cfg.small_model),
      effort: cfg.effort,
      image_tag: cfg.image_tag,
      assistant_name: cfg.assistant_name,
      max_messages_per_prompt: cfg.max_messages_per_prompt,
      cli_scope: cfg.cli_scope,
      voice_mode: cfg.voice_mode,
      transcription_model: cfg.transcription_model,
    },
    modelParams: parseModelParams(cfg.model_params),
    packages: {
      apt: parseStringArray(cfg.packages_apt),
      npm: parseStringArray(cfg.packages_npm),
      pip: parseStringArray(cfg.packages_pip),
    },
    mcpServers: parseMcpServers(cfg.mcp_servers),
    skills: parseSkills(cfg.skills),
    defaults: {
      provider: defaultProvider,
      model: defaultModel ? bareIdForResponse(defaultProvider, defaultModel) : null,
      image_tag: defaultImage,
      transcription_model: defaultTranscriptionModel,
    },
    validProviders: SELECTABLE_PROVIDERS,
    validCliScopes: VALID_CLI_SCOPES,
    validVoiceModes: VALID_VOICE_MODES,
    site: {
      available: pagesEnabled(),
      baseDomain: pagesEnabled() ? pagesBaseDomain() : null,
      slug: group.site_slug ?? null,
      fqdn: siteFqdn(group),
      url: siteUrl(group),
      enabled: !!group.site_enabled,
    },
    runningSessionCount,
    selectedModelDetail,
    selectedImageDetail,
    actorIsElevated: isOwner(actorUserId) || isGlobalAdmin(actorUserId),
    providesAgentSurfaces: providerProvidesAgentSurfaces(cfg.provider ?? defaultProvider),
  };
  writeJson(res, 200, body);
}

async function handlePatchSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actorUserId: string,
  gid: string,
): Promise<void> {
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  // Distinguish "key absent" (skip) from "key present with null/empty"
  // (clear to null). The DB columns for provider/model/effort/image_tag/
  // assistant_name/max_messages_per_prompt/cli_scope all allow NULL.
  const updates: Partial<
    Pick<
      ContainerConfigRow,
      | 'provider'
      | 'model'
      | 'small_model'
      | 'effort'
      | 'image_tag'
      | 'assistant_name'
      | 'max_messages_per_prompt'
      | 'cli_scope'
      | 'voice_mode'
      | 'transcription_model'
    >
  > = {};
  const isElevated = isOwner(actorUserId) || isGlobalAdmin(actorUserId);

  // Group name lives in agent_groups, not container_configs.
  let nameUpdate: string | undefined;
  if ('name' in body) {
    const raw = body['name'];
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) throw new BadRequest('name cannot be empty');
    if (trimmed.length > 100) throw new BadRequest('name must be 100 characters or fewer');
    nameUpdate = trimmed;
  }

  // Static website settings live in agent_groups (host-side routing), not
  // container_configs. The single user-facing control is `site_enabled`;
  // `site_slug` is an elevated override of the auto-derived subdomain.
  const siteUpdates: Partial<Pick<AgentGroup, 'site_slug' | 'site_enabled'>> = {};
  if ('site_slug' in body || 'site_enabled' in body) {
    if (!pagesEnabled()) {
      throw new BadRequest('website feature is not configured (PAGES_BASE_DOMAIN unset)');
    }
    const group = getAgentGroup(gid)!; // validated by caller
    if ('site_slug' in body) {
      if (!isElevated) throw new BadRequest('only owner or global admin may change the website subdomain');
      const raw = body['site_slug'];
      if (raw == null || raw === '') {
        siteUpdates.site_slug = null;
      } else {
        const v = String(raw).trim().toLowerCase();
        if (!isValidSlug(v)) throw new BadRequest('subdomain must be a valid DNS label (a-z, 0-9, hyphen)');
        const taken = getAgentGroupBySiteSlug(v);
        if (taken && taken.id !== gid) throw new BadRequest('that subdomain is already in use');
        siteUpdates.site_slug = v;
      }
    }
    if ('site_enabled' in body) {
      const raw = body['site_enabled'];
      const enabled = raw === true || raw === 'true' || raw === 1;
      siteUpdates.site_enabled = enabled ? 1 : 0;
      if (enabled) {
        const effectiveSlug = 'site_slug' in siteUpdates ? siteUpdates.site_slug : group.site_slug;
        if (!effectiveSlug) {
          const derived = allocateSiteSlug(group);
          if (!derived) {
            throw new BadRequest('could not derive a subdomain from the group name; set one explicitly');
          }
          siteUpdates.site_slug = derived;
        }
      }
    }
  }

  for (const key of SCALAR_FIELDS) {
    if (!(key in body)) continue;
    const raw = body[key];
    const isCleared = raw == null || raw === '';
    if (key === 'provider') {
      if (isCleared) {
        updates.provider = null;
        continue;
      }
      const v = String(raw);
      if (!VALID_PROVIDERS.includes(v)) {
        throw new BadRequest(`provider must be one of: ${VALID_PROVIDERS.join(', ')}`);
      }
      updates.provider = v;
    } else if (key === 'cli_scope') {
      if (isCleared) {
        // cli_scope is NOT NULL in container_configs (TEXT DEFAULT 'group')
        // — disallow clearing it.
        throw new BadRequest('cli_scope cannot be empty; pick one of: ' + VALID_CLI_SCOPES.join(', '));
      }
      const v = String(raw);
      if (!VALID_CLI_SCOPES.includes(v as (typeof VALID_CLI_SCOPES)[number])) {
        throw new BadRequest(`cli_scope must be one of: ${VALID_CLI_SCOPES.join(', ')}`);
      }
      // Setting cli_scope=global grants the agent unrestricted `ncl` access
      // — system-wide control. Reserve to owner / global admin so a scoped
      // admin can't escalate via their own group's agent.
      if (v === 'global' && !isElevated) {
        throw new BadRequest('only owner or global admin may set cli_scope to "global"');
      }
      updates.cli_scope = v;
    } else if (key === 'max_messages_per_prompt') {
      if (isCleared) {
        updates.max_messages_per_prompt = null;
        continue;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1 || n > 1000) {
        throw new BadRequest('max_messages_per_prompt must be a number between 1 and 1000');
      }
      updates.max_messages_per_prompt = Math.floor(n);
    } else {
      // model, effort, image_tag, assistant_name — nullable strings
      updates[key] = isCleared ? null : String(raw);
    }
  }

  // Translate the bare model id back to the DB wire value once provider is
  // known. If provider is also being patched, use the new value so the
  // prefix matches the user's intent.
  if ('model' in updates) {
    const existing = getContainerConfig(gid);
    const effectiveProvider = updates.provider ?? existing?.provider ?? null;
    updates.model = dbValueFromBareId(effectiveProvider, updates.model ?? null);
    const bareModel = bareIdForResponse(effectiveProvider, updates.model ?? null);
    if (effectiveProvider && bareModel) {
      const exact = await getModelDetails(effectiveProvider, bareModel);
      if (!exact) {
        const catalog = await listModelsForProvider(effectiveProvider);
        const q = bareModel.trim().toLowerCase();
        const partialMatch = catalog.models.some(
          (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
        );
        if (partialMatch) {
          throw new BadRequest('model must be selected from the catalog, not a partial search term');
        }
      }
    }
  }

  // Same prefix translation for small_model.
  if ('small_model' in updates) {
    const existing = getContainerConfig(gid);
    const effectiveProvider = updates.provider ?? existing?.provider ?? null;
    updates.small_model = dbValueFromBareId(effectiveProvider, updates.small_model ?? null);
  }

  if ('transcription_model' in updates || 'provider' in updates || 'model' in updates) {
    const existing = getContainerConfig(gid);
    const envDefaults = readEnvFile(['DEFAULT_PROVIDER', 'DEFAULT_MODEL', 'DEFAULT_TRANSCRIPTION_MODEL']);
    const effectiveProvider = updates.provider ?? existing?.provider ?? envDefaults.DEFAULT_PROVIDER ?? 'claude';
    // DEFAULT_MODEL in .env is the DB wire value — use as-is.
    const effectiveModel = 'model' in updates ? updates.model : (existing?.model ?? envDefaults.DEFAULT_MODEL ?? null);
    // Fall back to DEFAULT_TRANSCRIPTION_MODEL so clearing the per-group
    // override re-enables voice (mirrors voice-mode.ts:deriveVoiceModeForConfig
    // and the env fallback already used by streamTranscribe).
    const effectiveTranscriptionModel =
      'transcription_model' in updates
        ? (updates.transcription_model ?? envDefaults.DEFAULT_TRANSCRIPTION_MODEL ?? null)
        : (existing?.transcription_model ?? envDefaults.DEFAULT_TRANSCRIPTION_MODEL ?? null);
    updates.voice_mode = await deriveVoiceMode(effectiveProvider, effectiveModel ?? null, effectiveTranscriptionModel);
  }

  if (Object.keys(updates).length === 0 && nameUpdate === undefined && Object.keys(siteUpdates).length === 0) {
    throw new BadRequest('no editable fields supplied');
  }

  const agentGroupUpdates: Partial<Pick<AgentGroup, 'name' | 'site_slug' | 'site_enabled'>> = { ...siteUpdates };
  if (nameUpdate !== undefined) agentGroupUpdates.name = nameUpdate;
  if (Object.keys(agentGroupUpdates).length > 0) {
    updateAgentGroup(gid, agentGroupUpdates);
  }
  if (Object.keys(updates).length > 0) {
    updateContainerConfigScalars(gid, updates);
  }
  recordAdminAction({
    actorUserId,
    action: 'group_config_update',
    targetKind: 'agent_group',
    targetId: gid,
    payload: { ...agentGroupUpdates, ...updates } as Record<string, unknown>,
  });
  await handleGetSettings(res, gid, actorUserId);
}

/**
 * Parse the model_params JSON column for the wire. Tolerant — a corrupt
 * value surfaces as {} rather than crashing the settings GET. Mirrors the
 * runner-side defaults so the UI shows the same view providers consume.
 */
function parseModelParams(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return {};
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  } catch {
    /* fall through */
  }
  return [];
}

function parseSkills(raw: string | null | undefined): string[] | 'all' {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (v === 'all') return 'all';
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  } catch {
    /* fall through */
  }
  return [];
}

function parseMcpServers(raw: string | null | undefined): Record<string, McpServerConfig> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, McpServerConfig>;
  } catch {
    /* fall through */
  }
  return {};
}

const MODEL_PARAM_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;
const MAX_MODEL_PARAM_KEYS = 64;

/** True if v is a JSON primitive (number, string, boolean, null). */
function isPrimitive(v: unknown): boolean {
  return v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean';
}

/**
 * PATCH /model-params — full replacement of the model_params bag.
 * Body: `{ params: Record<string, unknown> }`. Each value must be a
 * primitive or an array of primitives; nested objects are rejected so the
 * stored shape stays predictable for providers reading it.
 */
async function handlePatchModelParams(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actorUserId: string,
  gid: string,
): Promise<void> {
  const body = (await readJsonBody(req)) as { params?: unknown };
  if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
    throw new BadRequest('params must be an object');
  }
  const input = body.params as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length > MAX_MODEL_PARAM_KEYS) {
    throw new BadRequest(`too many keys (max ${MAX_MODEL_PARAM_KEYS})`);
  }
  const cleaned: Record<string, unknown> = {};
  for (const k of keys) {
    if (!MODEL_PARAM_KEY_RE.test(k)) {
      throw new BadRequest(`invalid key "${k}" — must match /^[a-zA-Z_][a-zA-Z0-9_.]*$/`);
    }
    const v = input[k];
    if (isPrimitive(v)) {
      cleaned[k] = v;
    } else if (Array.isArray(v) && v.every(isPrimitive)) {
      cleaned[k] = v;
    } else {
      throw new BadRequest(`value for "${k}" must be a primitive or array of primitives`);
    }
  }

  const cfg = getContainerConfig(gid);
  if (!cfg) {
    writeJson(res, 500, { error: 'container_config_missing' });
    return;
  }
  updateContainerConfigJson(gid, 'model_params', cleaned);
  recordAdminAction({
    actorUserId,
    action: 'group_model_params_update',
    targetKind: 'agent_group',
    targetId: gid,
    payload: { params: cleaned },
  });
  writeJson(res, 200, { modelParams: cleaned });
}

// ── packages / mcp servers / skills ───────────────────────────────────────

const MAX_PACKAGES_PER_KIND = 200;
const MAX_PACKAGE_LEN = 200;
const PACKAGE_TOKEN_RE = /^[A-Za-z0-9@._/+=<>~^!*-]+$/;

const MAX_MCP_SERVERS = 32;
const MCP_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const MAX_MCP_NAME_LEN = 64;
const MCP_MIN_TIMEOUT_MS = 1_000;
const MCP_MAX_TIMEOUT_MS = 600_000;

const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_SKILL_SLUG_LEN = 64;
const MAX_SKILLS = 64;

function cleanPackageList(label: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new BadRequest(`${label} must be an array of strings`);
  if (raw.length > MAX_PACKAGES_PER_KIND) {
    throw new BadRequest(`${label} too long (max ${MAX_PACKAGES_PER_KIND})`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') throw new BadRequest(`${label} entries must be strings`);
    const v = item.trim();
    if (v === '') continue;
    if (v.length > MAX_PACKAGE_LEN) {
      throw new BadRequest(`${label}: "${v.slice(0, 32)}…" exceeds ${MAX_PACKAGE_LEN} chars`);
    }
    if (!PACKAGE_TOKEN_RE.test(v)) {
      throw new BadRequest(`${label}: "${v}" has invalid characters`);
    }
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * PATCH /packages — full replacement of each provided package list.
 * Body: `{ apt?: string[]; npm?: string[]; pip?: string[] }`. Lists omitted
 * from the body are left unchanged. Image rebuild required to take effect
 * — the UI confirm dialog defaults rebuild=on when packages change.
 */
async function handlePatchPackages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actorUserId: string,
  gid: string,
): Promise<void> {
  const body = (await readJsonBody(req)) as { apt?: unknown; npm?: unknown; pip?: unknown };
  const cfg = getContainerConfig(gid);
  if (!cfg) {
    writeJson(res, 500, { error: 'container_config_missing' });
    return;
  }

  const written: Partial<Record<'apt' | 'npm' | 'pip', string[]>> = {};
  if ('apt' in body) written.apt = cleanPackageList('apt', body.apt);
  if ('npm' in body) written.npm = cleanPackageList('npm', body.npm);
  if ('pip' in body) written.pip = cleanPackageList('pip', body.pip);

  if (Object.keys(written).length === 0) {
    throw new BadRequest('provide at least one of: apt, npm, pip');
  }

  if (written.apt) updateContainerConfigJson(gid, 'packages_apt', written.apt);
  if (written.npm) updateContainerConfigJson(gid, 'packages_npm', written.npm);
  if (written.pip) updateContainerConfigJson(gid, 'packages_pip', written.pip);

  recordAdminAction({
    actorUserId,
    action: 'group_packages_update',
    targetKind: 'agent_group',
    targetId: gid,
    payload: written as Record<string, unknown>,
  });

  const fresh = getContainerConfig(gid)!;
  writeJson(res, 200, {
    packages: {
      apt: parseStringArray(fresh.packages_apt),
      npm: parseStringArray(fresh.packages_npm),
      pip: parseStringArray(fresh.packages_pip),
    },
  });
}

function cleanMcpServers(raw: unknown): Record<string, McpServerConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequest('servers must be an object keyed by server name');
  }
  const input = raw as Record<string, unknown>;
  const names = Object.keys(input);
  if (names.length > MAX_MCP_SERVERS) {
    throw new BadRequest(`too many MCP servers (max ${MAX_MCP_SERVERS})`);
  }
  const out: Record<string, McpServerConfig> = {};
  for (const name of names) {
    if (name.length === 0 || name.length > MAX_MCP_NAME_LEN) {
      throw new BadRequest(`MCP server name "${name}" must be 1–${MAX_MCP_NAME_LEN} chars`);
    }
    if (!MCP_NAME_RE.test(name)) {
      throw new BadRequest(`MCP server name "${name}" must match ${MCP_NAME_RE.source}`);
    }
    const cfg = input[name];
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      throw new BadRequest(`MCP server "${name}" must be an object`);
    }
    out[name] = cleanOneMcpServer(name, cfg as Record<string, unknown>);
  }
  return out;
}

function cleanOneMcpServer(name: string, cfg: Record<string, unknown>): McpServerConfig {
  const typeRaw = cfg.type;
  const type = typeof typeRaw === 'string' ? typeRaw : 'stdio';
  if (type !== 'stdio' && type !== 'http' && type !== 'sse') {
    throw new BadRequest(`MCP server "${name}": type must be stdio, http, or sse`);
  }
  const instructions = cfg.instructions == null ? undefined : String(cfg.instructions);
  if (instructions !== undefined && instructions.length > 2000) {
    throw new BadRequest(`MCP server "${name}": instructions too long (max 2000)`);
  }
  const timeout = cleanMcpTimeout(name, cfg.timeout);

  if (type === 'http' || type === 'sse') {
    if (typeof cfg.url !== 'string' || cfg.url.trim() === '') {
      throw new BadRequest(`MCP server "${name}": url is required for ${type} transport`);
    }
    const url = cfg.url.trim();
    if (!/^https?:\/\//.test(url)) {
      throw new BadRequest(`MCP server "${name}": url must start with http:// or https://`);
    }
    const headers = cleanStringStringMap(`MCP server "${name}" headers`, cfg.headers);
    const out: McpServerConfig = { type, url };
    if (Object.keys(headers).length > 0) out.headers = headers;
    if (instructions !== undefined) out.instructions = instructions;
    if (timeout !== undefined) out.timeout = timeout;
    return out;
  }

  // stdio
  if (typeof cfg.command !== 'string' || cfg.command.trim() === '') {
    throw new BadRequest(`MCP server "${name}": command is required for stdio transport`);
  }
  const command = cfg.command.trim();
  const args = cleanStringArray(`MCP server "${name}" args`, cfg.args);
  const env = cleanStringStringMap(`MCP server "${name}" env`, cfg.env);
  const out: McpServerConfig = { command };
  if (args.length > 0) out.args = args;
  if (Object.keys(env).length > 0) out.env = env;
  if (instructions !== undefined) out.instructions = instructions;
  if (timeout !== undefined) out.timeout = timeout;
  return out;
}

function cleanMcpTimeout(name: string, raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new BadRequest(`MCP server "${name}": timeout must be an integer number of milliseconds`);
  }
  if (n < MCP_MIN_TIMEOUT_MS || n > MCP_MAX_TIMEOUT_MS) {
    throw new BadRequest(
      `MCP server "${name}": timeout must be between ${MCP_MIN_TIMEOUT_MS} and ${MCP_MAX_TIMEOUT_MS} ms`,
    );
  }
  return n;
}

function cleanStringArray(label: string, raw: unknown): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new BadRequest(`${label} must be an array of strings`);
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') throw new BadRequest(`${label} entries must be strings`);
    out.push(v);
  }
  return out;
}

function cleanStringStringMap(label: string, raw: unknown): Record<string, string> {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequest(`${label} must be an object of string values`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new BadRequest(`${label}: value for "${k}" must be a string`);
    out[k] = v;
  }
  return out;
}

/**
 * PATCH /mcp-servers — full replacement of the mcp_servers map.
 * Body: `{ servers: Record<string, McpServerConfig> }`. Restart required to
 * take effect — Claude Agent SDK builds the MCP server map at session start.
 */
async function handlePatchMcpServers(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actorUserId: string,
  gid: string,
): Promise<void> {
  const body = (await readJsonBody(req)) as { servers?: unknown };
  if (!('servers' in body)) throw new BadRequest('servers is required');
  const cleaned = cleanMcpServers(body.servers);

  const cfg = getContainerConfig(gid);
  if (!cfg) {
    writeJson(res, 500, { error: 'container_config_missing' });
    return;
  }
  updateContainerConfigJson(gid, 'mcp_servers', cleaned);
  recordAdminAction({
    actorUserId,
    action: 'group_mcp_servers_update',
    targetKind: 'agent_group',
    targetId: gid,
    payload: { servers: cleaned } as Record<string, unknown>,
  });
  writeJson(res, 200, { mcpServers: cleaned });
}

/** POST /mcp-servers/test — validate one draft server in a disposable container. */
async function handleTestMcpServer(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actorUserId: string,
  gid: string,
): Promise<void> {
  const body = (await readJsonBody(req)) as { name?: unknown; server?: unknown };
  if (typeof body.name !== 'string' || !MCP_NAME_RE.test(body.name) || body.name.length > MAX_MCP_NAME_LEN) {
    throw new BadRequest('valid server name is required');
  }
  if (!body.server || typeof body.server !== 'object' || Array.isArray(body.server)) {
    throw new BadRequest('server must be an object');
  }

  const cleaned = cleanOneMcpServer(body.name, body.server as Record<string, unknown>);
  const result = await runMcpProbeContainer(gid, cleaned);
  recordAdminAction({
    actorUserId,
    action: 'group_mcp_server_test',
    targetKind: 'agent_group',
    targetId: gid,
    payload: {
      name: body.name,
      ok: result.ok,
      phase: result.phase,
      latencyMs: result.latencyMs,
      toolCount: result.tools?.length ?? 0,
    },
  });
  writeJson(res, 200, result);
}

/**
 * PATCH /skills — full replacement of the skills selection.
 * Body: `{ skills: string[] | 'all' }`. Restart required to take effect —
 * mounts are computed at container spawn.
 */
async function handlePatchSkills(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actorUserId: string,
  gid: string,
): Promise<void> {
  const body = (await readJsonBody(req)) as { skills?: unknown };
  if (!('skills' in body)) throw new BadRequest('skills is required');
  const raw = body.skills;
  let cleaned: string[] | 'all';
  if (raw === 'all') {
    cleaned = 'all';
  } else if (Array.isArray(raw)) {
    if (raw.length > MAX_SKILLS) throw new BadRequest(`too many skills (max ${MAX_SKILLS})`);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') throw new BadRequest('skills entries must be strings');
      const v = item.trim();
      if (v === '') continue;
      if (v.length > MAX_SKILL_SLUG_LEN) {
        throw new BadRequest(`skill "${v.slice(0, 32)}…" exceeds ${MAX_SKILL_SLUG_LEN} chars`);
      }
      if (!SKILL_SLUG_RE.test(v)) {
        throw new BadRequest(`skill "${v}" must be a slug: lowercase a-z, 0-9, hyphen`);
      }
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    cleaned = out;
  } else {
    throw new BadRequest('skills must be "all" or an array of slugs');
  }

  const cfg = getContainerConfig(gid);
  if (!cfg) {
    writeJson(res, 500, { error: 'container_config_missing' });
    return;
  }
  updateContainerConfigJson(gid, 'skills', cleaned);
  recordAdminAction({
    actorUserId,
    action: 'group_skills_update',
    targetKind: 'agent_group',
    targetId: gid,
    payload: { skills: cleaned } as Record<string, unknown>,
  });
  writeJson(res, 200, { skills: cleaned });
}

async function handleRestart(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actorUserId: string,
  gid: string,
): Promise<void> {
  const body = (await readJsonBody(req)) as { rebuild?: unknown; message?: unknown };
  const rebuild = body.rebuild === true;
  const message = typeof body.message === 'string' && body.message.length > 0 ? body.message : undefined;

  if (rebuild) {
    await buildAgentGroupImage(gid);
  }
  const count = restartAgentGroupContainers(gid, 'restarted via chat-ui admin', message);
  recordAdminAction({
    actorUserId,
    action: 'group_restart',
    targetKind: 'agent_group',
    targetId: gid,
    payload: { rebuild, restarted: count },
  });
  writeJson(res, 200, { restarted: count, rebuilt: rebuild });
}

async function handleArchive(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actorUserId: string,
  gid: string,
): Promise<void> {
  const group = getAgentGroup(gid)!;
  const body = (await readJsonBody(req)) as { confirm_folder?: unknown };
  // Defense in depth: client UI requires the operator to type the folder
  // name to confirm. Server re-checks so a CSRF / scripted call can't
  // archive without that ack.
  if (typeof body.confirm_folder !== 'string' || body.confirm_folder !== group.folder) {
    throw new BadRequest('confirm_folder must equal the group folder name');
  }

  const actorUser = getUser(actorUserId);
  const result = archiveAgentGroup(gid, {
    user_id: actorUserId,
    display_name: actorUser?.display_name ?? null,
  });
  recordAdminAction({
    actorUserId,
    action: 'group_archive',
    targetKind: 'agent_group',
    targetId: gid,
    payload: {
      folder: result.folder,
      archivedFolder: result.archivedFolder,
      archivedSessionsDir: result.archivedSessionsDir,
      cascade: result.cascade as unknown as Record<string, unknown>,
    },
  });
  writeJson(res, 200, {
    ok: true,
    id: result.id,
    folder: result.folder,
    archivedFolder: result.archivedFolder,
  });
}

// ── members ───────────────────────────────────────────────────────────────

interface MemberDto {
  userId: string;
  displayName: string | null;
  primaryHandle: string | null;
  primaryChannel: string | null;
  isExplicitMember: boolean;
  isAdmin: boolean;
}

function userDtoBase(userId: string): {
  displayName: string | null;
  primaryChannel: string | null;
  primaryHandle: string | null;
} {
  const user = getUser(userId);
  const identities = getIdentitiesForUser(userId);
  const primary = identities.find((i) => i.primary_for_channel === 1) ?? identities[0] ?? null;
  return {
    displayName: user?.display_name?.trim() || null,
    primaryChannel: primary?.channel ?? null,
    primaryHandle: primary?.handle ?? null,
  };
}

function handleGetMembers(res: http.ServerResponse, gid: string): void {
  const rows = getMembers(gid);
  const seen = new Set<string>();
  const out: MemberDto[] = [];
  for (const r of rows) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    const base = userDtoBase(r.user_id);
    out.push({
      userId: r.user_id,
      ...base,
      isExplicitMember: true,
      isAdmin: isAdminOfAgentGroup(r.user_id, gid),
    });
  }
  // Surface admins of the group even without an explicit membership row —
  // they're implicit members per the permissions module.
  for (const a of getAdminsOfAgentGroup(gid)) {
    if (seen.has(a.user_id)) continue;
    seen.add(a.user_id);
    const base = userDtoBase(a.user_id);
    out.push({
      userId: a.user_id,
      ...base,
      isExplicitMember: false,
      isAdmin: true,
    });
  }
  writeJson(res, 200, { members: out });
}

async function handleAddMember(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actorUserId: string,
  gid: string,
): Promise<void> {
  const body = (await readJsonBody(req)) as { userId?: unknown };
  const userId = typeof body.userId === 'string' ? body.userId : '';
  if (!userId) throw new BadRequest('userId is required');
  if (!getUser(userId)) throw new BadRequest('user not found');
  if (isAdminOfAgentGroup(userId, gid)) {
    throw new BadRequest('user is an admin of this group — already an implicit member');
  }
  addMember({ user_id: userId, agent_group_id: gid, added_by: actorUserId, added_at: new Date().toISOString() });
  recordAdminAction({
    actorUserId,
    action: 'group_member_add',
    targetKind: 'agent_group',
    targetId: gid,
    payload: { userId },
  });
  writeJson(res, 200, { ok: true });
}

function handleRemoveMember(res: http.ServerResponse, actorUserId: string, gid: string, userId: string): void {
  if (isAdminOfAgentGroup(userId, gid)) {
    writeJson(res, 400, { error: 'user is an admin of this group — revoke the admin role first' });
    return;
  }
  if (!hasMembershipRow(userId, gid)) {
    writeJson(res, 404, { error: 'membership not found' });
    return;
  }
  removeMember(userId, gid);
  recordAdminAction({
    actorUserId,
    action: 'group_member_remove',
    targetKind: 'agent_group',
    targetId: gid,
    payload: { userId },
  });
  writeJson(res, 200, { ok: true });
}

// ── scoped roles (admin grants on THIS group only) ────────────────────────

interface RoleDto {
  userId: string;
  displayName: string | null;
  primaryHandle: string | null;
  primaryChannel: string | null;
  grantedAt: string;
  grantedBy: string | null;
}

function handleGetRoles(res: http.ServerResponse, gid: string): void {
  const rows = getAdminsOfAgentGroup(gid);
  const out: RoleDto[] = rows.map((r) => ({
    userId: r.user_id,
    ...userDtoBase(r.user_id),
    grantedAt: r.granted_at,
    grantedBy: r.granted_by,
  }));
  writeJson(res, 200, { admins: out });
}

async function handleGrantRole(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actorUserId: string,
  gid: string,
): Promise<void> {
  const body = (await readJsonBody(req)) as { userId?: unknown };
  const userId = typeof body.userId === 'string' ? body.userId : '';
  if (!userId) throw new BadRequest('userId is required');
  if (!getUser(userId)) throw new BadRequest('user not found');
  if (isAdminOfAgentGroup(userId, gid)) {
    writeJson(res, 200, { ok: true, alreadyGranted: true });
    return;
  }
  grantRole({
    user_id: userId,
    role: 'admin',
    agent_group_id: gid,
    granted_by: actorUserId,
    granted_at: new Date().toISOString(),
  });
  recordAdminAction({
    actorUserId,
    action: 'group_role_grant',
    targetKind: 'agent_group',
    targetId: gid,
    payload: { userId, role: 'admin' },
  });
  writeJson(res, 200, { ok: true });
}

function handleRevokeRole(res: http.ServerResponse, actorUserId: string, gid: string, userId: string): void {
  if (!isAdminOfAgentGroup(userId, gid)) {
    writeJson(res, 404, { error: 'role not found' });
    return;
  }
  // Use the same SQL the permissions module exposes; one statement, scoped.
  getDb()
    .prepare('DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id = ?')
    .run(userId, 'admin', gid);
  recordAdminAction({
    actorUserId,
    action: 'group_role_revoke',
    targetKind: 'agent_group',
    targetId: gid,
    payload: { userId, role: 'admin' },
  });
  writeJson(res, 200, { ok: true });
}

// ── user search (for the add-member / grant-role picker) ──────────────────

interface UserSearchDto {
  userId: string;
  displayName: string | null;
  kind: string;
  primaryHandle: string | null;
  primaryChannel: string | null;
}

function handleUsersSearch(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const qRaw = (url.searchParams.get('q') || '').trim().toLowerCase();
  const limit = 50;
  const users = getAllUsers();
  const matches: UserSearchDto[] = [];
  for (const u of users) {
    const base = userDtoBase(u.id);
    if (qRaw) {
      const haystacks = [
        u.id.toLowerCase(),
        (base.displayName || '').toLowerCase(),
        (base.primaryHandle || '').toLowerCase(),
      ];
      if (!haystacks.some((h) => h.includes(qRaw))) continue;
    }
    matches.push({
      userId: u.id,
      displayName: base.displayName,
      kind: u.kind,
      primaryHandle: base.primaryHandle,
      primaryChannel: base.primaryChannel,
    });
    if (matches.length >= limit) break;
  }
  writeJson(res, 200, { users: matches });
}

// ── model catalog (for the model dropdown) ────────────────────────────────

async function handleListModels(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const provider = (url.searchParams.get('provider') || '').trim();
  if (!provider) throw new BadRequest('provider query parameter is required');
  // Allow both agent providers and 'openrouter' (used by the transcription model selector).
  if (!VALID_PROVIDERS.includes(provider) && provider !== 'openrouter') {
    throw new BadRequest(`provider must be one of: ${VALID_PROVIDERS.join(', ')}, openrouter`);
  }
  const inputModality = (url.searchParams.get('inputModality') || '').trim() || undefined;
  const outputModality = (url.searchParams.get('outputModality') || '').trim() || undefined;
  const result = await listModelsForProvider(provider, { inputModality, outputModality });
  writeJson(res, 200, result);
}

// ── image catalog (for the image_tag dropdown) ────────────────────────────

function handleListImages(res: http.ServerResponse): void {
  writeJson(res, 200, { images: listImages() });
}

// ── destinations (agent-to-agent links) ────────────────────────────────────

interface DestinationDto {
  localName: string;
  targetType: 'agent' | 'channel';
  targetId: string;
  targetName: string | null;
  /** For channels only: human descriptors so the UI can render `discord:123…`. */
  channelType: string | null;
  platformId: string | null;
  /**
   * For agent destinations only: information about a destination in the
   * target group that points back at this one. `null` when no reverse row
   * exists. Independent: the target may have created it on its own.
   */
  reverseLink: {
    localName: string;
    viewerCanRemove: boolean;
  } | null;
  createdAt: string;
  createdBy: string | null;
}

function handleListDestinations(res: http.ServerResponse, actorUserId: string, gid: string): void {
  const rows = getDestinations(gid);
  const out: DestinationDto[] = rows.map((r) => {
    let targetName: string | null = null;
    let channelType: string | null = null;
    let platformId: string | null = null;
    let reverseLink: DestinationDto['reverseLink'] = null;
    if (r.target_type === 'agent') {
      targetName = getAgentGroup(r.target_id)?.name ?? null;
      const reverse = getDestinationByTarget(r.target_id, 'agent', gid);
      if (reverse) {
        reverseLink = {
          localName: reverse.local_name,
          viewerCanRemove: hasAdminPrivilege(actorUserId, r.target_id),
        };
      }
    } else {
      const mg = getMessagingGroup(r.target_id);
      targetName = mg?.name ?? null;
      channelType = mg?.channel_type ?? null;
      platformId = mg?.platform_id ?? null;
    }
    return {
      localName: r.local_name,
      targetType: r.target_type,
      targetId: r.target_id,
      targetName,
      channelType,
      platformId,
      reverseLink,
      createdAt: r.created_at,
      createdBy: r.created_by,
    };
  });
  writeJson(res, 200, { destinations: out });
}

/**
 * Lists agent groups the actor could link this group to. Excludes self and
 * groups already linked. Includes admin-on-target hint so the UI can show
 * "auto-apply" vs. "needs approval".
 */
function handleListDestinationCandidates(res: http.ServerResponse, actorUserId: string, gid: string): void {
  const accessible = listAccessibleAgentGroups(actorUserId);
  const existing = new Set(
    getDestinations(gid)
      .filter((d) => d.target_type === 'agent')
      .map((d) => d.target_id),
  );
  const out = accessible
    .filter((g) => g.id !== gid && !existing.has(g.id))
    .map((g) => ({
      id: g.id,
      name: g.name,
      folder: g.folder,
      adminOnTarget: hasAdminPrivilege(actorUserId, g.id),
    }));
  writeJson(res, 200, { candidates: out });
}

async function handleAddDestination(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actorUserId: string,
  gid: string,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    targetAgentGroupId?: unknown;
    localName?: unknown;
    alsoReverse?: unknown;
    reverseLocalName?: unknown;
  };
  const targetGid = typeof body.targetAgentGroupId === 'string' ? body.targetAgentGroupId : '';
  const localNameRaw = typeof body.localName === 'string' ? body.localName : '';
  const alsoReverse = body.alsoReverse === true;
  const reverseLocalNameRaw =
    typeof body.reverseLocalName === 'string' && body.reverseLocalName.length > 0 ? body.reverseLocalName : undefined;
  if (!targetGid) throw new BadRequest('targetAgentGroupId is required');
  if (!localNameRaw) throw new BadRequest('localName is required');

  let localName: string;
  try {
    localName = validateLocalName(localNameRaw);
  } catch (err) {
    throw new BadRequest((err as Error).message);
  }

  const decision = authorizeAgentLink(actorUserId, gid, targetGid);
  if (decision.mode === 'denied') {
    if (decision.reason === 'not_admin_on_source') {
      writeJson(res, 403, { error: 'forbidden' });
      return;
    }
    writeJson(res, 400, { error: decision.reason });
    return;
  }

  if (decision.mode === 'auto') {
    try {
      const result = await applyAgentLink({
        sourceAgentGroupId: gid,
        targetAgentGroupId: targetGid,
        localName,
        createdBy: actorUserId,
        alsoReverse,
        reverseLocalName: reverseLocalNameRaw,
      });
      recordAdminAction({
        actorUserId,
        action: 'destination_add',
        targetKind: 'agent_group',
        targetId: gid,
        payload: { targetAgentGroupId: targetGid, localName, alsoReverse },
      });
      writeJson(res, 200, {
        status: 'applied',
        forward: result.forward,
        reverse: result.reverse,
      });
    } catch (err) {
      if (err instanceof AgentLinkError) throw new BadRequest(err.message);
      throw err;
    }
    return;
  }

  // needs-approval — synthesize a session shim so requestApproval can notify
  // back to the requester's *agent-group context* (source). Wake/notify
  // targets the most-recent active session of the source group, if any.
  const sourceSessions = getSessionsByAgentGroup(gid);
  const session: Session | undefined = sourceSessions[0];
  if (!session) {
    writeJson(res, 400, {
      error: 'no_active_session',
      detail: 'Source group has no active session to receive the approval result.',
    });
    return;
  }
  await requestApproval({
    session,
    agentName: getAgentGroup(gid)?.name ?? gid,
    action: 'add_agent_destination',
    approverAgentGroupId: targetGid,
    payload: {
      sourceAgentGroupId: gid,
      targetAgentGroupId: targetGid,
      localName,
      alsoReverse,
      reverseLocalName: reverseLocalNameRaw ?? null,
    },
    title: `Agent link request from "${getAgentGroup(gid)?.name ?? gid}"`,
    question: `Allow "${getAgentGroup(gid)?.name ?? gid}" to add "${getAgentGroup(targetGid)?.name ?? targetGid}" as destination "${localName}"?`,
  });
  recordAdminAction({
    actorUserId,
    action: 'destination_request',
    targetKind: 'agent_group',
    targetId: gid,
    payload: { targetAgentGroupId: targetGid, localName, alsoReverse },
  });
  writeJson(res, 202, { status: 'pending_approval' });
}

function handleRemoveDestination(res: http.ServerResponse, actorUserId: string, gid: string, localName: string): void {
  const decision = authorizeAgentLinkRemoval(actorUserId, gid);
  if (!decision.allowed) {
    writeJson(res, 403, { error: decision.reason });
    return;
  }
  const destinations = getDestinations(gid);
  const existing = destinations.find((d) => d.local_name === localName);
  if (!existing) {
    writeJson(res, 404, { error: 'destination not found' });
    return;
  }
  deleteDestination(gid, localName);
  // Re-project to active sessions so the agent stops seeing it.
  for (const s of getSessionsByAgentGroup(gid)) {
    try {
      writeDestinations(gid, s.id);
    } catch {
      // best-effort projection; container may be down
    }
  }
  recordAdminAction({
    actorUserId,
    action: 'destination_remove',
    targetKind: 'agent_group',
    targetId: gid,
    payload: { localName, targetType: existing.target_type, targetId: existing.target_id },
  });
  writeJson(res, 200, { ok: true });
}

/**
 * Remove the reverse-direction destination — the row in the *target* group's
 * table that points back at this one. Requires admin privilege on the
 * target group, not on this one. We re-project to the target's sessions so
 * its agent stops seeing the destination on the next poll.
 */
function handleRemoveReverseDestination(
  res: http.ServerResponse,
  actorUserId: string,
  gid: string,
  localName: string,
): void {
  const forward = getDestinations(gid).find((d) => d.local_name === localName && d.target_type === 'agent');
  if (!forward) {
    writeJson(res, 404, { error: 'destination not found' });
    return;
  }
  const targetGid = forward.target_id;
  const reverse = getDestinationByTarget(targetGid, 'agent', gid);
  if (!reverse) {
    writeJson(res, 404, { error: 'no reverse link' });
    return;
  }
  if (!hasAdminPrivilege(actorUserId, targetGid)) {
    writeJson(res, 403, { error: 'not admin of target group' });
    return;
  }
  deleteDestination(targetGid, reverse.local_name);
  for (const s of getSessionsByAgentGroup(targetGid)) {
    try {
      writeDestinations(targetGid, s.id);
    } catch {
      // best-effort projection; container may be down
    }
  }
  recordAdminAction({
    actorUserId,
    action: 'destination_remove_reverse',
    targetKind: 'agent_group',
    targetId: targetGid,
    payload: { sourceAgentGroupId: gid, reverseLocalName: reverse.local_name },
  });
  writeJson(res, 200, { ok: true });
}

// ── tiny local helpers (kept private to avoid widening routes.ts surface) ─

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage, max = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > max) throw new BadRequest('body_too_large');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('invalid_json');
  }
}
