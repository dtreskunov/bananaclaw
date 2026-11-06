import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Linter, type Rule } from 'eslint';
import { parser } from 'typescript-eslint';
import ts from 'typescript';

interface FunctionMetrics {
  name: string;
  complexity: number;
  line: number;
  column: number;
}

interface Metrics {
  loc: number;
  functions: FunctionMetrics[];
}

interface SourceFile {
  file: string;
  hash: string;
}

interface MeasuredFile extends SourceFile, Metrics {
  category: CodeCategory;
}

export type CodeCategory = 'production' | 'tests' | 'tooling';

export interface Options {
  staged?: boolean;
  from?: string;
  to?: string;
  days?: number;
  json?: boolean;
  noCache?: boolean;
}

const extensions = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const excludedDirectory = /(?:^|\/)(?:dist|node_modules|vendor|coverage|build)(?:\/|$)/;
const testPath =
  /(?:^|\/)(?:__tests__|__fixtures__|__mocks__|tests?|fixtures?|mocks?|test-fixtures|test-utils|test-helpers)(?:\/|$)|(?:^|\/|[.-])(?:test|spec|fixtures?|mocks?|test-utils|test-helpers)(?:[.-]|$)/;
const toolingPath =
  /(?:^|\/)(?:scripts|setup|\.claude|\.github|\.githooks|\.husky)(?:\/|$)|(?:^|\/)(?:eslint|vitest|vite|webpack|rollup|esbuild|prettier|babel|postcss|tailwind|playwright)(?:\.[^/]+)?\.config\.[^/]+$/;
const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const parserPackage: unknown = createRequire(import.meta.url)('typescript-eslint/package.json');
if (
  typeof parserPackage !== 'object' ||
  parserPackage === null ||
  !('version' in parserPackage) ||
  typeof parserPackage.version !== 'string'
) {
  throw new Error('Cannot determine the typescript-eslint analyzer version.');
}
const versions = { eslint: Linter.version, parser: parserPackage.version, typescript: ts.version };
const cacheVersion = `v1-${versions.eslint}-${versions.parser}-${versions.typescript}`;
const linter = new Linter();

export function classifyFile(file: string): CodeCategory {
  if (testPath.test(file)) return 'tests';
  if (toolingPath.test(file)) return 'tooling';
  if (file.startsWith('src/') || file.startsWith('container/agent-runner/src/')) return 'production';
  return 'tooling';
}

export function measureSource(text: string, filename: string): Metrics {
  let loc: number | undefined;
  const locRule: Rule.RuleModule = {
    meta: { schema: [] },
    create(context) {
      return {
        Program(node) {
          const source = context.sourceCode;
          const lines = new Set<number>();
          for (const token of source.getTokens(node)) {
            for (let line = token.loc.start.line; line <= token.loc.end.line; line++) {
              if (source.lines[line - 1].trim()) lines.add(line);
            }
          }
          loc = lines.size;
        },
      };
    },
  };
  const messages = linter.verify(
    text,
    [
      {
        files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
        languageOptions: {
          parser,
          ecmaVersion: 'latest',
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { measure: { rules: { loc: locRule } } },
        rules: {
          complexity: ['error', { max: 0, variant: 'classic' }],
          'measure/loc': 'error',
        },
      },
    ],
    { filename, allowInlineConfig: false },
  );
  const errors = messages.filter((message) => message.ruleId !== 'complexity');
  if (errors.length || loc === undefined) {
    throw new Error(`${filename}: analysis failed: ${JSON.stringify(errors)}`);
  }
  const functions = messages
    .filter((message) => message.nodeType && functionTypes.has(message.nodeType))
    .map((message) => {
      const match = /^(.*?) has a complexity of (\d+)\./.exec(message.message);
      if (!match) throw new Error(`${filename}: unrecognized complexity result: ${message.message}`);
      return { name: match[1], complexity: Number(match[2]), line: message.line, column: message.column };
    });
  return { loc, functions };
}

function git(root: string, args: string[], input?: string): Buffer {
  return execFileSync('git', args, { cwd: root, input, maxBuffer: 128 * 1024 * 1024 });
}

function gitText(root: string, args: string[]): string {
  return git(root, args).toString('utf8').trim();
}

function revision(root: string, ref: string): string {
  return gitText(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
}

function sourceFiles(root: string, tree: string | null): SourceFile[] {
  if (tree === null) return [];
  return git(root, ['ls-tree', '-rz', tree])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .flatMap((entry) => {
      const tab = entry.indexOf('\t');
      const [mode, type, hash] = entry.slice(0, tab).split(' ');
      const file = entry.slice(tab + 1);
      return type === 'blob' && mode !== '120000' && extensions.test(file) && !excludedDirectory.test(file)
        ? [{ file, hash }]
        : [];
    });
}

function readBlobs(root: string, hashes: string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  if (!hashes.length) return blobs;
  const output = git(root, ['cat-file', '--batch'], `${hashes.join('\n')}\n`);
  let cursor = 0;
  for (const hash of hashes) {
    const newline = output.indexOf(10, cursor);
    assert(newline >= cursor, 'Missing git blob header');
    const [returnedHash, type, sizeText] = output.subarray(cursor, newline).toString('utf8').split(' ');
    assert.equal(returnedHash, hash);
    assert.equal(type, 'blob');
    const size = Number(sizeText);
    assert(Number.isSafeInteger(size) && size >= 0, 'Invalid git blob size');
    blobs.set(hash, output.subarray(newline + 1, newline + 1 + size).toString('utf8'));
    cursor = newline + 1 + size;
    assert.equal(output[cursor++], 10);
  }
  assert.equal(cursor, output.length);
  return blobs;
}

function isMetrics(value: unknown): value is Metrics {
  return (
    typeof value === 'object' &&
    value !== null &&
    'loc' in value &&
    typeof value.loc === 'number' &&
    Number.isSafeInteger(value.loc) &&
    value.loc >= 0 &&
    'functions' in value &&
    Array.isArray(value.functions) &&
    value.functions.every(
      (fn: unknown) =>
        typeof fn === 'object' &&
        fn !== null &&
        'name' in fn &&
        typeof fn.name === 'string' &&
        ['complexity', 'line', 'column'].every(
          (key) => key in fn && Number.isSafeInteger(Reflect.get(fn, key)) && Reflect.get(fn, key) > 0,
        ),
    )
  );
}

function readCache(file: string): Metrics | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid metrics cache ${file}; remove this entry and retry.`, { cause: error });
  }
  if (!isMetrics(value)) throw new Error(`Invalid metrics cache ${file}; remove this entry and retry.`);
  return value;
}

function writeCache(file: string, metrics: Metrics): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(metrics), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function summarize(files: Metrics[]) {
  const complexities = files.flatMap((file) => file.functions.map((fn) => fn.complexity)).sort((a, b) => a - b);
  const complexity = complexities.reduce((total, value) => total + value, 0);
  const loc = files.reduce((total, file) => total + file.loc, 0);
  const functions = complexities.length;
  return {
    files: files.length,
    loc,
    functions,
    complexity,
    average: functions ? complexity / functions : null,
    p95: complexities[Math.ceil(functions * 0.95) - 1] ?? null,
    max: complexities.at(-1) ?? null,
    above20: complexities.filter((value) => value > 20).length,
    branchPointsPerKloc: loc ? ((complexity - functions) * 1000) / loc : null,
  };
}

function component(file: string): string {
  if (file.startsWith('src/ui/')) return 'UI';
  if (file.startsWith('src/')) return 'Host';
  if (file.startsWith('container/agent-runner/src/')) return 'Agent runner';
  throw new Error(`Unrecognized production source tree: ${file}`);
}

function snapshot(label: string, revision: string | null, files: MeasuredFile[]) {
  const production = files.filter((file) => file.category === 'production');
  return {
    label,
    revision,
    all: summarize(files),
    production: summarize(production),
    tests: summarize(files.filter((file) => file.category === 'tests')),
    tooling: summarize(files.filter((file) => file.category === 'tooling')),
    components: Object.fromEntries(
      [...new Set(production.map((file) => component(file.file)))]
        .sort()
        .map((name) => [name, summarize(production.filter((file) => component(file.file) === name))]),
    ),
    hotspots: production
      .flatMap((file) => file.functions.map((fn) => ({ file: file.file, ...fn })))
      .sort((a, b) => b.complexity - a.complexity || a.file.localeCompare(b.file) || a.line - b.line)
      .slice(0, 10),
  };
}

export function compare(options: Options = {}, cwd = process.cwd(), now = new Date()) {
  if (options.staged && (options.from || options.to || options.days !== undefined)) {
    throw new Error('--staged cannot be combined with --from, --to, or --days.');
  }
  if (options.from && options.days !== undefined) throw new Error('Use either --from or --days, not both.');
  if (options.days !== undefined && (!Number.isSafeInteger(options.days) || options.days < 1)) {
    throw new Error('--days must be a positive integer.');
  }
  const root = gitText(cwd, ['rev-parse', '--show-toplevel']);
  let base: string | null;
  let target: string;
  let cutoff: string | null = null;
  if (options.staged) {
    const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    });
    if (head.error) throw head.error;
    if (head.status !== 0 && head.status !== 1) throw new Error(`Cannot resolve HEAD: ${head.stderr}`);
    base = head.status === 0 ? head.stdout.trim() : null;
    target = gitText(root, ['write-tree']);
  } else {
    target = revision(root, options.to ?? 'HEAD');
    if (options.from) {
      base = revision(root, options.from);
    } else {
      cutoff = new Date(now.getTime() - (options.days ?? 7) * 86400000).toISOString();
      base = gitText(root, ['rev-list', '-1', `--before=${cutoff}`, target]);
      if (!base) throw new Error(`No ancestor commit before ${cutoff}; provide --from explicitly.`);
    }
  }
  const sources = [sourceFiles(root, base), sourceFiles(root, target)];
  const key = (file: SourceFile) => `${file.hash}${path.extname(file.file)}`;
  const unique = new Map(sources.flat().map((file) => [key(file), file]));
  const directory = path.join(
    gitText(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    'code-metrics-cache',
    cacheVersion,
  );
  const measured = new Map<string, Metrics>();
  const missing: SourceFile[] = [];
  for (const [id, file] of unique) {
    const cached = options.noCache ? undefined : readCache(path.join(directory, `${id}.json`));
    if (cached) measured.set(id, cached);
    else missing.push(file);
  }
  const blobs = readBlobs(root, [...new Set(missing.map((file) => file.hash))]);
  for (const file of missing) {
    const text = blobs.get(file.hash);
    if (text === undefined) throw new Error(`Missing blob ${file.hash}`);
    const metrics = measureSource(text, file.file);
    measured.set(key(file), metrics);
    if (!options.noCache) writeCache(path.join(directory, `${key(file)}.json`), metrics);
  }
  const files = sources.map((entries) =>
    entries.map((file): MeasuredFile => {
      const metrics = measured.get(key(file));
      if (!metrics) throw new Error(`Missing metrics for ${file.file}`);
      return { ...file, ...metrics, category: classifyFile(file.file) };
    }),
  );
  const snapshots = [
    snapshot(base ?? '(empty)', base, files[0]),
    snapshot(options.staged ? `index (${target})` : target, target, files[1]),
  ];
  const oldFiles = new Map(files[0].map((file) => [file.file, file]));
  const newFiles = new Map(files[1].map((file) => [file.file, file]));
  const changes = [...new Set([...oldFiles.keys(), ...newFiles.keys()])]
    .sort()
    .filter((file) => oldFiles.get(file)?.hash !== newFiles.get(file)?.hash)
    .map((file) => {
      const old = oldFiles.get(file);
      const current = newFiles.get(file);
      return {
        file,
        beforeCategory: old?.category ?? null,
        afterCategory: current?.category ?? null,
        before: summarize(old ? [old] : []),
        after: summarize(current ? [current] : []),
      };
    });
  return {
    methodology: {
      scope: 'Git-tracked TS/JS regular files; generated build/dist, dependencies, vendor and coverage excluded.',
      loc: 'Nonblank physical lines containing a non-comment parser token.',
      complexity: 'ESLint classic cyclomatic complexity, function nodes only; implicit class paths excluded.',
      classificationVersion: 2,
      classification: {
        production: 'Runtime source under src/ and container/agent-runner/src/, excluding tests/support and tooling.',
        tests: testPath.source,
        tooling: 'Setup, scripts, skills, build/lint/test configuration, and other non-runtime roots.',
        toolingPattern: toolingPath.source,
      },
      versions,
      cutoff,
    },
    snapshots,
    changes,
    cache: { directory, enabled: !options.noCache, hits: unique.size - missing.length, misses: missing.length },
  };
}

function delta(before: number, after: number, decimals = 0): string {
  const difference = after - before;
  const amount = `${difference > 0 ? '+' : ''}${difference.toFixed(decimals)}`;
  return before ? `${amount} (${((after / before - 1) * 100).toFixed(1)}%)` : `${amount} (n/a baseline)`;
}

export function formatReport(report: ReturnType<typeof compare>): string {
  const [before, after] = report.snapshots;
  const rows: [string, number | null, number | null, number?][] = [
    ['Total LOC', before.all.loc, after.all.loc],
    ['Production LOC', before.production.loc, after.production.loc],
    ['Test/support LOC', before.tests.loc, after.tests.loc],
    ['Tooling/setup LOC', before.tooling.loc, after.tooling.loc],
    ['Production total complexity', before.production.complexity, after.production.complexity],
    ['Test/support total complexity', before.tests.complexity, after.tests.complexity],
    ['Tooling/setup total complexity', before.tooling.complexity, after.tooling.complexity],
    ['Average complexity/function', before.production.average, after.production.average, 2],
    ['95th-percentile complexity', before.production.p95, after.production.p95],
    ['Functions with complexity >20', before.production.above20, after.production.above20],
    ['Maximum complexity', before.production.max, after.production.max],
    ['Branch points/KLOC', before.production.branchPointsPerKloc, after.production.branchPointsPerKloc, 2],
  ];
  const lines = [
    `Before: ${before.label}`,
    `After: ${after.label}`,
    'Scope: tracked TS/JS; comments, blanks and generated bundles excluded.',
    'Production: runtime host/UI and agent-runner source only; tests/support and tooling are separate.',
    '',
    '| Metric | Before | After | Change |',
    '|---|---:|---:|---:|',
    ...rows.map(
      ([name, a, b, decimals = 0]) =>
        `| ${name} | ${a?.toFixed(decimals) ?? 'n/a'} | ${b?.toFixed(decimals) ?? 'n/a'} | ${a === null || b === null ? 'n/a' : delta(a, b, decimals)} |`,
    ),
    '',
    'Production components:',
    '| Component | LOC change | Complexity change |',
    '|---|---:|---:|',
  ];
  for (const name of [...new Set([...Object.keys(before.components), ...Object.keys(after.components)])].sort()) {
    const a = before.components[name] ?? summarize([]);
    const b = after.components[name] ?? summarize([]);
    lines.push(`| ${name} | ${delta(a.loc, b.loc)} | ${delta(a.complexity, b.complexity)} |`);
  }
  lines.push('', 'Largest changed production files (moves may appear as additions/deletions):');
  const changes = report.changes
    .filter((file) => file.beforeCategory === 'production' || file.afterCategory === 'production')
    .sort(
      (a, b) =>
        Math.abs(b.after.complexity - b.before.complexity) - Math.abs(a.after.complexity - a.before.complexity) ||
        Math.abs(b.after.loc - b.before.loc) - Math.abs(a.after.loc - a.before.loc),
    );
  for (const file of changes.slice(0, 5)) {
    lines.push(
      `- ${file.file}: LOC ${delta(file.before.loc, file.after.loc)}; complexity ${delta(file.before.complexity, file.after.complexity)}`,
    );
  }
  if (!changes.length) lines.push('- None.');
  lines.push('', 'Target production hotspots (not necessarily changed):');
  for (const fn of after.hotspots.slice(0, 5)) lines.push(`- ${fn.file}:${fn.line} ${fn.name}: ${fn.complexity}`);
  lines.push(
    '',
    `Cache: ${report.cache.hits} reused, ${report.cache.misses} measured; ${report.cache.enabled ? report.cache.directory : 'persistent cache disabled'}`,
  );
  return lines.join('\n');
}

export function parseArgs(args: string[]): Options {
  const options: Options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--staged') options.staged = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--no-cache') options.noCache = true;
    else if (argument === '--from' || argument === '--to' || argument === '--days') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      if (argument === '--days') options.days = Number(value);
      else if (argument === '--from') options.from = value;
      else options.to = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      console.log(
        'Usage: pnpm exec tsx .claude/skills/code-metrics/scripts/compare.ts [--staged | --from REF [--to REF] | --days N [--to REF]] [--json] [--no-cache]',
      );
    } else {
      const options = parseArgs(process.argv.slice(2));
      const report = compare(options);
      console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
    }
  } catch (error) {
    console.error(`Code metrics failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
