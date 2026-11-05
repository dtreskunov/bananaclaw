import { array, optional, shape, type Check } from './validation.js';

export interface CollectionPatch<T, K extends string | number = string> {
  upserts: T[];
  removeIds: K[];
  order?: K[];
}

export class CollectionPatchError extends Error {
  constructor() {
    super('Invalid collection patch (invalid_frame)');
  }
}

export const sameValue = (before: unknown, after: unknown): boolean => JSON.stringify(before) === JSON.stringify(after);
export const entityId = <T extends { id: string }>(entity: T): string => entity.id;
export const collectionPatchCheck = (entity: Check, key: Check): Check =>
  shape({ upserts: array(entity), removeIds: array(key), order: optional(array(key)) });

export function uniqueKeys<T, K extends string | number>(items: T[], key: (item: T) => K): void {
  if (new Set(items.map(key)).size !== items.length) throw new CollectionPatchError();
}

export function diffCollection<T, K extends string | number>(
  before: T[],
  after: T[],
  key: (item: T) => K,
): CollectionPatch<T, K> | undefined {
  uniqueKeys(before, key);
  uniqueKeys(after, key);
  const old = new Map(before.map((item) => [key(item), item]));
  const order = after.map(key);
  const retained = new Set(order);
  const upserts = after.filter((item) => !sameValue(old.get(key(item)), item));
  const removeIds = [...old.keys()].filter((id) => !retained.has(id));
  const reordered = !sameValue(before.map(key), order);
  return upserts.length || removeIds.length || reordered
    ? { upserts, removeIds, ...(reordered ? { order } : {}) }
    : undefined;
}

export function applyCollection<T, K extends string | number>(
  prior: T[],
  patch: CollectionPatch<T, K> | undefined,
  key: (item: T) => K,
): T[] {
  if (!patch) return prior;
  uniqueKeys(prior, key);
  uniqueKeys(patch.upserts, key);
  uniqueKeys(patch.removeIds, (id) => id);
  const values = new Map(prior.map((item) => [key(item), item]));
  const removed = new Set(patch.removeIds);
  for (const id of removed) if (!values.delete(id)) throw new CollectionPatchError();
  for (const item of patch.upserts) {
    if (removed.has(key(item))) throw new CollectionPatchError();
    values.set(key(item), item);
  }
  const order = patch.order ?? prior.map(key).filter((id) => !removed.has(id));
  if (new Set(order).size !== order.length || order.length !== values.size || order.some((id) => !values.has(id)))
    throw new CollectionPatchError();
  const next = order.map((id) => values.get(id)!);
  return next.length === prior.length && next.every((item, index) => item === prior[index]) ? prior : next;
}
