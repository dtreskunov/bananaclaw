import type { ApprovalOrigin } from './approval.js';
import type { ReadCursor } from './read-state.js';

export type ActivityNavigationKind = 'unread' | 'running' | 'latest';

export interface ActivityTarget {
  origin: ApprovalOrigin;
  anchor: { kind: 'message' | 'interaction'; id: string };
  readCursor?: ReadCursor;
}
