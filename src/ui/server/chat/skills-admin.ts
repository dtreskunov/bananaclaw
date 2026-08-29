/**
 * Host-wide skill administration — catalogs (Claude Code plugin marketplaces
 * and plain Agent Skills repos) and installed skills.
 *
 * These are install-wide, not per-group: installing a skill only makes it
 * *offerable*, and each agent group still opts in through its own Skills
 * selection. Reserved for owners and global admins for that reason — a scoped
 * admin can pick from what's installed but cannot add new code to the host.
 */
import http from 'http';

import { log } from '../../../log.js';
import { installCatalogSkill, uninstallSkill, SkillInstallError } from '../../../skills/install.js';
import {
  addMarketplace,
  listCatalogs,
  refreshMarketplace,
  removeMarketplace,
  MarketplaceError,
} from '../../../skills/marketplace.js';
import { recordAdminAction } from './audit.js';
import { listAvailableSkills } from './skill-catalog.js';

export interface SkillsAdminResult {
  status: number;
  body: unknown;
}

function fail(err: unknown): SkillsAdminResult {
  if (err instanceof MarketplaceError || err instanceof SkillInstallError) {
    return { status: 400, body: { error: err.message } };
  }
  log.error('skills-admin handler threw', { err });
  return { status: 500, body: { error: 'internal_error' } };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function getSkillsOverview(): SkillsAdminResult {
  return { status: 200, body: { skills: listAvailableSkills(), catalogs: listCatalogs() } };
}

export function addCatalog(body: Record<string, unknown>, actorUserId: string): SkillsAdminResult {
  const repo = str(body.repo);
  if (!repo) return { status: 400, body: { error: 'repo is required' } };
  try {
    const record = addMarketplace({ repo, ref: str(body.ref) || undefined, id: str(body.id) || undefined });
    recordAdminAction({
      actorUserId,
      action: 'skill_catalog_add',
      targetKind: 'skill_catalog',
      targetId: record.id,
      payload: { repo: record.repo, ref: record.ref },
    });
    return { status: 200, body: { catalog: record } };
  } catch (err) {
    return fail(err);
  }
}

export function refreshCatalog(id: string, actorUserId: string): SkillsAdminResult {
  try {
    const record = refreshMarketplace(id);
    recordAdminAction({
      actorUserId,
      action: 'skill_catalog_refresh',
      targetKind: 'skill_catalog',
      targetId: id,
      payload: { commit: record.commit },
    });
    return { status: 200, body: { catalog: record } };
  } catch (err) {
    return fail(err);
  }
}

export function deleteCatalog(id: string, actorUserId: string): SkillsAdminResult {
  try {
    removeMarketplace(id);
    recordAdminAction({ actorUserId, action: 'skill_catalog_remove', targetKind: 'skill_catalog', targetId: id });
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return fail(err);
  }
}

export function installSkill(body: Record<string, unknown>, actorUserId: string): SkillsAdminResult {
  const marketplaceId = str(body.marketplaceId);
  const plugin = str(body.plugin);
  const slug = str(body.slug);
  if (!marketplaceId || !plugin || !slug) {
    return { status: 400, body: { error: 'marketplaceId, plugin and slug are required' } };
  }
  try {
    const record = installCatalogSkill({ marketplaceId, plugin, slug, actorUserId });
    recordAdminAction({
      actorUserId,
      action: 'skill_install',
      targetKind: 'skill',
      targetId: slug,
      payload: { repo: record.repo, ref: record.ref, commit: record.commit, path: record.path },
    });
    return { status: 200, body: { skill: record } };
  } catch (err) {
    return fail(err);
  }
}

export function removeSkill(slug: string, actorUserId: string): SkillsAdminResult {
  try {
    uninstallSkill(slug);
    recordAdminAction({ actorUserId, action: 'skill_uninstall', targetKind: 'skill', targetId: slug });
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return fail(err);
  }
}

/** Parse a JSON request body, capped small — these are tiny control messages. */
export async function readSkillsAdminBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024) throw new SkillInstallError('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}
