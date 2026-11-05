import { describe, expect, it } from 'vitest';
import { applyCollection, diffCollection, entityId, type CollectionPatch } from './collection-patch.js';

const before = [
  { id: 'a', value: 1 },
  { id: 'b', value: 2 },
];
describe('keyed collection patches', () => {
  it('omits unchanged collections and order, preserving unchanged identities', () => {
    expect(diffCollection(before, before, entityId)).toBeUndefined();
    const updated = { ...before[1], value: 3 };
    const patch = diffCollection(before, [before[0], updated], entityId);
    expect(patch).toEqual({ upserts: [updated], removeIds: [] });
    const next = applyCollection(before, patch, entityId);
    expect(next[0]).toBe(before[0]);
    expect(next[1]).toBe(updated);
    expect(applyCollection(before, undefined, entityId)).toBe(before);
    expect(applyCollection(before, { upserts: [], removeIds: [] }, entityId)).toBe(before);
  });
  it('converges through insertion, removal, reordering and an empty collection', () => {
    let current = before;
    for (const next of [[{ id: 'c', value: 3 }, ...before], [before[1], before[0]], [before[0]], []]) {
      current = applyCollection(current, diffCollection(current, next, entityId), entityId);
      expect(current).toEqual(next);
    }
    expect(before).toHaveLength(2);
  });
  it.each<CollectionPatch<{ id: string; value: number }>>([
    { upserts: [], removeIds: ['missing'] },
    { upserts: [], removeIds: ['a', 'a'] },
    { upserts: [before[0], before[0]], removeIds: [] },
    { upserts: [before[0]], removeIds: ['a'] },
    { upserts: [{ id: 'c', value: 3 }], removeIds: [] },
    { upserts: [], removeIds: [], order: ['a', 'a'] },
    { upserts: [], removeIds: [], order: ['missing'] },
  ])('rejects corrupt patches without mutating the baseline', (patch) => {
    expect(() => applyCollection(before, patch, entityId)).toThrow('invalid_frame');
    expect(before).toEqual([
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
    ]);
  });
});
