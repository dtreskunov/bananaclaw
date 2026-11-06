import type { Thread } from './types';

export interface ThreadTreeRow {
  thread: Thread;
  depth: number;
  /** Visible guide columns; true continues the line to a later sibling. */
  guides: boolean[];
}

interface ThreadNode {
  thread: Thread;
  children: ThreadNode[];
  latestActivityAt: number;
}

export function buildThreadTree(threads: readonly Thread[]): ThreadTreeRow[] {
  const nodes = threads.map(
    (thread): ThreadNode => ({
      thread,
      children: [],
      latestActivityAt: thread.lastActivityAt ?? -Infinity,
    }),
  );
  const byId = new Map(nodes.map((node) => [node.thread.threadId, node]));
  const roots: ThreadNode[] = [];
  for (const node of nodes) {
    const origin = node.thread.forkedFrom;
    const parent = origin && !origin.deleted ? byId.get(origin.threadId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const descendants = [...roots];
  for (let i = 0; i < descendants.length; i++) {
    descendants.push(...descendants[i].children);
  }
  if (descendants.length !== nodes.length) throw new Error('Cyclic thread fork lineage');

  const byActivity = (a: ThreadNode, b: ThreadNode): number =>
    b.latestActivityAt - a.latestActivityAt || a.thread.threadId.localeCompare(b.thread.threadId);
  for (let i = descendants.length - 1; i >= 0; i--) {
    const node = descendants[i];
    for (const child of node.children) {
      node.latestActivityAt = Math.max(node.latestActivityAt, child.latestActivityAt);
    }
    node.children.sort(byActivity);
  }
  roots.sort(byActivity);

  const rows: ThreadTreeRow[] = [];
  const stack: { node: ThreadNode; depth: number; guides: boolean[] }[] = roots
    .map((node) => ({ node, depth: 0, guides: [] }))
    .reverse();
  while (stack.length) {
    const { node, depth, guides } = stack.pop()!;
    rows.push({ thread: node.thread, depth, guides });
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({
        node: node.children[i],
        depth: depth + 1,
        // Keep the first two ancestor guides and the immediate branch elbow.
        guides: [...guides.slice(0, 2), i < node.children.length - 1],
      });
    }
  }
  return rows;
}
