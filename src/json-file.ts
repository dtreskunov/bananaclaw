import fs from 'node:fs';

export function readJsonFile<T>(file: string, missing: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return missing;
    throw new Error(`Unable to read JSON metadata: ${file}`, { cause: error });
  }
}
