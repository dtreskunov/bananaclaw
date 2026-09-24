import { call, errMsg } from './components/GroupAdminApi';

export interface CatalogRefreshMetadata {
  refreshedAt: string | null;
  lastRefreshAttemptAt?: string | null;
  lastRefreshError?: string | null;
}

export interface RefreshedCatalog extends CatalogRefreshMetadata {
  id: string;
  repo: string;
  ref: string;
  commit: string | null;
}

export interface CatalogRefreshState {
  refreshing: ReadonlySet<string>;
  updates: Record<string, Partial<RefreshedCatalog>>;
  versions: Record<string, number>;
}

export function emptyCatalogRefreshState(): CatalogRefreshState {
  return { refreshing: new Set(), updates: {}, versions: {} };
}

export interface VersionedPreview<T> {
  version: number;
  value: T | 'loading' | 'error';
}

export function currentPreview<T>(
  preview: VersionedPreview<T> | undefined,
  version: number,
): T | 'loading' | 'error' | undefined {
  return preview?.version === version ? preview.value : undefined;
}

/** Local overlays also protect metadata in search/list responses started before a refresh. */
export function catalogWithRefresh<T extends { id: string }>(
  catalog: T,
  state: CatalogRefreshState,
): T & Partial<RefreshedCatalog> {
  return { ...catalog, ...state.updates[catalog.id] };
}

export function directoryWithRefresh<
  T extends {
    catalogId: string | null;
    snapshot: { commit: string; ref: string } | null;
  },
>(source: T, state: CatalogRefreshState): T & Partial<CatalogRefreshMetadata> {
  const update = source.catalogId ? state.updates[source.catalogId] : undefined;
  if (!update) return source;
  return {
    ...source,
    ...update,
    snapshot:
      update.commit !== undefined
        ? update.commit
          ? { commit: update.commit, ref: update.ref! }
          : null
        : source.snapshot,
  };
}

/** One coordinator per skills panel, shared by catalog and directory controls. */
export class CatalogRefreshController {
  state = emptyCatalogRefreshState();

  constructor(private readonly onChange: (state: CatalogRefreshState) => void) {}

  private publish(state: CatalogRefreshState): void {
    this.state = state;
    this.onChange(state);
  }

  async refresh(id: string): Promise<{ ok: boolean; error?: string } | null> {
    if (this.state.refreshing.has(id)) return null;
    this.publish({ ...this.state, refreshing: new Set([...this.state.refreshing, id]) });
    let failedCatalog: RefreshedCatalog | null = null;
    try {
      const response = await call<{ catalog?: RefreshedCatalog | null; error?: string }>(
        `/ui/chat/api/skills/catalogs/${encodeURIComponent(id)}/refresh`,
        'POST',
        {},
      );
      if (!response.ok) {
        failedCatalog = response.data.catalog ?? null;
        throw new Error(errMsg(response.data, `HTTP ${response.status}`));
      }
      if (!response.data.catalog) throw new Error('Refresh response did not include a catalog.');
      this.publish({
        ...this.state,
        updates: {
          ...this.state.updates,
          [id]: { ...response.data.catalog, lastRefreshError: null },
        },
        versions: { ...this.state.versions, [id]: (this.state.versions[id] ?? 0) + 1 },
      });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed attempt must never replace the usable snapshot or its success time.
      this.publish({
        ...this.state,
        updates: {
          ...this.state.updates,
          [id]: { ...this.state.updates[id], ...failedCatalog, lastRefreshError: message },
        },
      });
      return { ok: false, error: message };
    } finally {
      const refreshing = new Set(this.state.refreshing);
      refreshing.delete(id);
      this.publish({ ...this.state, refreshing });
    }
  }
}
