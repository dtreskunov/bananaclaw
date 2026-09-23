import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAgentGroup } from '../../../db/agent-groups.js';
import { fetchAudits, searchDirectory } from '../../../skills/directory.js';
import { installCatalogSkill } from '../../../skills/install.js';
import { addMarketplace, assertCatalogSnapshot, MarketplaceError, readCatalog } from '../../../skills/marketplace.js';
import { readMarketplaceRecords, type MarketplaceRecord } from '../../../skills/store.js';
import { recordAdminAction } from './audit.js';
import { discoverSkills, installFromRepo, installSkill } from './skills-admin.js';

vi.mock('../../../db/agent-groups.js', () => ({ getAgentGroup: vi.fn() }));
vi.mock('./audit.js', () => ({ recordAdminAction: vi.fn() }));
vi.mock('../../../skills/store.js', async (original) => ({
  ...(await original<typeof import('../../../skills/store.js')>()),
  readMarketplaceRecords: vi.fn(),
}));
vi.mock('../../../skills/install.js', async (original) => ({
  ...(await original<typeof import('../../../skills/install.js')>()),
  installCatalogSkill: vi.fn(),
}));
vi.mock('../../../skills/marketplace.js', async (original) => ({
  ...(await original<typeof import('../../../skills/marketplace.js')>()),
  addMarketplace: vi.fn(),
  assertCatalogSnapshot: vi.fn(),
  readCatalog: vi.fn(),
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
  vi.mocked(fetchAudits).mockResolvedValue(null);
  vi.mocked(readCatalog).mockReturnValue({
    ...catalog,
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
