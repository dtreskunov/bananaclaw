import { signal } from '@preact/signals';
import { credentialsOpen, drawerOpen, groupAdminOpen } from './state';
import { writeHash } from './hash';

type CredentialsIntent = { resourceUrl?: string; create?: boolean; connectionId?: string };
export const credentialsIntent = signal<CredentialsIntent | null>(null);

export function openCredentials(intent?: CredentialsIntent): void {
  drawerOpen.threads.value = false;
  drawerOpen.files.value = false;
  const navigate = (): void => {
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
  credentialsOpen.value = false;
  writeHash();
  if (location.hash === '#credentials') location.hash = '';
}
