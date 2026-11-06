import { describe, expect, it } from 'vitest';
import { epochMs } from '../../../shared/time';
import { testThread } from './conversation-test-fixtures';
import { buildThreadTree } from './thread-tree';
import type { Thread } from './types';

function thread(id: string, time: number | null, parent?: string, deleted = false): Thread {
  return testThread({
    threadId: id,
    lastActivityAt: time === null ? null : epochMs(time),
    forkedFrom: parent
      ? {
          threadId: parent,
          messageId: 'message',
          title: 'Original',
          fidelity: 'transcript',
          deleted,
        }
      : undefined,
  });
}

describe('buildThreadTree', () => {
  it('sorts unrelated conversations by activity without mutating input or metadata', () => {
    const items = Object.freeze([
      Object.freeze(thread('old', 10)),
      Object.freeze(thread('new', 20)),
      Object.freeze(thread('unknown', null)),
    ]);
    const rows = buildThreadTree(items);
    expect(rows.map((row) => row.thread.threadId)).toEqual(['new', 'old', 'unknown']);
    expect(rows.every((row) => row.depth === 0 && row.guides.length === 0)).toBe(true);
    expect(rows[0].thread).toBe(items[1]);
    expect(items.map((item) => item.threadId)).toEqual(['old', 'new', 'unknown']);
  });

  it('keeps parents first and sorts families and sibling subtrees by their latest descendant', () => {
    const items = [
      thread('other', 80),
      thread('active-sibling', 60, 'root'),
      thread('grandchild', 100, 'old-sibling'),
      thread('root', 10),
      thread('old-sibling', 20, 'root'),
      thread('older-family', 30),
    ];
    const rows = buildThreadTree(items);
    expect(rows.map(({ thread, depth }) => [thread.threadId, depth])).toEqual([
      ['root', 0],
      ['old-sibling', 1],
      ['grandchild', 2],
      ['active-sibling', 1],
      ['other', 0],
      ['older-family', 0],
    ]);
    expect(rows[0].thread.lastActivityAt).toBe(10);
    items[1].lastActivityAt = epochMs(110);
    expect(buildThreadTree(items).map((row) => row.thread.threadId)).toEqual([
      'root',
      'active-sibling',
      'old-sibling',
      'grandchild',
      'other',
      'older-family',
    ]);
  });

  it('lets a parent’s own newer activity determine its family position', () => {
    expect(
      buildThreadTree([thread('other', 50), thread('child', 10, 'root'), thread('root', 100)]).map(
        (row) => row.thread.threadId,
      ),
    ).toEqual(['root', 'child', 'other']);
  });

  it('uses stable ID ordering for equal or missing activity, including siblings', () => {
    const items = [
      thread('z-root', 50),
      thread('b-child', null, 'a-root'),
      thread('a-root', 50),
      thread('a-child', null, 'a-root'),
      thread('z-unknown', null),
      thread('a-unknown', null),
      thread('zero', 0),
    ];
    const expected = ['a-root', 'a-child', 'b-child', 'z-root', 'zero', 'a-unknown', 'z-unknown'];
    expect(buildThreadTree(items).map((row) => row.thread.threadId)).toEqual(expected);
    expect(buildThreadTree([...items].reverse()).map((row) => row.thread.threadId)).toEqual(expected);
  });

  it.each([false, true])(
    'promotes missing/deleted parents without losing surviving descendants (deleted=%s)',
    (deleted) => {
      const rows = buildThreadTree([
        thread('grandchild', 100, 'orphan'),
        thread('orphan', 20, 'missing', deleted),
        thread('other', 50),
      ]);
      expect(rows.map(({ thread, depth }) => [thread.threadId, depth])).toEqual([
        ['orphan', 0],
        ['grandchild', 1],
        ['other', 0],
      ]);
      expect(rows[0].thread.forkedFrom?.deleted).toBe(deleted);
    },
  );

  it('does not reattach a deleted parent even if its ID appears in the listing', () => {
    expect(
      buildThreadTree([thread('parent', 10), thread('orphan', 20, 'parent', true)]).map(({ thread, depth }) => [
        thread.threadId,
        depth,
      ]),
    ).toEqual([
      ['orphan', 0],
      ['parent', 0],
    ]);
  });

  it('does not invent rows from child hints absent from the authorized listing', () => {
    const root = thread('root', 10);
    root.forkChildren = [{ threadId: 'hidden', messageId: 'message', title: 'Hidden child' }];
    expect(buildThreadTree([root])).toEqual([{ thread: root, depth: 0, guides: [] }]);
  });

  it('draws continuing ancestor guides and closes the last sibling’s elbow', () => {
    const rows = buildThreadTree([
      thread('root', 10),
      thread('first', 30, 'root'),
      thread('grandchild', 20, 'first'),
      thread('last', 10, 'root'),
    ]);
    expect(rows.map(({ thread, guides }) => [thread.threadId, guides])).toEqual([
      ['root', []],
      ['first', [true]],
      ['grandchild', [true, false]],
      ['last', [false]],
    ]);
  });

  it('keeps deep forks visible without recursion or more than three guide columns', () => {
    const items = Array.from({ length: 10_000 }, (_, i) => thread(`t-${i}`, i, i ? `t-${i - 1}` : undefined));
    const rows = buildThreadTree(items);
    expect(rows).toHaveLength(items.length);
    expect(rows.at(-1)).toMatchObject({ thread: { threadId: 't-9999' }, depth: 9999, guides: [false, false, false] });
    expect(rows.every((row) => row.guides.length === Math.min(row.depth, 3))).toBe(true);
  });

  it('reports corrupt cyclic lineage explicitly rather than hiding conversations', () => {
    expect(() => buildThreadTree([thread('self', 10, 'self')])).toThrow('Cyclic thread fork lineage');
    expect(() => buildThreadTree([thread('visible', 100), thread('a', 10, 'b'), thread('b', 20, 'a')])).toThrow(
      'Cyclic thread fork lineage',
    );
  });
});
