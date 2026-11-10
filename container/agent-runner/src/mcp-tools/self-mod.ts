/**
 * Self-modification MCP tools: install_packages, add_mcp_server.
 *
 * Both are fire-and-forget — the tool writes a system action row and returns
 * immediately. The host processes the request (including admin approval)
 * and notifies the agent via a chat message when complete. Admin approval
 * is approval to apply the change: `install_packages` auto-rebuilds the
 * per-agent image and restarts after the current response; `add_mcp_server`
 * just updates `container.json` and defers the restart too (no build
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
      'Install apt, npm, and/or pip packages into YOUR per-agent container image. Prefer `pip` for Python CLIs (yt-dlp, etc.) since the apt versions are usually stale. Requires admin approval; fire-and-forget. On approval, the image is rebuilt. The container restarts automatically after the current response finishes, then you can verify the new packages.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        apt: {
          type: 'array',
          items: { type: 'string' },
          description: 'apt packages to install (names only, no version specs or flags)',
        },
        npm: {
          type: 'array',
          items: { type: 'string' },
          description: 'npm packages to install globally (names only, no version specs)',
        },
        pip: {
          type: 'array',
          items: { type: 'string' },
          description:
            'pip packages to install into the shared venv. Names or PEP 440 version specs allowed (e.g. "yt-dlp" or "yt-dlp==2024.12.13"). Prefer this over apt for Python tools.',
        },
        reason: { type: 'string', description: 'Why these packages are needed' },
      },
    },
  },
  async handler(args) {
    const apt = (args.apt as string[]) || [];
    const npm = (args.npm as string[]) || [];
    const pip = (args.pip as string[]) || [];
    if (apt.length === 0 && npm.length === 0 && pip.length === 0)
      return err('At least one apt, npm, or pip package is required');
    if (apt.length + npm.length + pip.length > MAX_PACKAGES) return err(`Maximum ${MAX_PACKAGES} packages per request`);

    const invalidApt = apt.find((p) => !APT_RE.test(p));
    if (invalidApt)
      return err(`Invalid apt package name: "${invalidApt}". Only lowercase letters, digits, and ._+- allowed.`);
    const invalidNpm = npm.find((p) => !NPM_RE.test(p));
    if (invalidNpm) return err(`Invalid npm package name: "${invalidNpm}". No version specs or shell characters.`);
    const invalidPip = pip.find((p) => !PIP_RE.test(p));
    if (invalidPip)
      return err(
        `Invalid pip package spec: "${invalidPip}". Name plus optional PEP 440 version (e.g. "yt-dlp" or "yt-dlp==2024.12.13").`,
      );

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'install_packages',
        requestId,
        apt,
        npm,
        pip,
        reason: (args.reason as string) || '',
      }),
    });

    log(`install_packages: ${requestId} → apt=[${apt.join(',')}] npm=[${npm.join(',')}] pip=[${pip.join(',')}]`);
    return ok(`Package install request ${requestId} submitted. You will be notified when admin approves or rejects. If no longer needed, use ncl approvals withdraw --id ${requestId}.`);
  },
};

export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description:
      'The only agent-facing way to add a third-party MCP server to YOUR own runtime. Supports stdio (command, args/env) and remote HTTP/SSE (url, optional transport, default http). Discover servers at https://registry.modelcontextprotocol.io/ or https://mcp.so, then verify publisher documentation. Requires admin approval; submission is not installation. Submit once, tell the user approval is pending, and FINISH THE TURN so the automatic restart can occur. Do not resubmit, use ncl groups config add-mcp-server, or request_access for the new server until approval and restart complete. Never supply raw secrets.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'MCP server name (unique identifier)' },
        command: { type: 'string', description: 'Stdio: command to run the MCP server' },
        args: { type: 'array', items: { type: 'string' }, description: 'Stdio: command arguments' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Stdio: nonsecret environment variables or existing approved credential placeholders, never raw secrets',
        },
        url: { type: 'string', description: 'Remote: HTTP/SSE endpoint URL' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Remote: documented nonsecret headers. Do not construct authentication or binding headers; use request_access after approval and restart.',
        },
        authentication: {
          type: 'object',
          description: 'Remote: approved connection reference; never a token or binding handle.',
          properties: { connection_id: { type: 'string' }, account_alias: { type: 'string' } },
          required: ['connection_id', 'account_alias'],
          additionalProperties: false,
        },
        transport: { type: 'string', enum: ['http', 'sse'], description: 'Remote: transport type, default "http"' },
        instructions: { type: 'string', description: 'Optional usage instructions for this server' },
        timeout: {
          type: 'integer',
          minimum: 1000,
          maximum: 600000,
          description: 'Optional tool timeout in milliseconds',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const { name, command, url } = args;
    if (
      Object.keys(args).some(
        (key) =>
          ![
            'name',
            'command',
            'args',
            'env',
            'url',
            'headers',
            'authentication',
            'transport',
            'instructions',
            'timeout',
          ].includes(key),
      )
    )
      return err(
        'Only add MCP servers to yourself using the documented arguments; target agent overrides are not supported.',
      );
    if (typeof name !== 'string' || !name.trim()) return err('name is required');
    if (command !== undefined && (typeof command !== 'string' || !command.trim()))
      return err('command must be nonempty text');
    if (url !== undefined && (typeof url !== 'string' || !url.trim())) return err('url must be nonempty text');
    if (!command && !url) return err('either command (stdio) or url (remote) is required');
    if (command && url) return err('provide either command (stdio) or url (remote), not both');
    if (args.authentication !== undefined && !url) return err('authentication references require HTTP/SSE transport');
    if (args.transport !== undefined && (!url || (args.transport !== 'http' && args.transport !== 'sse')))
      return err('transport must be http or sse for a remote server');
    if (url && (args.args !== undefined || args.env !== undefined)) return err('args and env are only valid for stdio');
    if (!url && args.headers !== undefined) return err('headers require HTTP/SSE transport');
    if (args.args !== undefined && (!Array.isArray(args.args) || !args.args.every((item) => typeof item === 'string')))
      return err('args must be an array of strings');
    for (const key of ['env', 'headers']) {
      const value = args[key];
      if (
        value !== undefined &&
        (!value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          !Object.values(value).every((item) => typeof item === 'string'))
      )
        return err(`${key} must be an object of strings`);
    }
    if (args.instructions !== undefined && typeof args.instructions !== 'string')
      return err('instructions must be text');
    if (
      args.timeout !== undefined &&
      (typeof args.timeout !== 'number' ||
        !Number.isInteger(args.timeout) ||
        args.timeout < 1000 ||
        args.timeout > 600000)
    )
      return err('timeout must be an integer between 1000 and 600000 milliseconds');

    const requestId = generateId();
    const payload: Record<string, unknown> = {
      action: 'add_mcp_server',
      name,
    };
    if (url) {
      const transport = args.transport ?? 'http';
      payload.url = url;
      payload.transport = transport;
      if (args.headers) payload.headers = args.headers;
      if (args.authentication) payload.authentication = args.authentication;
    } else {
      payload.command = command;
      if (args.args !== undefined) payload.args = args.args;
      if (args.env !== undefined) payload.env = args.env;
    }
    if (args.instructions !== undefined) payload.instructions = args.instructions;
    if (args.timeout !== undefined) payload.timeout = args.timeout;
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ ...payload, requestId }),
    });

    log(`add_mcp_server: ${requestId} → "${name}" (${url ? `remote ${url}` : `stdio ${command}`})`);
    return ok(
      `MCP server addition ${requestId} submitted for admin approval; the server is not installed yet. Do not resubmit or switch to the CLI. Tell the user approval is pending and finish this turn. After approval and the automatic restart, request_access for the configured server if credentials are needed, then verify its tools. If no longer needed, use ncl approvals withdraw --id ${requestId}.`,
    );
  },
};

registerTools([installPackages, addMcpServer]);
