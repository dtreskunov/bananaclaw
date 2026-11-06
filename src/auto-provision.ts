/**
 * Filesystem-driven agent-group provisioning.
 *
 * Today this serves one channel — Resend email — where each recipient
 * alias (`leet@bot.example.com`, `support@bot.example.com`, …) gets its
 * own agent group, lazily registered on the first allowed inbound email.
 * The operator opts an alias in by creating its folder:
 *
 *   groups/<alias>/
 *     CLAUDE.local.md       (required — its presence enables the alias)
 *     allowed-senders.txt   (required — one sender regex per line)
 *     bot.json              (optional — { name, cli_scope })
 *
 * Missing folder, missing CLAUDE.local.md, or a sender that fails every
 * regex in allowed-senders.txt → message is dropped (no approval card,
 * no log spam).
 *
 * The provisioner is idempotent: re-calling for an already-registered
 * alias returns the existing rows. Concurrent inbound emails to a fresh
 * alias race on the DB's UNIQUE(folder) / UNIQUE(channel_type,platform_id)
 * constraints — we catch and retry-as-lookup so the loser of the race
 * still ends up routed correctly.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
  getMessagingGroupWithAgentCount,
} from './db/messaging-groups.js';
import { initGroupFilesystem } from './group-init.js';
import { log } from './log.js';
import type { AgentGroup, MessagingGroup } from './types.js';

const GROUPS_DIR = path.resolve(process.cwd(), 'groups');

export type CliScope = 'disabled' | 'group' | 'global';

export interface BotConfig {
  name?: string;
  cli_scope?: CliScope;
}

/** Folder shape for an email-bot alias. */
export interface BotFolder {
  folder: string; // e.g. "leet@bot.example.com"
  absPath: string; // absolute path to the folder
  persona: string; // CLAUDE.local.md contents
  allowedSenderRegexes: RegExp[];
  config: BotConfig;
}

/**
 * Read a bot folder. Returns null when the folder is missing or doesn't
 * have a CLAUDE.local.md (the gate that enables the alias). Returns the
 * folder with an empty `allowedSenderRegexes` array when allowed-senders.txt
 * is missing — callers MUST treat empty as "deny all", matching the
 * fail-safe policy.
 */
export function readBotFolder(folder: string): BotFolder | null {
  const absPath = path.join(GROUPS_DIR, folder);
  const personaFile = path.join(absPath, 'CLAUDE.local.md');
  if (!fs.existsSync(personaFile)) return null;

  const persona = fs.readFileSync(personaFile, 'utf8');

  const allowedFile = path.join(absPath, 'allowed-senders.txt');
  const allowedSenderRegexes: RegExp[] = [];
  if (fs.existsSync(allowedFile)) {
    const lines = fs.readFileSync(allowedFile, 'utf8').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      try {
        allowedSenderRegexes.push(new RegExp(line, 'i'));
      } catch (err) {
        log.warn('Invalid regex in allowed-senders.txt', { folder, line, err });
      }
    }
  }

  let config: BotConfig = {};
  const configFile = path.join(absPath, 'bot.json');
  if (fs.existsSync(configFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (parsed && typeof parsed === 'object') config = parsed as BotConfig;
    } catch (err) {
      log.warn('Invalid bot.json — ignoring', { folder, err });
    }
  }

  return { folder, absPath, persona, allowedSenderRegexes, config };
}

export function isSenderAllowed(bot: BotFolder, senderEmail: string): boolean {
  if (bot.allowedSenderRegexes.length === 0) return false; // fail-safe
  return bot.allowedSenderRegexes.some((re) => re.test(senderEmail));
}

/**
 * Write the three scaffold files for a new email-bot alias. Refuses to
 * overwrite an existing folder — callers should check first or treat the
 * thrown error as "alias is already taken".
 *
 * The alias must be a well-formed email and may only contain characters
 * filesystems and Docker container names tolerate after the host's
 * `@` → `_at_` sanitization in container-runner.
 */
export interface ScaffoldInput {
  alias: string;
  persona: string;
  name?: string;
  cliScope?: CliScope;
  allowedSenders: string; // raw contents of allowed-senders.txt
}

export interface ScaffoldResult {
  folder: string;
  absPath: string;
}

const ALIAS_RE = /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export function scaffoldEmailBotFolder(input: ScaffoldInput): ScaffoldResult {
  const alias = input.alias.trim().toLowerCase();
  if (!ALIAS_RE.test(alias)) {
    throw new Error(`Invalid email alias: ${input.alias}`);
  }
  const persona = input.persona.trim();
  if (!persona) throw new Error('Persona is required (becomes CLAUDE.local.md body).');
  const allowed = input.allowedSenders.trim();
  if (!allowed) throw new Error('Allowed senders are required — fail-safe denies all when empty.');
  const cliScope: CliScope = input.cliScope ?? 'disabled';
  if (!['disabled', 'group', 'global'].includes(cliScope)) {
    throw new Error(`Invalid cli_scope: ${cliScope}`);
  }
  const name = (input.name ?? alias.split('@')[0]).trim();
  if (!name) throw new Error('Bot name cannot be empty.');

  const absPath = path.join(GROUPS_DIR, alias);
  if (fs.existsSync(absPath)) {
    throw new Error(`Folder already exists: groups/${alias}`);
  }

  fs.mkdirSync(absPath, { recursive: true });
  fs.writeFileSync(path.join(absPath, 'CLAUDE.local.md'), `# ${name}\n\n${persona}\n`);
  fs.writeFileSync(path.join(absPath, 'allowed-senders.txt'), `${allowed}\n`);
  fs.writeFileSync(path.join(absPath, 'bot.json'), JSON.stringify({ name, cli_scope: cliScope }, null, 2) + '\n');

  log.info('Scaffolded email-bot folder', { folder: alias, name, cliScope });

  return { folder: alias, absPath };
}

/** List all email-bot folders under groups/ (folders containing CLAUDE.local.md). */
export function listEmailBotFolders(): BotFolder[] {
  if (!fs.existsSync(GROUPS_DIR)) return [];
  const out: BotFolder[] = [];
  for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (/~\d*$/.test(entry.name)) continue; // archived folder (e.g. `bot@x.com~`, `bot@x.com~2`)
    if (!entry.name.includes('@')) continue; // email-bot folders are full addresses
    const bot = readBotFolder(entry.name);
    if (bot) out.push(bot);
  }
  return out;
}

/**
 * Lazily register an email-bot alias. Creates the messaging_group,
 * agent_group, container_config, wiring, and destination if they don't
 * already exist. Returns the resolved messaging_group + agent_group.
 *
 * Safe to call on every inbound email — guarded by existence checks and
 * idempotent under concurrent races.
 */
export interface ProvisionInput {
  channelType: 'resend';
  platformId: string; // e.g. "resend:leet@bot.example.com"
  bot: BotFolder;
}

export interface ProvisionResult {
  mg: MessagingGroup;
  agentGroup: AgentGroup;
  created: boolean;
}

export function provisionEmailBot(input: ProvisionInput): ProvisionResult {
  const { channelType, platformId, bot } = input;
  const folder = bot.folder;

  // Fast path: already wired.
  const existing = getMessagingGroupWithAgentCount(channelType, platformId);
  if (existing && existing.agentCount > 0) {
    const ag = getAgentGroupByFolder(folder);
    if (ag) return { mg: existing.mg, agentGroup: ag, created: false };
  }

  // Slow path — create whatever is missing.
  const now = Date.now();

  // 1. Messaging group (might exist from a prior unwired auto-create).
  let mg = existing?.mg ?? getMessagingGroupByPlatform(channelType, platformId) ?? null;
  if (!mg) {
    const mgId = `mg-${Date.now()}-${randSlug()}`;
    mg = {
      id: mgId,
      channel_type: channelType,
      platform_id: platformId,
      name: bot.config.name ?? folder,
      is_group: 1, // emails are 1:1 from MG's POV, but is_group=1 makes the
      // router upgrade shared sessions to per-thread (one
      // session per email thread).
      unknown_sender_policy: 'request_approval',
      denied_at: null,
      created_at: now,
    };
    try {
      createMessagingGroup(mg);
    } catch (err) {
      // Lost a race; refetch.
      const reread = getMessagingGroupByPlatform(channelType, platformId);
      if (!reread) throw err;
      mg = reread;
    }
  }

  // 2. Agent group (folder is UNIQUE).
  let agentGroup = getAgentGroupByFolder(folder);
  if (!agentGroup) {
    const id = `ag-${Date.now()}-${randSlug()}`;
    agentGroup = {
      id,
      name: bot.config.name ?? folder,
      folder,
      agent_provider: null,
      created_at: now,
    };
    try {
      createAgentGroup(agentGroup);
    } catch (err) {
      const reread = getAgentGroupByFolder(folder);
      if (!reread) throw err;
      agentGroup = reread;
    }
  }

  // 3. Container config + cli_scope (default disabled — per /add-email-bot).
  ensureContainerConfig(agentGroup.id);
  const cliScope: CliScope = bot.config.cli_scope ?? 'disabled';
  updateContainerConfigScalars(agentGroup.id, { cli_scope: cliScope });

  // 4. Filesystem (.claude-shared, settings.json, etc.) — CLAUDE.local.md
  //    is already on disk and initGroupFilesystem won't overwrite it.
  initGroupFilesystem(agentGroup);

  // 5. Wiring + destination (createMessagingGroupAgent auto-creates the
  //    agent_destinations row, which we previously had to insert by hand).
  const wired = (getMessagingGroupWithAgentCount(channelType, platformId)?.agentCount ?? 0) > 0;
  if (!wired) {
    try {
      createMessagingGroupAgent({
        id: `mga-${Date.now()}-${randSlug()}`,
        messaging_group_id: mg.id,
        agent_group_id: agentGroup.id,
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'shared', // router upgrades to per-thread because is_group=1
        priority: 0,
        created_at: now,
      });
    } catch (err) {
      // Race — another inbound just wired it. Tolerate.
      log.debug('Wiring race — already wired', { folder, err });
    }
  }

  log.info('Provisioned email bot', {
    folder,
    agentGroupId: agentGroup.id,
    messagingGroupId: mg.id,
    cliScope,
  });

  return { mg, agentGroup, created: true };
}

function randSlug(): string {
  return Math.random().toString(36).slice(2, 8);
}
