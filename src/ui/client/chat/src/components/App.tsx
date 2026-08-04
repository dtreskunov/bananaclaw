// Top-level App component.
import { useEffect } from 'preact/hooks';
import {
  paneOpen, drawerOpen, isMobile, MOBILE_MQ, refs,
  fileSearchOpen, fileSearchRoot, fileSearchQuery,
} from '../state';
import { Header } from './Header';
import { ThreadsRail } from './ThreadsRail';
import { ChatMain } from './ChatMain';
import { FilesPane } from './FilesPane';
import { Settings } from './Settings';
import { ShareLinkModal } from './ShareLinkModal';
import { TaskPanel } from './TaskPanel';
import { PromptModal, ConfirmModal, ChoiceModal } from './PromptModal';
import { Toast } from './Toast';
import { GroupPickerModal } from './GroupPicker';
import { CreateGroupModal } from './CreateGroupModal';
import { GroupAdmin } from './GroupAdmin';
import { applyPanelClasses } from '../panels';
import { applyHash, writeHash } from '../hash';
import { router } from '../router';

export function App() {
  useEffect(() => {
    const onChange = (): void => applyPanelClasses();
    MOBILE_MQ.addEventListener('change', onChange);
    const onHashChange = (): void => {
      if (refs.suppressHashCount > 0) { refs.suppressHashCount--; return; }
      applyHash(router).catch(console.error);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      MOBILE_MQ.removeEventListener('change', onChange);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  const threadsOpen = paneOpen.threads.value;
  const filesOpen = paneOpen.files.value;
  const threadsDrawerOpen = drawerOpen.threads.value;
  const filesDrawerOpen = drawerOpen.files.value;
  const mobile = isMobile.value;
  const filesSearching = fileSearchOpen.value;
  const fileSearchScope = fileSearchRoot.value;
  const fileQuery = fileSearchQuery.value;
  useEffect(() => { writeHash(true); }, [
    threadsOpen, filesOpen, threadsDrawerOpen, filesDrawerOpen, mobile,
    filesSearching, fileSearchScope, fileQuery,
  ]);

  const mainCls = ''
    + (threadsOpen ? '' : ' threads-collapsed')
    + (filesOpen ? '' : ' files-collapsed');
  const backdropShown = mobile && (threadsDrawerOpen || filesDrawerOpen);
  const onBackdrop = (): void => { drawerOpen.threads.value = false; drawerOpen.files.value = false; };
  return (
    <>
      <Header />
      <main id="main" class={mainCls.trim()}>
        <ThreadsRail />
        <ChatMain />
        <FilesPane />
      </main>
      <div class={'backdrop' + (backdropShown ? ' show' : '')} id="backdrop" onClick={onBackdrop}></div>
      <Settings />
      <ShareLinkModal />
      <TaskPanel />
      <PromptModal />
      <ConfirmModal />
      <ChoiceModal />
      <GroupPickerModal />
      <GroupAdmin />
      <CreateGroupModal />
      <Toast />
    </>
  );
}
