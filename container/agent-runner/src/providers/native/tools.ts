import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from 'ai';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../../db/connection.js';
import { invokeRegisteredTool, listRegisteredTools } from '../../mcp-tools/registry.js';
import type { NativeSkillRegistry } from './skills.js';
import { NativeTodoState, type NativeTodo } from './todos.js';
import { createNativeMediaTools, createNativeMediaBudget, type NativeMediaToolOptions } from './media.js';
import type { NativeToolOutcome } from '../tool-activity.js';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_RESULTS = 200;
const MAX_PROCESS_OUTPUT = 128 * 1024;
const MAX_SHELL_TIMEOUT_MS = 600_000;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist']);

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

interface ShellResult extends NativeToolOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

function runShell(command: string, cwd: string, timeoutMs: number, abortSignal?: AbortSignal): Promise<ShellResult> {
  abortSignal?.throwIfAborted();
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-lc', command], { cwd, detached: true, env: process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let interruption: string | undefined;
    const append = (current: string, chunk: Buffer): string =>
      (current + chunk.toString('utf8')).slice(-MAX_PROCESS_OUTPUT);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const stop = (reason: string): void => {
      if (interruption) return;
      interruption = reason;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        killTimer = setTimeout(() => {
          if (child.pid) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          }
        }, 1000);
      }
    };
    const timer = setTimeout(() => stop(`Command timed out after ${timeoutMs / 1000}s`), timeoutMs);
    const onAbort = (): void => stop('Command cancelled');
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    const finish = (result: ShellResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    child.on('error', (error) => finish({
      status: 'error', stdout, stderr, exitCode: null, signal: null, error: error.message,
    }));
    child.on('close', (code, signal) => {
      const error = interruption ? `${interruption}; outcome unknown.` :
        signal ? `Command terminated by ${signal}; outcome unknown.` :
        code !== 0 ? `Command exited with ${code ?? 'unknown status'}` : undefined;
      finish({
        status: interruption === 'Command cancelled' ? 'interrupted' :
          interruption || signal || code === null ? 'unknown' : code === 0 ? 'completed' : 'error',
        stdout, stderr, exitCode: code, signal, ...(error ? { error } : {}),
      });
    });
  });
}

export function createNativeTools(
  cwd: string,
  skills?: NativeSkillRegistry,
  todoState?: NativeTodoState,
  mediaOptions?: NativeMediaToolOptions,
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

  tools.read = tool({
    description: 'Read UTF-8 text. Use startLine (1-based) and lineCount (at most 200) for bounded ranges of large files. Paths may be absolute or workspace-relative.',
    inputSchema: jsonSchema({ type: 'object', properties: {
      path: { type: 'string' },
      startLine: { type: 'integer', minimum: 1 },
      lineCount: { type: 'integer', minimum: 1, maximum: 200 },
    }, required: ['path'] }),
    execute: async (input) => {
      const { path: file, startLine, lineCount } = input as { path: string; startLine?: number; lineCount?: number };
      const filename = path.resolve(cwd, file);
      if (startLine !== undefined || lineCount !== undefined) {
        if (fs.statSync(filename).size > 16 * 1024 * 1024)
          throw new Error('Ranged reads support files up to 16 MiB; query larger files with bash');
        const start = startLine ?? 1, count = lineCount ?? 200;
        if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 200)
          throw new Error('startLine must be a positive integer; lineCount must be between 1 and 200');
        const stream = fs.createReadStream(filename, { encoding: 'utf8' });
        const reader = createInterface({ input: stream, crlfDelay: Infinity });
        const selected: string[] = [];
        let line = 0, bytes = 0;
        try {
          for await (const text of reader) {
            if (++line < start) continue;
            bytes += Buffer.byteLength(text) + 1;
            if (bytes > MAX_FILE_BYTES)
              throw new Error('Selected range exceeds the read limit; use fewer lines or query the file with bash');
            selected.push(text);
            if (selected.length === count) break;
          }
        } finally { reader.close(); stream.destroy(); }
        if (!selected.length) throw new Error('startLine is beyond the end of the file');
        return selected.join('\n');
      }
      const stat = fs.statSync(filename);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} byte read limit`);
      return fs.readFileSync(filename, 'utf8');
    },
  });

  if (mediaOptions) {
    const budget = createNativeMediaBudget(mediaOptions.maxInlineBytes);
    Object.assign(tools, createNativeMediaTools(cwd, mediaOptions.model, budget, mediaOptions.onMediaPressure));
  }

  tools.write = tool({
    description: 'Write a UTF-8 text file inside the agent container. Paths may be absolute or relative to the workspace.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    }),
    execute: async (input) => {
      const args = input as { path: string; content: string };
      const filename = path.resolve(cwd, args.path);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, args.content, 'utf8');
      return `Wrote ${Buffer.byteLength(args.content)} bytes to ${filename}`;
    },
  });

  tools.edit = tool({
    description: 'Replace one exact string in a UTF-8 file. Paths may be absolute or relative to the workspace. Fails unless the old string occurs exactly once.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } },
      required: ['path', 'oldText', 'newText'],
    }),
    execute: async (input) => {
      const args = input as { path: string; oldText: string; newText: string };
      const filename = path.resolve(cwd, args.path);
      const current = fs.readFileSync(filename, 'utf8');
      const first = current.indexOf(args.oldText);
      if (first < 0 || current.indexOf(args.oldText, first + args.oldText.length) >= 0) {
        throw new Error('oldText must occur exactly once');
      }
      fs.writeFileSync(filename, current.replace(args.oldText, args.newText), 'utf8');
      return `Edited ${filename}`;
    },
  });

  tools.patch = tool({
    description: 'Apply a Git-style unified diff inside the agent container, using a/ and b/ file headers. Paths after those prefixes may be absolute or relative to the workspace.',
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

      const patchFile = path.join(cwd, `.native-patch-${randomUUID()}.diff`);
      fs.writeFileSync(patchFile, patch, 'utf8');
      try {
        const quoted = JSON.stringify(patchFile);
        // Disable repository discovery so a nested working directory cannot filter out patch paths.
        const apply = 'git --git-dir=/dev/null apply --no-index --unsafe-paths';
        const result = await runShell(
          `${apply} --check ${quoted} && ${apply} ${quoted}`,
          cwd,
          30_000,
          options.abortSignal,
        );
        if (result.status !== 'completed')
          throw new Error([result.error, result.stdout, result.stderr].filter(Boolean).join('\n'));
        return `Applied patch to ${[...new Set(paths)].join(', ')}`;
      } finally {
        fs.rmSync(patchFile, { force: true });
      }
    },
  });

  tools.glob = tool({
    description: 'List files matching a glob pattern. Defaults to the workspace; an optional directory path can select another search root. Results are relative to that directory.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Directory to search, absolute or relative to the workspace. Defaults to the workspace.' },
      },
      required: ['pattern'],
    }),
    execute: async (input) => {
      const args = input as { pattern: string; path?: string };
      const directory = path.resolve(cwd, args.path ?? '.');
      const matcher = wildcard(String(args.pattern));
      return walk(directory)
        .map((filename) => path.relative(directory, filename).replaceAll(path.sep, '/'))
        .filter((filename) => matcher.test(filename))
        .slice(0, MAX_RESULTS)
        .join('\n');
    },
  });

  tools.grep = tool({
    description: 'Search UTF-8 files for a literal string. Defaults to the workspace; an optional directory path can select another search root. Result paths are relative to that directory.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string', description: 'Directory to search, absolute or relative to the workspace. Defaults to the workspace.' },
      },
      required: ['query'],
    }),
    execute: async (input) => {
      const args = input as { query: string; path?: string };
      const directory = path.resolve(cwd, args.path ?? '.');
      const query = String(args.query);
      const matches: string[] = [];
      for (const filename of walk(directory)) {
        if (matches.length >= MAX_RESULTS) break;
        let text: string;
        try {
          if (fs.statSync(filename).size > MAX_FILE_BYTES) continue;
          text = fs.readFileSync(filename, 'utf8');
        } catch {
          continue;
        }
        for (const [index, line] of text.split('\n').entries()) {
          if (line.includes(query)) matches.push(`${path.relative(directory, filename)}:${index + 1}:${line}`);
          if (matches.length >= MAX_RESULTS) break;
        }
      }
      return matches.join('\n');
    },
  });

  tools.bash = tool({
    description: 'Run a shell command inside the isolated agent container.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Maximum runtime in milliseconds (default: 30000).', minimum: 1000, maximum: MAX_SHELL_TIMEOUT_MS },
      },
      required: ['command'],
    }),
    execute: async (input, options) => {
      const args = input as { command: string; timeoutMs?: number };
      const timeoutMs = Math.min(Math.max(args.timeoutMs ?? 30_000, 1000), MAX_SHELL_TIMEOUT_MS);
      setContainerToolInFlight('bash', timeoutMs);
      try {
        return await runShell(args.command, cwd, timeoutMs, options.abortSignal);
      } finally {
        clearContainerToolInFlight();
      }
    },
    toModelOutput: ({ output }) => ({
      type: output.status === 'completed' ? 'json' : 'error-json',
      value: {
        status: output.status, exitCode: output.exitCode, signal: output.signal,
        ...(output.error ? { error: output.error } : {}),
        stdout: output.stdout, stderr: output.stderr,
      },
    }),
  });

  if (todoState) {
    tools.todowrite = tool({
      description: 'Create or update the compact checklist for this turn. Send the complete current list.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['id', 'content', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['todos'],
        additionalProperties: false,
      }),
      execute: async (input) => todoState.update((input as { todos: NativeTodo[] }).todos),
    });
    tools.todoread = tool({
      description: 'Read the current in-turn checklist when its state is no longer visible in recent tool results.',
      inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
      execute: async () => todoState.snapshot(),
    });
  }

  if (skills && skills.skills().length > 0) {
    tools.skill = tool({
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
