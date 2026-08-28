import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from 'ai';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../../db/connection.js';
import { invokeRegisteredTool, listRegisteredTools } from '../../mcp-tools/registry.js';
import type { NativeSkillRegistry } from './skills.js';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_RESULTS = 200;
const MAX_PROCESS_OUTPUT = 128 * 1024;
const MAX_SHELL_TIMEOUT_MS = 120_000;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist']);

function roots(cwd: string, additionalDirectories: string[]): string[] {
  return [cwd, ...additionalDirectories].map((root) => fs.realpathSync(root));
}

function resolveAllowed(input: string, cwd: string, additionalDirectories: string[], forWrite = false): string {
  const candidate = path.resolve(cwd, input);
  const existing = fs.existsSync(candidate);
  let canonical: string;
  if (existing) {
    canonical = fs.realpathSync(candidate);
  } else {
    let ancestor = path.dirname(candidate);
    while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    const realAncestor = fs.realpathSync(ancestor);
    canonical = path.join(realAncestor, path.relative(ancestor, candidate));
  }
  if (
    !roots(cwd, additionalDirectories).some((root) => canonical === root || canonical.startsWith(`${root}${path.sep}`))
  ) {
    throw new Error(`Path is outside the mounted workspace: ${input}`);
  }
  if (forWrite && canonical !== fs.realpathSync(cwd) && !canonical.startsWith(`${fs.realpathSync(cwd)}${path.sep}`)) {
    throw new Error(`Writes are restricted to ${cwd}`);
  }
  return canonical;
}

function walk(root: string): string[] {
  const output: string[] = [];
  const pending = [root];
  while (pending.length > 0 && output.length < MAX_RESULTS * 10) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(filename);
      else if (entry.isFile()) output.push(filename);
    }
  }
  return output;
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

interface ShellResult {
  text: string;
  exitCode: number | null;
}

function runShell(command: string, cwd: string, timeoutMs: number, abortSignal?: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-lc', command], { cwd, detached: true, env: process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const append = (current: string, chunk: Buffer): string =>
      (current + chunk.toString('utf8')).slice(-MAX_PROCESS_OUTPUT);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const stop = (): void => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
    };
    const timer = setTimeout(stop, timeoutMs);
    const onAbort = (): void => stop();
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      const text = [
        stdout && `stdout:\n${stdout}`,
        stderr && `stderr:\n${stderr}`,
        `exit: ${code ?? signal ?? 'unknown'}`,
      ]
        .filter(Boolean)
        .join('\n');
      resolve({ text, exitCode: code });
    });
  });
}

export function createNativeTools(
  cwd: string,
  additionalDirectories: string[] = [],
  skills?: NativeSkillRegistry,
): ToolSet {
  const tools: ToolSet = {};
  for (const definition of listRegisteredTools()) {
    const name = `mcp__nanoclaw__${definition.tool.name}`;
    tools[name] = tool({
      description: definition.tool.description,
      inputSchema: jsonSchema(definition.tool.inputSchema as JSONSchema7),
      execute: async (input) => invokeRegisteredTool(definition.tool.name, input as Record<string, unknown>),
    });
  }

  tools.read_file = tool({
    description: 'Read a UTF-8 text file from a mounted workspace root.',
    inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
    execute: async (input) => {
      const filename = resolveAllowed(String((input as { path: string }).path), cwd, additionalDirectories);
      const stat = fs.statSync(filename);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} byte read limit`);
      return fs.readFileSync(filename, 'utf8');
    },
  });

  tools.write_file = tool({
    description: 'Write a UTF-8 text file under the persistent workspace.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    }),
    execute: async (input) => {
      const args = input as { path: string; content: string };
      const filename = resolveAllowed(args.path, cwd, additionalDirectories, true);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, args.content, 'utf8');
      return `Wrote ${Buffer.byteLength(args.content)} bytes to ${filename}`;
    },
  });

  tools.edit_file = tool({
    description: 'Replace one exact string in a UTF-8 file. Fails unless the old string occurs exactly once.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } },
      required: ['path', 'oldText', 'newText'],
    }),
    execute: async (input) => {
      const args = input as { path: string; oldText: string; newText: string };
      const filename = resolveAllowed(args.path, cwd, additionalDirectories, true);
      const current = fs.readFileSync(filename, 'utf8');
      const first = current.indexOf(args.oldText);
      if (first < 0 || current.indexOf(args.oldText, first + args.oldText.length) >= 0) {
        throw new Error('oldText must occur exactly once');
      }
      fs.writeFileSync(filename, current.replace(args.oldText, args.newText), 'utf8');
      return `Edited ${filename}`;
    },
  });

  tools.apply_patch = tool({
    description: 'Apply a unified diff to files under the persistent workspace.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { patch: { type: 'string' } },
      required: ['patch'],
    }),
    execute: async (input, options) => {
      const patch = String((input as { patch: string }).patch);
      const paths = [...patch.matchAll(/^(?:---|\+\+\+)\s+([^\t\n]+)/gm)]
        .map((match) => match[1])
        .filter((filename) => filename !== '/dev/null')
        .map((filename) => filename.replace(/^[ab]\//, ''));
      if (paths.length === 0) throw new Error('Patch contains no file headers');
      for (const filename of paths) resolveAllowed(filename, cwd, additionalDirectories, true);

      const patchFile = path.join(cwd, `.native-patch-${randomUUID()}.diff`);
      fs.writeFileSync(patchFile, patch, 'utf8');
      try {
        const quoted = JSON.stringify(patchFile);
        const result = await runShell(
          `git apply --check --no-index ${quoted} && git apply --no-index ${quoted}`,
          cwd,
          30_000,
          options.abortSignal,
        );
        if (result.exitCode !== 0) throw new Error(result.text);
        return `Applied patch to ${[...new Set(paths)].join(', ')}`;
      } finally {
        fs.rmSync(patchFile, { force: true });
      }
    },
  });

  tools.glob = tool({
    description: 'List files matching a glob pattern under the persistent workspace.',
    inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }),
    execute: async (input) => {
      const matcher = wildcard(String((input as { pattern: string }).pattern));
      return walk(cwd)
        .map((filename) => path.relative(cwd, filename).replaceAll(path.sep, '/'))
        .filter((filename) => matcher.test(filename))
        .slice(0, MAX_RESULTS)
        .join('\n');
    },
  });

  tools.grep = tool({
    description: 'Search UTF-8 workspace files for a literal string.',
    inputSchema: jsonSchema({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),
    execute: async (input) => {
      const query = String((input as { query: string }).query);
      const matches: string[] = [];
      for (const filename of walk(cwd)) {
        if (matches.length >= MAX_RESULTS) break;
        let text: string;
        try {
          if (fs.statSync(filename).size > MAX_FILE_BYTES) continue;
          text = fs.readFileSync(filename, 'utf8');
        } catch {
          continue;
        }
        for (const [index, line] of text.split('\n').entries()) {
          if (line.includes(query)) matches.push(`${path.relative(cwd, filename)}:${index + 1}:${line}`);
          if (matches.length >= MAX_RESULTS) break;
        }
      }
      return matches.join('\n');
    },
  });

  tools.shell = tool({
    description: 'Run a shell command inside the isolated agent container.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'number', minimum: 1000, maximum: MAX_SHELL_TIMEOUT_MS },
      },
      required: ['command'],
    }),
    execute: async (input, options) => {
      const args = input as { command: string; timeoutMs?: number };
      const timeoutMs = Math.min(Math.max(args.timeoutMs ?? 30_000, 1000), MAX_SHELL_TIMEOUT_MS);
      setContainerToolInFlight('shell', timeoutMs);
      try {
        return (await runShell(args.command, cwd, timeoutMs, options.abortSignal)).text;
      } finally {
        clearContainerToolInFlight();
      }
    },
  });

  if (skills && skills.skills().length > 0) {
    tools.load_skill = tool({
      description: 'Load a selected skill or a text file referenced by that skill before following its workflow.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill slug or declared name from the available-skills index.' },
          path: { type: 'string', description: 'Optional path inside the skill directory. Defaults to SKILL.md.' },
        },
        required: ['name'],
      }),
      execute: async (input) => {
        const args = input as { name: string; path?: string };
        return skills.load(args.name, args.path);
      },
    });
  }

  return tools;
}
