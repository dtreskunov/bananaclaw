// Reactive state (signals) + constants + non-reactive refs.
import { signal, computed, effect, type Signal, type ReadonlySignal } from '@preact/signals';
import type {
  Group,
  Thread,
  ChannelType,
  ChatMessage,
  TreeEntry,
  PreviewBlock,
  UploadItem,
  ShareModalRequest,
  ToastMessage,
  PendingFile,
  PendingApprovalDto,
  PendingQuestionDto,
  ChannelMetaEntry,
  SearchResult,
  ActivityLine,
  TaskPanelRequest,
} from './types';

// ── reactive state ──────────────────────────────────────────────────
export const groups: Signal<Group[]> = signal<Group[]>([]);
export const groupId: Signal<string | null> = signal<string | null>(null);
export const isAdmin: ReadonlySignal<boolean> = computed(() => {
  const id = groupId.value;
  if (!id) return false;
  const g = groups.value.find((x) => x.id === id);
  return !!(g && g.isAdmin);
});
if (typeof document !== 'undefined') {
  effect(() => {
    document.body.classList.toggle('is-admin', isAdmin.value);
  });
}

/**
 * True only for global owners / global admins (server-reported via
 * `/api/me`). Group-level admins are NOT elevated. Controls group
 * picker visibility of admin-only groups.
 */
export const isElevatedUser: Signal<boolean> = signal<boolean>(false);

// File browser
export const treePath: Signal<string> = signal('');
export const filePath: Signal<string | null> = signal<string | null>(null);
export const treeEntries: Signal<TreeEntry[]> = signal<TreeEntry[]>([]);
export const treeError: Signal<string> = signal('');

// Current playback position of the preview media player (seconds).
export const mediaCurrentTime: Signal<number> = signal(0);

// Chat thread
export const threads: Signal<Thread[]> = signal<Thread[]>([]);
export const threadId: Signal<string | null> = signal<string | null>(null);
export const channelType: Signal<ChannelType> = signal<ChannelType>('web');
export const messagingGroupId: Signal<string | null> = signal<string | null>(null);
export const canSend: Signal<boolean> = signal(true);
export const voiceMode: Signal<'off' | 'transcribe' | 'audio'> = signal<'off' | 'transcribe' | 'audio'>('off');
export const chatMessages: Signal<ChatMessage[]> = signal<ChatMessage[]>([]);
export const chatStatus: Signal<string> = signal('');
export const chatLoading: Signal<boolean> = signal(false);
export const chatReady: Signal<boolean> = signal(false);
export const isTyping: Signal<boolean> = signal(false);
export const typingHint: Signal<string> = signal('');
export const typingStartedAt: Signal<number | null> = signal<number | null>(null);
export const typingModel: Signal<string> = signal('');
// Ordered activity-trace lines (tool calls / progress steps) for the
// in-flight turn. Accumulated from WS typing frames; cleared when the
// turn ends or the response arrives.
export const activityLog: Signal<ActivityLine[]> = signal<ActivityLine[]>([]);
export const pending: Signal<PendingFile[]> = signal<PendingFile[]>([]);

// Search
export const searchQuery: Signal<string> = signal('');
export const searchResults: Signal<SearchResult[] | null> = signal<SearchResult[] | null>(null);
export const searchLoading: Signal<boolean> = signal(false);
export const searchOpen: Signal<boolean> = signal(false);
export const highlightMessageId: Signal<string | null> = signal<string | null>(null);
// Scroll trigger — incremented to force scroll-to-bottom (e.g. after send)
export const scrollToBottomTick: Signal<number> = signal(0);

// Panels / drawers
// Desktop panes default to collapsed on every load — the user wanted a
// composer-first initial state. Toggling during a session is not
// persisted (see panels.ts).
export const paneOpen: Record<'threads' | 'files', Signal<boolean>> = {
  threads: signal(false),
  files: signal(false),
};
export const drawerOpen: Record<'threads' | 'files', Signal<boolean>> = {
  threads: signal(false),
  files: signal(false),
};
export const isMobile: Signal<boolean> = signal(false);

// Uploads
export const uploadItems: Signal<UploadItem[]> = signal<UploadItem[]>([]);

// Misc
export const me: Signal<string> = signal('');
export const notifMutedSig: Signal<boolean> = signal(false);
export const progressSoundMutedSig: Signal<boolean> = signal(false);
export const completionSoundMutedSig: Signal<boolean> = signal(false);
export const settingsOpen: Signal<boolean> = signal(false);
export const groupAdminOpen: Signal<boolean> = signal(false);
export const groupPickerOpen: Signal<boolean> = signal(false);
export const groupPickerMode: Signal<'all' | 'non-members'> = signal('all');
export const shareModalRequest: Signal<ShareModalRequest | null> = signal<ShareModalRequest | null>(null);
export const taskPanelRequest: Signal<TaskPanelRequest | null> = signal<TaskPanelRequest | null>(null);
export const toastMessage: Signal<ToastMessage | null> = signal<ToastMessage | null>(null);
export const previewBlock: Signal<PreviewBlock | null> = signal<PreviewBlock | null>(null);
export const nowTick: Signal<number> = signal(Date.now());
export const pinnedContext: Signal<string[]> = signal<string[]>([]);
export const pendingApprovals: Signal<PendingApprovalDto[]> = signal<PendingApprovalDto[]>([]);
export const respondingApprovalIds: Signal<Set<string>> = signal<Set<string>>(new Set());
export const pendingQuestions: Signal<PendingQuestionDto[]> = signal<PendingQuestionDto[]>([]);
export const respondingQuestionIds: Signal<Set<string>> = signal<Set<string>>(new Set());

// ── non-reactive refs (mutated outside render) ──────────────────────
export interface Refs {
  ws: WebSocket | null;
  chatGeneration: number;
  syncRequestId: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  syncTimer: ReturnType<typeof setInterval> | null;
  wsPingTimer: ReturnType<typeof setInterval> | null;
  seenIds: Set<string>;
  suppressHashCount: number;
  uploadDragDepth: number;
  newChatInFlight: boolean;
  /**
   * Live activity trace stashed at turn end so it can be attached to the
   * outbound response bubble. The `typing:{on:false}` frame clears the
   * live `activityLog` and can arrive before the outbound message, so we
   * preserve the trace here and consume it on the next 'out' message.
   * Reset at each turn boundary (new inbound / local send).
   */
  carryActivity: import('./types').ActivityLine[];
}

export const refs: Refs = {
  ws: null,
  chatGeneration: 0,
  syncRequestId: 0,
  reconnectTimer: null,
  reconnectAttempt: 0,
  syncTimer: null,
  wsPingTimer: null,
  seenIds: new Set<string>(),
  suppressHashCount: 0,
  uploadDragDepth: 0,
  newChatInFlight: false,
  carryActivity: [],
};

// ── constants ───────────────────────────────────────────────────────
export const PANES: { key: 'threads' | 'files'; mainClass: string }[] = [
  { key: 'threads', mainClass: 'threads-collapsed' },
  { key: 'files', mainClass: 'files-collapsed' },
];
export const SYNC_INTERVAL_MS = 10000;
export const UPLOAD_MAX_FILE_SIZE = 25 * 1024 * 1024;
export const UPLOAD_MAX_TOTAL_SIZE = 50 * 1024 * 1024;
export const UPLOAD_MAX_FILES = 10;
export const MOBILE_MQ = window.matchMedia('(max-width: 720px)');
export const NOTIF_MUTE_KEY = 'nanoclaw:notif:muted';
export const PROGRESS_SOUND_KEY = 'nanoclaw:sound:progress:muted';
export const COMPLETION_SOUND_KEY = 'nanoclaw:sound:completion:muted';

export const CHANNEL_META: Record<string, ChannelMetaEntry> = {
  web: { label: 'Web', icon: '\uD83D\uDCAC' },
  resend: { label: 'Email', icon: '\uD83D\uDCE7' },
  discord: { label: 'Discord', icon: '\uD83D\uDC7E' },
  telegram: { label: 'Telegram', icon: '\u2708\uFE0F' },
  whatsapp: { label: 'WhatsApp', icon: '\uD83D\uDCDE' },
  imessage: { label: 'iMessage', icon: '\uD83D\uDCAC' },
  signal: { label: 'Signal', icon: '\uD83D\uDD12' },
  slack: { label: 'Slack', icon: '#' },
  matrix: { label: 'Matrix', icon: 'M' },
  gchat: { label: 'Chat', icon: 'G' },
};

export function channelMeta(ct: string | null | undefined): ChannelMetaEntry {
  return (ct && CHANNEL_META[ct]) || { label: ct || 'Channel', icon: '\u2022' };
}
