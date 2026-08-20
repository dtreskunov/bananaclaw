// URL hash routing.
import { batch } from '@preact/signals';
import { match, compile } from 'path-to-regexp';
import {
  groups,
  groupId,
  treePath,
  filePath,
  threads,
  threadId,
  refs,
  paneOpen,
  drawerOpen,
  isMobile,
  fileSearchOpen,
  fileSearchRoot,
  fileSearchQuery,
} from './state';
import { parentPath } from './utils';
import type { Thread, ThreadCtx, RouterApi } from './types';

const PATTERNS = ['/g/:gid/t/:tid/:kind/*filepath', '/g/:gid/t/:tid', '/g/:gid/:kind/*filepath', '/g/:gid'] as const;

const matchers = PATTERNS.map((p) => match(p));
const builders: Record<string, (params: Partial<Record<string, string | string[]>>) => string> = Object.fromEntries(
  PATTERNS.map((p) => [p, compile(p)]),
);

export interface ParsedHash {
  groupId: string;
  threadId: string | null;
  path: string;
  isDir: boolean;
  threadsOpen: boolean;
  filesOpen: boolean;
  fileSearchOpen: boolean;
  fileSearchRoot: string | null;
  fileSearchQuery: string;
}

export function parseHash(): ParsedHash | null {
  const fragment = location.hash.replace(/^#/, '');
  const queryAt = fragment.indexOf('?');
  const raw = (queryAt === -1 ? fragment : fragment.slice(0, queryAt)).replace(/\/$/, '');
  const panelParams = new URLSearchParams(queryAt === -1 ? '' : fragment.slice(queryAt + 1));
  if (!raw) return null;
  const test = '/' + raw;
  for (const m of matchers) {
    const r = m(test);
    if (!r) continue;
    const params = (r as { params: Record<string, unknown> }).params;
    const gid = String(params.gid || '');
    const tid = params.tid ? String(params.tid) : null;
    const kind = params.kind ? String(params.kind) : '';
    const filepath = params.filepath;
    if (kind && kind !== 'f' && kind !== 'd') continue;
    const path = Array.isArray(filepath) ? (filepath as string[]).join('/') : filepath ? String(filepath) : '';
    return {
      groupId: gid,
      threadId: tid,
      path,
      isDir: !kind || kind === 'd',
      threadsOpen: panelParams.get('threads') === 'open',
      filesOpen: panelParams.get('files') === 'open',
      fileSearchOpen: panelParams.get('file-search') === 'open',
      fileSearchRoot: panelParams.has('file-root') ? panelParams.get('file-root')! : null,
      fileSearchQuery: panelParams.get('file-query') || '',
    };
  }
  return null;
}

export function buildHash(): string {
  if (!groupId.value) return '';
  const hasThread = !!threadId.value;
  const path = filePath.value || treePath.value;
  const hasPath = !!path;
  let pattern: string;
  if (hasThread && hasPath) pattern = '/g/:gid/t/:tid/:kind/*filepath';
  else if (hasThread) pattern = '/g/:gid/t/:tid';
  else if (hasPath) pattern = '/g/:gid/:kind/*filepath';
  else pattern = '/g/:gid';
  const params: Partial<Record<string, string | string[]>> = { gid: groupId.value };
  if (hasThread) params.tid = threadId.value!;
  if (hasPath) {
    params.kind = filePath.value ? 'f' : 'd';
    params.filepath = String(path).split('/').filter(Boolean);
  }
  let s = builders[pattern]!(params);
  if (hasPath && !filePath.value) s += '/';
  const panelParams = new URLSearchParams();
  const open = isMobile.value ? drawerOpen : paneOpen;
  if (open.threads.value) panelParams.set('threads', 'open');
  if (open.files.value) panelParams.set('files', 'open');
  if (fileSearchOpen.value) panelParams.set('file-search', 'open');
  if (fileSearchQuery.value) panelParams.set('file-query', fileSearchQuery.value);
  if (fileSearchOpen.value) panelParams.set('file-root', fileSearchRoot.value);
  const query = panelParams.toString();
  return '#' + s.slice(1) + (query ? '?' + query : '');
}

export function writeHash(replace = false): void {
  const h = buildHash();
  if (!h) return;
  if (location.hash !== h) {
    if (replace) {
      history.replaceState(null, '', h);
      return;
    }
    refs.suppressHashCount++;
    location.hash = h;
  }
}

export function threadCtx(t: Thread | null | undefined): ThreadCtx | null {
  if (!t) return null;
  if (!t.channelType || t.channelType === 'web') return null;
  return { channelType: t.channelType, messagingGroupId: t.messagingGroupId ?? null, canSend: !!t.canSend };
}

export async function applyHash(router: RouterApi): Promise<void> {
  const parsed = parseHash();
  if (!parsed) {
    if (groups.value.length) await router.selectGroup(groups.value[0]!.id);
    return;
  }
  if (!groups.value.find((g) => g.id === parsed.groupId)) {
    router.notFound('No access to group ' + parsed.groupId);
    return;
  }
  const groupChanged = groupId.value !== parsed.groupId;
  const routedParent = parsed.isDir ? parsed.path : parentPath(parsed.path);
  batch(() => {
    groupId.value = parsed.groupId;
    treePath.value = routedParent;
    filePath.value = parsed.isDir ? null : parsed.path;
    paneOpen.threads.value = parsed.threadsOpen;
    paneOpen.files.value = parsed.filesOpen;
    drawerOpen.threads.value = parsed.threadsOpen;
    drawerOpen.files.value = parsed.filesOpen;
  });
  const searchRoot = parsed.fileSearchRoot ?? routedParent;
  const restoredSearch = router.restoreFileSearch(parsed.fileSearchOpen, searchRoot, parsed.fileSearchQuery);
  const threadsFresh = groupChanged ? await router.loadThreads(parsed.groupId) : true;

  // A thread id that isn't in this group's list (stale link, or a group switch
  // that raced a failed refresh) can't be opened here — its socket is rejected
  // for good — so fall back to the group's newest thread and rewrite the hash.
  const routedThread =
    parsed.threadId && (!threadsFresh || threads.value.some((t) => t.threadId === parsed.threadId))
      ? parsed.threadId
      : null;

  if (routedThread) {
    router.openChat(parsed.groupId, routedThread, null).catch((err) => console.error('chat open failed', err));
  } else if (groupChanged || parsed.threadId) {
    const latest = threads.value.length > 0 ? threads.value[0]! : null;
    if (latest)
      router
        .openChat(parsed.groupId, latest.threadId, threadCtx(latest))
        .catch((err) => console.error('chat open failed', err));
    else router.openChat(parsed.groupId, null, null).catch((err) => console.error('auto-start chat failed', err));
  }
  if (parsed.isDir) {
    await router.loadTree(parsed.path);
  } else {
    const parent = parentPath(parsed.path);
    await router.loadTree(parent);
    const name = parent ? parsed.path.slice(parent.length + 1) : parsed.path;
    await router.selectFile({ path: parsed.path, name });
  }
  await restoredSearch;
}
