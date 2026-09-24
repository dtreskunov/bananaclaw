import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'preact';

import {
  CatalogRefreshController,
  catalogWithRefresh,
  currentPreview,
  directoryWithRefresh,
  type RefreshedCatalog,
} from './catalog-refresh';
import { CatalogRefreshStatus } from './components/GroupAdminSkillRefresh';
import { RelativeTime } from './components/RelativeTime';
import { fmtAbsolute } from './utils';

vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});

const previous: RefreshedCatalog = {
  id: 'example-skills',
  repo: 'https://github.com/example/skills.git',
  ref: 'main',
  commit: 'old-commit',
  refreshedAt: '2026-09-23T12:00:00.000Z',
  lastRefreshAttemptAt: '2026-09-23T12:00:00.000Z',
  lastRefreshError: null,
};
const refreshed: RefreshedCatalog = {
  ...previous,
  commit: 'new-commit',
  refreshedAt: '2026-09-23T13:00:00.000Z',
  lastRefreshAttemptAt: '2026-09-23T13:00:00.000Z',
};

function response(body: unknown, status = 200): Response {
  return { ok: status === 200, status, json: async () => body } as Response;
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('manual catalog refresh', () => {
  it('shares immediate per-catalog pending state and deduplicates both entry points', async () => {
    const pending = deferredResponse();
    const fetch = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal('fetch', fetch);
    const changes = vi.fn();
    const controller = new CatalogRefreshController(changes);
    const fromList = controller.refresh(previous.id);
    const fromDirectory = controller.refresh(previous.id);
    expect(controller.state.refreshing.has(previous.id)).toBe(true);
    expect(await fromDirectory).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe('/ui/chat/api/skills/catalogs/example-skills/refresh');
    expect(fetch.mock.calls[0][1].method).toBe('POST');

    pending.resolve(response({ catalog: refreshed }));
    expect(await fromList).toEqual({ ok: true });
    expect(controller.state.refreshing.size).toBe(0);
    expect(controller.state.versions[previous.id]).toBe(1);
    expect(changes.mock.lastCall?.[0]).toBe(controller.state);
  });

  it('refreshes other catalogs independently without a global busy lock', async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const controller = new CatalogRefreshController(() => {});
    const a = controller.refresh(previous.id);
    const b = controller.refresh('another');
    first.resolve(response({ catalog: refreshed }));
    await a;
    expect(controller.state.refreshing.has('another')).toBe(true);
    expect(controller.state.refreshing.has(previous.id)).toBe(false);
    second.resolve(response({ catalog: { ...refreshed, id: 'another' } }));
    await b;
    expect(controller.state.versions).toEqual({ [previous.id]: 1, another: 1 });
  });

  it.each([400, 500])('keeps cached content, commit pins and successful time after HTTP %s', async (status) => {
    const failure = { ...previous, lastRefreshAttemptAt: refreshed.refreshedAt, lastRefreshError: 'fetch failed' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: 'fetch failed', catalog: failure }, status)));
    const controller = new CatalogRefreshController(() => {});
    expect(await controller.refresh(previous.id)).toEqual({ ok: false, error: 'fetch failed' });

    const skills = [{ slug: 'cached-skill' }];
    const catalog = catalogWithRefresh({ ...previous, skills }, controller.state);
    const source = directoryWithRefresh(
      {
        catalogId: previous.id,
        snapshot: { commit: previous.commit!, ref: previous.ref },
        refreshedAt: previous.refreshedAt,
        skills,
      },
      controller.state,
    );
    expect(catalog.skills).toBe(skills);
    expect(source.skills).toBe(skills);
    expect(catalog.refreshedAt).toBe(previous.refreshedAt);
    expect(source.refreshedAt).toBe(previous.refreshedAt);
    expect(source.snapshot?.commit).toBe(previous.commit);
    expect(catalog.lastRefreshError).toBe('fetch failed');
    expect(source.lastRefreshError).toBe('fetch failed');
    expect(catalog.lastRefreshAttemptAt).toBe(refreshed.refreshedAt);
    expect(controller.state.versions[previous.id]).toBeUndefined();
    expect(controller.state.refreshing.size).toBe(0);
  });

  it('shows network failures, recovers controls, and clears the error on retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('Network offline'))
        .mockResolvedValueOnce(response({ catalog: refreshed })),
    );
    const controller = new CatalogRefreshController(() => {});
    expect(await controller.refresh(previous.id)).toEqual({ ok: false, error: 'Network offline' });
    expect(controller.state.refreshing.size).toBe(0);
    expect(catalogWithRefresh(previous, controller.state)).toMatchObject({
      commit: previous.commit,
      refreshedAt: previous.refreshedAt,
      lastRefreshError: 'Network offline',
    });
    await controller.refresh(previous.id);
    expect(catalogWithRefresh(previous, controller.state)).toMatchObject({
      commit: refreshed.commit,
      refreshedAt: refreshed.refreshedAt,
      lastRefreshError: null,
    });
  });

  it('handles missing failure records without losing the last successful snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response({ catalog: refreshed }))
        .mockResolvedValueOnce(response({ catalog: null, error: 'unavailable' }, 500)),
    );
    const controller = new CatalogRefreshController(() => {});
    await controller.refresh(previous.id);
    await controller.refresh(previous.id);
    expect(catalogWithRefresh(previous, controller.state)).toMatchObject({
      commit: refreshed.commit,
      refreshedAt: refreshed.refreshedAt,
      lastRefreshError: 'unavailable',
    });
    expect(controller.state.versions[previous.id]).toBe(1);
  });

  it('advances successful time and invalidates previews even when the commit is unchanged', async () => {
    const unchanged = { ...refreshed, commit: previous.commit };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ catalog: unchanged })));
    const controller = new CatalogRefreshController(() => {});
    await controller.refresh(previous.id);
    expect(catalogWithRefresh(previous, controller.state).refreshedAt).toBe(refreshed.refreshedAt);
    expect(
      currentPreview({ version: 0, value: { commit: previous.commit } }, controller.state.versions[previous.id]),
    ).toBeUndefined();
  });

  it('overlays late directory/list responses and rejects old preview generations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ catalog: refreshed })));
    const controller = new CatalogRefreshController(() => {});
    await controller.refresh(previous.id);
    const lateSource = {
      catalogId: previous.id,
      snapshot: { commit: previous.commit!, ref: previous.ref },
      refreshedAt: previous.refreshedAt,
      lastRefreshError: 'old failure',
    };
    expect(directoryWithRefresh(lateSource, controller.state)).toMatchObject({
      snapshot: { commit: refreshed.commit, ref: refreshed.ref },
      refreshedAt: refreshed.refreshedAt,
      lastRefreshError: null,
    });
    expect(catalogWithRefresh(previous, controller.state).commit).toBe(refreshed.commit);
    const version = controller.state.versions[previous.id];
    expect(currentPreview({ version: 0, value: { commit: previous.commit } }, version)).toBeUndefined();
    expect(currentPreview({ version, value: { commit: refreshed.commit } }, version)).toEqual({
      commit: refreshed.commit,
    });
    expect(directoryWithRefresh({ ...lateSource, catalogId: null }, controller.state).snapshot).toBe(
      lateSource.snapshot,
    );
  });

  it('does not start automatic or periodic refreshes', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(response({ catalog: refreshed }));
    vi.stubGlobal('fetch', fetch);
    const controller = new CatalogRefreshController(() => {});
    vi.advanceTimersByTime(3_600_000);
    expect(fetch).not.toHaveBeenCalled();
    await controller.refresh(previous.id);
    vi.advanceTimersByTime(3_600_000);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('catalog refresh status', () => {
  it('keeps the catalog branch ref inside data rather than a reserved Preact ref', () => {
    const node = createElement(CatalogRefreshStatus, { catalog: previous });
    expect(node.ref).toBeUndefined();
    expect(node.props.catalog).toBe(previous);
    expect(previous.ref).toBe('main');
    const status = CatalogRefreshStatus(node.props);
    expect(status.ref).toBeUndefined();
  });

  it('renders Not recorded for legacy catalogs without a successful timestamp', () => {
    const status = CatalogRefreshStatus({ catalog: { refreshedAt: null } });
    expect(status.props.children[0].props.children).toContain('Not recorded');
  });

  it('renders successful time relatively with an exact timestamp hover and persistent error', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T12:05:00.000Z'));
    const status = CatalogRefreshStatus({ catalog: { ...previous, lastRefreshError: 'permission denied' } });
    const time = status.props.children[0].props.children[1];
    expect(time.type).toBe(RelativeTime);
    const rendered = RelativeTime(time.props);
    expect(rendered?.props.children).toBe('5m');
    expect(rendered?.props.title).toBe(fmtAbsolute(previous.refreshedAt));
    expect(status.props.children[1].props.children).toContain('permission denied');
  });
});
