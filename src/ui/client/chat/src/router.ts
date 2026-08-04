// Shared router used by hash routing and the App component.
import { loadThreads, openChat, clearChat, selectGroup, loadTree, selectFile, restoreFileSearch } from './actions';
import type { RouterApi } from './types';

export const router: RouterApi = {
  selectGroup,
  loadThreads,
  openChat,
  clearChat,
  loadTree,
  selectFile,
  restoreFileSearch,
  notFound: (msg: string) => {
    console.warn(msg);
  },
};
