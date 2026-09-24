import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAgentGroup } from '../../../db/agent-groups.js';
import { fetchAudits, searchDirectory } from '../../../skills/directory.js';
import {
  installCatalogSkill,
  resolveSkillUpdate,
  updateCatalogSkill,
  SkillInstallError,
} from '../../../skills/install.js';
import {
  addMarketplace,
  assertCatalogSnapshot,
  MarketplaceError,
  readCatalog,
  refreshMarketplace,
} from '../../../skills/marketplace.js';
import { getMarketplaceRecord, readMarketplaceRecords, type MarketplaceRecord } from '../../../skills/store.js';
import { recordAdminAction } from './audit.js';
import { discoverSkills, installFromRepo, installSkill, refreshCatalog, updateSkill } from './skills-admin.js';

vi.mock('../../../db/agent-groups.js', () => ({ getAgentGroup: vi.fn() }));
vi.mock('./audit.js', () => ({ recordAdminAction: vi.fn() }));
vi.mock('../../../skills/store.js', async (original) => ({
  ...(await original<typeof import('../../../skills/store.js')>()),
  readMarketplaceRecords: vi.fn(),
  getMarketplaceRecord: vi.fn(),
}));
vi.mock('../../../skills/install.js', async (original) => ({
  ...(await original<typeof import('../../../skills/install.js')>()),
  installCatalogSkill: vi.fn(),
  resolveSkillUpdate: vi.fn(),
  updateCatalogSkill: vi.fn(),
}));
vi.mock('../../../skills/marketplace.js', async (original) => ({
  ...(await original<typeof import('../../../skills/marketplace.js')>()),
  addMarketplace: vi.fn(),
  assertCatalogSnapshot: vi.fn(),
  readCatalog: vi.fn(),
  refreshMarketplace: vi.fn(),
}));
vi.mock('../../../skills/directory.js', async (original) => ({
  ...(await original<typeof import('../../../skills/directory.js')>()),
  fetchAudits: vi.fn(),
  searchDirectory: vi.fn(),
}));

const commit = 'a'.repeat(40);
const catalog: MarketplaceRecord = {
  id: 'example-skills',
  repo: 'https://github.com/example/skills.git',
  ref: 'main',
  label: null,
  description: null,
  commit,
  addedAt: '2026-01-01T00:00:00Z',
  refreshedAt: '2026-01-01T00:00:00Z',
};
const skill = {
  marketplaceId: catalog.id,
  plugin: 'skills',
  slug: 'example',
  name: 'example',
  description: 'Example skill',
  license: null,
  path: 'skills/example',
  warnings: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getAgentGroup).mockReturnValue({
    id: 'group',
    name: 'Group',
    folder: 'test-group',
    agent_provider: null,
    created_at: catalog.addedAt,
  });
  vi.mocked(readMarketplaceRecords).mockReturnValue([catalog]);
  vi.mocked(getMarketplaceRecord).mockReturnValue(catalog);
  vi.mocked(fetchAudits).mockResolvedValue(null);
  vi.mocked(readCatalog).mockReturnValue({
    ...catalog,
    lastRefreshAttemptAt: null,
    lastRefreshError: null,
    source: 'example/skills',
    kind: 'skill-repo',
    error: null,
    plugins: [{ name: 'skills', description: null, unsupportedReason: null, skills: [skill] }],
  });
  vi.mocked(addMarketplace).mockReturnValue(catalog);
  vi.mocked(installCatalogSkill).mockReturnValue({
    slug: skill.slug,
    catalogId: catalog.id,
    repo: catalog.repo,
    ref: catalog.ref,
    commit,
    sourcePath: skill.path,
  });
  vi.mocked(resolveSkillUpdate).mockReturnValue({
    groupFolder: 'test-group',
    marketplaceId: catalog.id,
    plugin: skill.plugin,
    slug: skill.slug,
    expectedCommit: commit,
  });
  vi.mocked(updateCatalogSkill).mockReturnValue({
    slug: skill.slug,
    catalogId: catalog.id,
    repo: catalog.repo,
    ref: catalog.ref,
    commit,
    sourcePath: skill.path,
  });
});

describe('cached skill update endpoint', () => {
  it('resolves the installed source, checks audits, and updates only the pinned cached revision', async () => {
    const result = await updateSkill(
      skill.slug,
      {
        gid: 'group',
        marketplaceId: 'untrusted-catalog',
        plugin: 'untrusted-plugin',
        expectedCommit: 'b'.repeat(40),
      },
      'owner',
    );
    expect(result).toMatchObject({ status: 200, body: { skill: { commit, slug: skill.slug } } });
    expect(resolveSkillUpdate).toHaveBeenCalledWith('test-group', skill.slug);
    expect(fetchAudits).toHaveBeenCalledWith('example/skills', skill.slug);
    expect(updateCatalogSkill).toHaveBeenCalledWith({
      groupFolder: 'test-group',
      marketplaceId: catalog.id,
      plugin: skill.plugin,
      slug: skill.slug,
      expectedCommit: commit,
    });
    expect(refreshMarketplace).not.toHaveBeenCalled();
    expect(installCatalogSkill).not.toHaveBeenCalled();
    expect(recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'owner',
        action: 'skill_update',
        targetId: skill.slug,
        payload: expect.objectContaining({ agentGroupId: 'group', commit, path: skill.path }),
      }),
    );
  });

  it('refuses blocking audits without introducing an acknowledgement flow', async () => {
    vi.mocked(fetchAudits).mockResolvedValue([
      {
        provider: 'test',
        slug: skill.slug,
        status: 'fail',
        summary: 'Blocked',
        auditedAt: null,
        riskLevel: 'HIGH',
        categories: [],
      },
    ]);
    const result = await updateSkill(skill.slug, { gid: 'group', acknowledgeRisk: true }, 'owner');
    expect(result).toMatchObject({ status: 409, body: { error: expect.stringContaining('not changed') } });
    expect(updateCatalogSkill).not.toHaveBeenCalled();
    expect(recordAdminAction).not.toHaveBeenCalled();
  });

  it('rejects missing input and unknown groups before resolving a skill', async () => {
    expect(await updateSkill(skill.slug, {}, 'owner')).toMatchObject({ status: 400 });
    expect(await updateSkill('', { gid: 'group' }, 'owner')).toMatchObject({ status: 400 });
    vi.mocked(getAgentGroup).mockReturnValue(undefined);
    expect(await updateSkill(skill.slug, { gid: 'missing' }, 'owner')).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining('unknown agent group') },
    });
    expect(resolveSkillUpdate).not.toHaveBeenCalled();
    expect(updateCatalogSkill).not.toHaveBeenCalled();
  });

  it('preserves explicit local-edit errors before making audit requests', async () => {
    vi.mocked(resolveSkillUpdate).mockImplementation(() => {
      throw new SkillInstallError('local edits');
    });
    expect(await updateSkill(skill.slug, { gid: 'group' }, 'owner')).toEqual({
      status: 400,
      body: { error: 'local edits' },
    });
    expect(fetchAudits).not.toHaveBeenCalled();
    expect(updateCatalogSkill).not.toHaveBeenCalled();
  });

  it('reports stale-snapshot rejection after an asynchronous audit without logging success', async () => {
    vi.mocked(updateCatalogSkill).mockImplementation(() => {
      throw new MarketplaceError('catalog changed');
    });
    expect(await updateSkill(skill.slug, { gid: 'group' }, 'owner')).toEqual({
      status: 400,
      body: { error: 'catalog changed' },
    });
    expect(recordAdminAction).not.toHaveBeenCalled();
  });
});

describe('catalog refresh endpoint', () => {
  it('waits for refresh and returns the new successful timestamp', async () => {
    const updated = { ...catalog, refreshedAt: '2026-09-23T20:30:00Z', lastRefreshError: null };
    vi.mocked(refreshMarketplace).mockResolvedValue(updated);
    expect(await refreshCatalog(catalog.id, 'owner')).toEqual({ status: 200, body: { catalog: updated } });
    expect(recordAdminAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'skill_catalog_refresh' }));
  });

  it('returns retained snapshot metadata and a visible refresh error on failure', async () => {
    const retained = {
      ...catalog,
      lastRefreshError: 'Repository not found',
      lastRefreshAttemptAt: '2026-09-23T20:30:00Z',
    };
    vi.mocked(refreshMarketplace).mockRejectedValue(new MarketplaceError('Repository not found'));
    vi.mocked(getMarketplaceRecord).mockReturnValue(retained);
    expect(await refreshCatalog(catalog.id, 'owner')).toEqual({
      status: 400,
      body: { error: 'Repository not found', catalog: retained },
    });
    expect(recordAdminAction).not.toHaveBeenCalled();
  });
});

describe('snapshot-aware skill install endpoints', () => {
  it('forwards the displayed commit from catalog installs and records the actual revision', async () => {
    const result = await installSkill(
      {
        gid: 'group',
        marketplaceId: catalog.id,
        plugin: 'skills',
        slug: skill.slug,
        expectedCommit: commit,
      },
      'owner',
    );
    expect(result.status).toBe(200);
    expect(installCatalogSkill).toHaveBeenCalledWith({
      groupFolder: 'test-group',
      marketplaceId: catalog.id,
      plugin: 'skills',
      slug: skill.slug,
      expectedCommit: commit,
    });
    expect(recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'skill_install',
        payload: expect.objectContaining({ commit, repo: catalog.repo }),
      }),
    );
  });

  it('forwards the displayed snapshot from directory installs without re-adding the catalog', async () => {
    const result = await installFromRepo(
      {
        gid: 'group',
        repo: 'example/skills',
        slug: skill.slug,
        expectedCommit: commit,
      },
      'owner',
    );
    expect(result.status).toBe(200);
    expect(addMarketplace).not.toHaveBeenCalled();
    expect(assertCatalogSnapshot).toHaveBeenCalledWith(catalog, commit);
    expect(installCatalogSkill).toHaveBeenCalledWith(expect.objectContaining({ expectedCommit: commit }));
  });

  it('registers an unconfigured preview using its commit and ref', async () => {
    vi.mocked(readMarketplaceRecords).mockReturnValue([]);
    const result = await installFromRepo(
      {
        gid: 'group',
        repo: 'example/skills',
        slug: skill.slug,
        ref: 'master',
        expectedCommit: commit,
      },
      'owner',
    );
    expect(result.status).toBe(200);
    expect(addMarketplace).toHaveBeenCalledWith({ repo: 'example/skills', ref: 'master', expectedCommit: commit });
  });

  it('reports a changed snapshot instead of installing from a newer catalog', async () => {
    vi.mocked(assertCatalogSnapshot).mockImplementation(() => {
      throw new MarketplaceError('catalog changed since it was displayed; reload the catalog and review again');
    });
    const result = await installFromRepo(
      {
        gid: 'group',
        repo: 'example/skills',
        slug: skill.slug,
        expectedCommit: commit,
      },
      'owner',
    );
    expect(result).toMatchObject({ status: 400, body: { error: expect.stringContaining('catalog changed') } });
    expect(installCatalogSkill).not.toHaveBeenCalled();
  });

  it.each([null, '', 'main', '../escape', 123])(
    'rejects invalid commit input %s on both endpoints',
    async (expectedCommit) => {
      const body = {
        gid: 'group',
        repo: 'example/skills',
        marketplaceId: catalog.id,
        plugin: 'skills',
        slug: skill.slug,
        expectedCommit,
      };
      for (const install of [installSkill, installFromRepo]) {
        expect(await install(body, 'owner')).toMatchObject({
          status: 400,
          body: { error: 'expectedCommit must be a full catalog commit hash' },
        });
      }
      expect(installCatalogSkill).not.toHaveBeenCalled();
    },
  );

  it('retains audit acknowledgement requirements for cached installations', async () => {
    vi.mocked(fetchAudits).mockResolvedValue([
      {
        provider: 'test',
        slug: skill.slug,
        status: 'fail',
        summary: 'Review required',
        auditedAt: null,
        riskLevel: 'HIGH',
        categories: [],
      },
    ]);
    const body = {
      gid: 'group',
      repo: 'example/skills',
      marketplaceId: catalog.id,
      plugin: 'skills',
      slug: skill.slug,
      expectedCommit: commit,
    };
    for (const install of [installSkill, installFromRepo]) {
      expect(await install(body, 'owner')).toMatchObject({ status: 409, body: { error: 'audit_blocked' } });
    }
    expect(installCatalogSkill).not.toHaveBeenCalled();
    expect((await installFromRepo({ ...body, acknowledgeRisk: true }, 'owner')).status).toBe(200);
    expect(recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'skill_install',
        payload: expect.objectContaining({ auditAcknowledged: true }),
      }),
    );
  });

  it('supplies the registered snapshot alongside directory search hits', async () => {
    vi.mocked(searchDirectory).mockResolvedValue({
      query: 'example',
      searchType: 'fuzzy',
      authenticated: false,
      skills: [
        {
          id: 'example/skills/example',
          source: 'example/skills',
          slug: skill.slug,
          name: skill.name,
          installs: 1,
          url: null,
        },
      ],
    });
    expect(await discoverSkills('example')).toMatchObject({
      status: 200,
      body: { sources: [{ catalogId: catalog.id, snapshot: { commit, ref: catalog.ref } }] },
    });
  });
});
