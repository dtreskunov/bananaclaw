import type { PendingApprovalDto } from '../types';
import { RelativeTime } from './RelativeTime';

export function ApprovalCard({ approval: a, busy, onRespond, onReview }: {
  approval: PendingApprovalDto;
  busy: boolean;
  onRespond: (value: string) => void;
  onReview: () => void;
}) {
  return <div class="approval-row">
    <div class="approval-text">
      <div class="approval-title">{a.title || a.action}</div>
      {a.packages ? <div class="approval-packages">
        {(['apt', 'npm', 'pip'] as const).map(manager => a.packages![manager].length ? <div class="approval-package-list" key={manager}>
          <span class="approval-package-manager">{manager}</span><span>{a.packages![manager].join(', ')}</span>
        </div> : null)}
      </div> : null}
      {a.details ? <div class="approval-details">{a.details}</div> : null}
      <div class="approval-meta">
        <span class="approval-group">{a.agentGroupName || 'Global'}</span><span class="dot">{'\u00b7'}</span>
        <RelativeTime ts={a.createdAt} />
      </div>
      {a.stage === 'applying' ? <div role="status">Applying approved access…</div> : null}
    </div>
    <div class="approval-actions">
      {!a.options.length ? <span class="approval-disabled">no options</span> : a.options.map(option =>
        <button type="button" class={'approval-btn approval-' + (option.value === 'approve' ? 'approve' : option.value === 'reject' ? 'reject' : 'neutral')}
          disabled={busy || a.stage === 'applying'} key={option.value}
          onClick={() => a.reviewRequired && option.value === 'review' ? onReview() : onRespond(option.value)}>
          {option.label}
        </button>)}
    </div>
  </div>;
}
