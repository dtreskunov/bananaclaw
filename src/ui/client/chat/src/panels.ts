// Pane layout body/main class side-effects.
import { drawerOpen, isMobile, MOBILE_MQ } from './state';

export function applyPanelClasses(): void {
  const mobile = MOBILE_MQ.matches;
  isMobile.value = mobile;
  if (mobile) {
    document.body.classList.add('mobile');
  } else {
    document.body.classList.remove('mobile');
    drawerOpen.threads.value = false;
    drawerOpen.files.value = false;
  }
}
