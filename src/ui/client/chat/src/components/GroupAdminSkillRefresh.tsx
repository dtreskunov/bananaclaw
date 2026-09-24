import type { JSX } from 'preact';

import type { CatalogRefreshMetadata } from '../catalog-refresh';
import { RelativeTime } from './RelativeTime';

export function CatalogRefreshStatus({
  catalog: { refreshedAt, lastRefreshError },
}: { catalog: CatalogRefreshMetadata }): JSX.Element {
  return (
    <div class="ga-catalog-refresh-status" aria-live="polite">
      <p class="ga-catalog-meta">
        Last successful refresh: {refreshedAt
          ? <RelativeTime ts={refreshedAt} className="ga-catalog-refresh-time" />
          : 'Not recorded'}
      </p>
      {lastRefreshError ? (
        <p class="ga-skills-unavailable ga-catalog-refresh-error">
          Refresh failed: {lastRefreshError}
          <br />
          Previously cached skills remain available.
        </p>
      ) : null}
    </div>
  );
}
