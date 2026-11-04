export type Check = (value: unknown) => boolean;
export const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const text = (value: unknown): value is string => typeof value === 'string';
export const id: Check = (value) => text(value) && value.length > 0;
export const bool: Check = (value) => typeof value === 'boolean';
export const number: Check = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const integer: Check = (value) => number(value) && Number.isSafeInteger(value);
export const position: Check = (value) => integer(value) && Number(value) > 0;
export const optional =
  (check: Check): Check =>
  (value) =>
    value === undefined || check(value);
export const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
export const array =
  (check: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every(check);
export const oneOf =
  (...values: string[]): Check =>
  (value) =>
    typeof value === 'string' && values.includes(value);
export const shape =
  (fields: Record<string, Check>): Check =>
  (value) =>
    object(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
