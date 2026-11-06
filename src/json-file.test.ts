import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readJsonFile } from './json-file.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-json-'));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('defaults only missing files and surfaces malformed JSON', () => {
  expect(readJsonFile(path.join(root, 'missing'), { empty: true })).toEqual({ empty: true });
  fs.writeFileSync(path.join(root, 'invalid'), '{invalid');
  expect(() => readJsonFile(path.join(root, 'invalid'), {})).toThrow('Unable to read JSON metadata');
});
