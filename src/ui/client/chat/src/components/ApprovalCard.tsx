import type { ComponentChildren } from 'preact';
import type { PendingApprovalDto } from '../types';
import { ApprovalMessageInput } from './ApprovalMessageInput';
import { approvalMessageDrafts } from '../approval-messages';
import { approvalThreadHref, isApprovalThread } from '../approval-origin';

export function ApprovalCardFrame({ approvalId, title, children }: {
  approvalId: string; title: string; children: ComponentChildren;
}) {
  return <section class="approval-bubble question-prompt" data-approval-id={approvalId} aria-label={title}>
    <div class="approval-title">{title}</div>
    {children}
  </section>;
}

export function ApprovalCard({ approval: a, busy, onRespond, onReview }: {
  approval: PendingApprovalDto;
  busy: boolean;
  onRespond: (value: string, message?: string) => void;
  onReview: () => void;
}) {
  const status = a.status;
  const pending = status === 'pending';
  const here = isApprovalThread(a.origin);
  const labels: Record<Exclude<PendingApprovalDto['status'], 'pending'>, string> = {
    approved: a.kind === 'account_setup' ? 'Account setup confirmed' : 'Approved',
    rejected: 'Declined', applying: 'Applying…', failed: 'Could not apply',
    cancelled: 'Cancelled', expired: 'Expired',
  };
  return <ApprovalCardFrame approvalId={a.id} title={a.kind === 'account_setup' ? 'Set up an account' :
    a.action === 'add_mcp_server' ? 'Add tools' : a.title || a.action}>
    <div class="approval-text">
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
        <strong>{labels[status]}</strong>
        {a.responseMessage ? <p class="approval-response-text">{a.responseMessage}</p> : null}
        {status === 'failed' && a.outcomeMessage ? <p class="approval-response-text" role="alert">{a.outcomeMessage}</p> : null}
      </div> : null}
      {here && status === 'failed' && a.reviewRequired ? <button type="button" class="approval-btn"
        disabled={busy} onClick={() => { if (isApprovalThread(a.origin)) onReview(); }}>Review failure</button> : null}
      {here && pending && a.supportsResponseMessage ? <ApprovalMessageInput approvalId={a.id}
        disabled={busy} /> : null}
    </div>
    {here && pending ? <div class="question-card-actions approval-actions">
      {!a.options.length ? <span class="approval-disabled">no options</span> : a.options.map(option =>
        <button type="button" class={'approval-btn approval-' + (option.value === 'approve' ? 'approve' : option.value === 'reject' ? 'reject' : 'neutral')}
          disabled={busy} key={option.value}
          onClick={() => {
            if (!isApprovalThread(a.origin)) return;
            if (a.reviewRequired && option.value === 'review') onReview();
            else {
              const message = a.supportsResponseMessage ? approvalMessageDrafts.value[a.id]?.trim() : undefined;
              if (message) onRespond(option.value, message);
              else onRespond(option.value);
            }
          }}>
          {option.label}
        </button>)}
    </div> : null}
  </ApprovalCardFrame>;
}
