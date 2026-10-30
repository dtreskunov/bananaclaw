import { signal } from '@preact/signals';
import { credentialsOpen, drawerOpen, groupAdminOpen } from './state';
import { writeHash } from './hash';

type CredentialsIntent = { resourceUrl?: string; create?: boolean; connectionId?: string; approvalId?: string };
export const credentialsIntent = signal<CredentialsIntent | null>(null);
export const accessApprovalId = signal<string | null>(
  typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('access_request'),
);

export function openCredentials(intent?: CredentialsIntent): void {
  drawerOpen.threads.value = false;
  drawerOpen.files.value = false;
  const navigate = (): void => {
    if (intent?.approvalId) {
      accessApprovalId.value = intent.approvalId;
      const url = new URL(location.href);
      url.searchParams.set('access_request', intent.approvalId);
      history.replaceState(history.state, '', url);
    }
    credentialsIntent.value = intent ?? null;
    credentialsOpen.value = true;
    writeHash();
  };
  // Agent Settings consumes its modal history entry asynchronously on close.
  // Navigate after that pop, or it would consume our new #credentials route.
  if (groupAdminOpen.value && history.state?.__modal_back__) {
    window.addEventListener(
      'popstate',
      () => {
        setTimeout(navigate, 0);
      },
      { once: true },
    );
    groupAdminOpen.value = false;
  } else {
    groupAdminOpen.value = false;
    navigate();
  }
}

export function openChat(): void {
  accessApprovalId.value = null;
  const url = new URL(location.href);
  url.searchParams.delete('access_request');
  history.replaceState(history.state, '', url);
  credentialsOpen.value = false;
  writeHash();
  if (location.hash === '#credentials') location.hash = '';
}
