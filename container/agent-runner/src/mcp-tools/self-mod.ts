/**
 * Self-modification MCP tools: install_packages, add_mcp_server.
 *
 * Both are fire-and-forget — the tool writes a system action row and returns
 * immediately. The host processes the request (including admin approval)
 * and notifies the agent via a chat message when complete. Admin approval
 * is approval to apply the change: `install_packages` auto-rebuilds the
 * per-agent image and restarts the container; `add_mcp_server` just
 * updates `container.json` and restarts (bun runs TS directly — no build
 * step needed for a pure MCP wiring change).
 *
 * Package names are sanitized here at the tool boundary AND re-validated on
 * the host side (defense in depth).
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './tool-registry.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
// Allow optional PEP 440 version specifier (e.g. "yt-dlp", "yt-dlp==2024.12.13",
// "requests>=2.31,<3"). No shell metacharacters, no URLs, no extras with brackets.
const PIP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:[<>=!~]=?[A-Za-z0-9._*+!-]+(?:,[<>=!~]=?[A-Za-z0-9._*+!-]+)*)?$/;
const MAX_PACKAGES = 20;

export const installPackages: McpToolDefinition = {
  tool: {
    name: 'install_packages',
    description:
      'Install apt, npm, and/or pip packages into YOUR per-agent container image. Prefer `pip` for Python CLIs (yt-dlp, etc.) since the apt versions are usually stale. Requires admin approval; fire-and-forget. On approval, the image is rebuilt and the container is restarted automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        apt: { type: 'array', items: { type: 'string' }, description: 'apt packages to install (names only, no version specs or flags)' },
        npm: { type: 'array', items: { type: 'string' }, description: 'npm packages to install globally (names only, no version specs)' },
        pip: { type: 'array', items: { type: 'string' }, description: 'pip packages to install into the shared venv. Names or PEP 440 version specs allowed (e.g. "yt-dlp" or "yt-dlp==2024.12.13"). Prefer this over apt for Python tools.' },
        reason: { type: 'string', description: 'Why these packages are needed' },
      },
    },
  },
  async handler(args) {
    const apt = (args.apt as string[]) || [];
    const npm = (args.npm as string[]) || [];
    const pip = (args.pip as string[]) || [];
    if (apt.length === 0 && npm.length === 0 && pip.length === 0) return err('At least one apt, npm, or pip package is required');
    if (apt.length + npm.length + pip.length > MAX_PACKAGES) return err(`Maximum ${MAX_PACKAGES} packages per request`);

    const invalidApt = apt.find((p) => !APT_RE.test(p));
    if (invalidApt) return err(`Invalid apt package name: "${invalidApt}". Only lowercase letters, digits, and ._+- allowed.`);
    const invalidNpm = npm.find((p) => !NPM_RE.test(p));
    if (invalidNpm) return err(`Invalid npm package name: "${invalidNpm}". No version specs or shell characters.`);
    const invalidPip = pip.find((p) => !PIP_RE.test(p));
    if (invalidPip) return err(`Invalid pip package spec: "${invalidPip}". Name plus optional PEP 440 version (e.g. "yt-dlp" or "yt-dlp==2024.12.13").`);

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'install_packages',
        apt,
        npm,
        pip,
        reason: (args.reason as string) || '',
      }),
    });

    log(`install_packages: ${requestId} → apt=[${apt.join(',')}] npm=[${npm.join(',')}] pip=[${pip.join(',')}]`);
    return ok(`Package install request submitted. You will be notified when admin approves or rejects.`);
  },
};

export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description:
      'Wire a third-party MCP server into YOUR per-agent runtime config. Either a stdio server (provide `command` + optional `args`/`env`, e.g. `npx @modelcontextprotocol/server-github`) or a remote HTTP/SSE server (provide `url` + optional `headers` + optional `transport: "http" | "sse"`, default `http`). Requires admin approval; fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'MCP server name (unique identifier)' },
        command: { type: 'string', description: 'Stdio: command to run the MCP server' },
        args: { type: 'array', items: { type: 'string' }, description: 'Stdio: command arguments' },
        env: { type: 'object', description: 'Stdio: environment variables for the server' },
        url: { type: 'string', description: 'Remote: HTTP/SSE endpoint URL' },
        headers: { type: 'object', description: 'Remote: HTTP headers (e.g. Authorization)' },
        transport: { type: 'string', enum: ['http', 'sse'], description: 'Remote: transport type, default "http"' },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    const command = args.command as string | undefined;
    const url = args.url as string | undefined;
    if (!name) return err('name is required');
    if (!command && !url) return err('either command (stdio) or url (remote) is required');
    if (command && url) return err('provide either command (stdio) or url (remote), not both');

    const requestId = generateId();
    const payload: Record<string, unknown> = {
      action: 'add_mcp_server',
      name,
    };
    if (url) {
      const transport = (args.transport as string) === 'sse' ? 'sse' : 'http';
      payload.url = url;
      payload.transport = transport;
      if (args.headers) payload.headers = args.headers as Record<string, string>;
    } else {
      payload.command = command;
      payload.args = (args.args as string[]) || [];
      payload.env = (args.env as Record<string, string>) || {};
    }
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify(payload),
    });

    log(`add_mcp_server: ${requestId} → "${name}" (${url ? `remote ${url}` : `stdio ${command}`})`);
    return ok(`MCP server request submitted. You will be notified when admin approves or rejects.`);
  },
};

registerTools([installPackages, addMcpServer]);
