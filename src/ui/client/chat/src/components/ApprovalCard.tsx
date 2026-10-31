import type { PendingApprovalDto } from '../types';
import { ApprovalMessageInput } from './ApprovalMessageInput';
import { approvalMessageDrafts } from '../approval-messages';
import { approvalThreadHref, isApprovalThread } from '../approval-origin';

export function ApprovalCard({ approval: a, busy, onRespond, onReview }: {
  approval: PendingApprovalDto;
  busy: boolean;
  onRespond: (value: string, message?: string) => void;
  onReview: () => void;
}) {
  const status = a.status ?? a.stage ?? 'pending';
  const pending = status === 'pending';
  const here = isApprovalThread(a.origin);
  const labels: Record<string, string> = {
    approved: 'Approved', rejected: 'Declined', applying: 'Applying…', failed: 'Could not apply',
    cancelled: 'Cancelled', expired: 'Expired',
  };
  return <section class="approval-bubble question-prompt" data-approval-id={a.approvalId} aria-label={a.title || a.action}>
    <div class="approval-text">
      <div class="approval-title">{a.title || a.action}</div>
      {a.packages ? <div class="approval-packages">
        {(['apt', 'npm', 'pip'] as const).map(manager => a.packages![manager].length ? <div class="approval-package-list" key={manager}>
          <span class="approval-package-manager">{manager}</span><span>{a.packages![manager].join(', ')}</span>
        </div> : null)}
      </div> : null}
      {a.details ? <div class="approval-details">{a.details}</div> : null}
      {!here ? <p>{a.origin
        ? <a href={approvalThreadHref(a.origin)}>Open requesting thread</a>
        : 'Requesting thread unavailable.'}</p> : null}
      {!pending ? <div class="approval-decision" role="status">
        <strong>{labels[status] ?? status}</strong>
        {a.respondedBy ? <span> · {a.respondedBy.displayName}</span> : null}
        {a.responseMessage ? <p class="approval-response-text">{a.responseMessage}</p> : null}
        {status === 'failed' && a.outcomeMessage ? <p class="approval-response-text" role="alert">{a.outcomeMessage}</p> : null}
      </div> : null}
      {here && status === 'failed' && a.reviewRequired ? <button type="button" class="approval-btn"
        disabled={busy} onClick={() => { if (isApprovalThread(a.origin)) onReview(); }}>Review failure</button> : null}
      {here && pending && a.supportsResponseMessage ? <ApprovalMessageInput approvalId={a.approvalId}
        disabled={busy || a.stage === 'applying'} /> : null}
    </div>
    {here && pending ? <div class="question-card-actions approval-actions">
      {!a.options.length ? <span class="approval-disabled">no options</span> : a.options.map(option =>
        <button type="button" class={'approval-btn approval-' + (option.value === 'approve' ? 'approve' : option.value === 'reject' ? 'reject' : 'neutral')}
          disabled={busy || a.stage === 'applying'} key={option.value}
          onClick={() => {
            if (!isApprovalThread(a.origin)) return;
            if (a.reviewRequired && option.value === 'review') onReview();
            else {
              const message = a.supportsResponseMessage ? approvalMessageDrafts.value[a.approvalId]?.trim() : undefined;
              if (message) onRespond(option.value, message);
              else onRespond(option.value);
            }
          }}>
          {option.label}
        </button>)}
    </div> : null}
  </section>;
}
