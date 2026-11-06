import { toChildArray, type ComponentProps, type JSX, type VNode } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { epochMs } from '../../../../shared/time';
import { testThread } from '../conversation-test-fixtures';
import { groupId, threadId } from '../state';
import { openChat } from '../actions';
import { DmRow, ThreadList, ThreadRow } from './ThreadsRail';
import { RelativeTime } from './RelativeTime';

type ElementNode = VNode<JSX.HTMLAttributes<HTMLElement>>;

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
vi.mock('../actions', async (original) => ({
  ...(await original<typeof import('../actions')>()),
  openChat: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  groupId.value = null;
  threadId.value = null;
  vi.clearAllMocks();
});

describe('thread family rendering', () => {
  const root = testThread({
    threadId: 'root',
    lastActivityAt: epochMs(10),
    forkChildren: [{ threadId: 'branch', messageId: 'message', title: 'New approach' }],
  });
  const branch = testThread({
    threadId: 'branch',
    title: 'New approach',
    lastActivityAt: epochMs(100),
    unread: true,
    activity: 'running',
    forkedFrom: { threadId: 'root', messageId: 'message', title: 'Original', fidelity: 'native', deleted: false },
  });

  it('wires tree ordering and capped guides into existing thread rows with no collapse controls', () => {
    const rows = toChildArray(ThreadList({ items: [branch, root] }).props.children) as VNode<
      ComponentProps<typeof ThreadRow>
    >[];
    expect(rows.map((row) => row.props.t.threadId)).toEqual(['root', 'branch']);
    expect(rows.map((row) => row.type)).toEqual([ThreadRow, ThreadRow]);
    expect(rows.map((row) => row.props.guides)).toEqual([[], [false]]);
    expect(rows.map((row) => row.key)).toEqual(['root', 'branch']);
    expect(rows[1].props.t).toBe(branch);
  });

  it('keeps DM rows using their own renderer', () => {
    const dm = testThread({ kind: 'dm', channelType: 'telegram' });
    const rows = toChildArray(ThreadList({ items: [dm] }).props.children) as VNode<ComponentProps<typeof DmRow>>[];
    expect(rows[0].type).toBe(DmRow);
    expect(rows[0].props.t).toBe(dm);
  });

  it('preserves active/unread state, row timestamps, tree guides and navigation', () => {
    groupId.value = 'group';
    threadId.value = branch.threadId;
    const row = ThreadRow({ t: branch, guides: [true, false] });
    expect(row.props.class).toBe('thread active branch is-unread');
    expect(row.props.style).toEqual({ '--thread-depth': 2 });
    const children = toChildArray(row.props.children) as ElementNode[];
    const guides = children.find((node) => node.props.class === 'thread-tree-guides')!;
    expect(guides.props['aria-hidden']).toBe('true');
    expect((toChildArray(guides.props.children) as ElementNode[]).map((node) => node.props.class)).toEqual([
      'thread-tree-guide continues',
      'thread-tree-guide elbow',
    ]);
    const meta = children.find((node) => node.props.class === 'meta')!;
    const timestamp = (toChildArray(meta.props.children) as ElementNode[])[1];
    expect((toChildArray(timestamp.props.children) as ElementNode[])[0]).toMatchObject({
      type: RelativeTime,
      props: { ts: epochMs(100) },
    });
    row.props.onClick();
    expect(openChat).toHaveBeenCalledExactlyOnceWith('group', 'branch', null);
  });

  it('leaves unavailable/deleted-parent forks at root indentation', () => {
    const orphan = testThread({ ...branch, forkedFrom: { ...branch.forkedFrom!, deleted: true } });
    const rows = toChildArray(ThreadList({ items: [orphan] }).props.children) as VNode<
      ComponentProps<typeof ThreadRow>
    >[];
    const row = ThreadRow(rows[0].props);
    expect(row.props.class).not.toContain(' branch');
    expect(row.props.style).toEqual({ '--thread-depth': 0 });
  });

  it.each([
    { kind: 'parent', t: root },
    { kind: 'branch', t: branch },
    { kind: 'orphan', t: testThread({ ...branch, forkedFrom: { ...branch.forkedFrom!, deleted: true } }) },
  ])('omits fork glyphs and counts from $kind titles', ({ t }) => {
    const row = ThreadRow({ t });
    const title = (toChildArray(row.props.children) as ElementNode[]).find((node) => node.props.class === 'title')!;
    const children = toChildArray(title.props.children) as ElementNode[];
    expect(children).toHaveLength(1);
    expect(children[0].props).toMatchObject({
      class: 'title-text',
    });
  });
});
