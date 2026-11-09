export interface ApprovalPackageLists {
  apt: string[];
  npm: string[];
  pip: string[];
}

export interface ApprovalPresentation {
  details: string | null;
  packages: ApprovalPackageLists | null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function presentApproval(action: string, payload: Record<string, unknown>): ApprovalPresentation {
  if (action === 'install_packages') {
    const packages = {
      apt: stringArray(payload.apt),
      npm: stringArray(payload.npm),
      pip: stringArray(payload.pip),
    };
    const reason = typeof payload.reason === 'string' && payload.reason ? payload.reason : null;
    return {
      details: reason,
      packages: packages.apt.length || packages.npm.length || packages.pip.length ? packages : null,
    };
  }

  if (action === 'request_access') {
    const url = typeof payload.resource_url === 'string' ? payload.resource_url : '';
    const reason = typeof payload.reason === 'string' ? payload.reason : '';
    const server = typeof payload.mcp_server === 'string' ? `\nTools: ${payload.mcp_server}` : '';
    return { details: `${reason}\n${url}${server}`, packages: null };
  }

  if (action === 'add_mcp_server') {
    const name = typeof payload.name === 'string' ? payload.name : '';
    const url = typeof payload.url === 'string' ? payload.url : '';
    const command = typeof payload.command === 'string' ? payload.command : '';
    if (url) return { details: `${name} tools · ${url}`, packages: null };
    if (command) return { details: `${name} tools · ${command}`, packages: null };
    return { details: name || null, packages: null };
  }

  if (action === 'cli_command') {
    const frame = (payload.frame as Record<string, unknown> | undefined) || undefined;
    if (frame) {
      const cmd = typeof frame.command === 'string' ? frame.command : '';
      const args = (frame.args as Record<string, unknown> | undefined) || {};
      const display = cmd ? presentCliApproval(cmd, args) : null;
      return {
        details: display ? [display.summary, display.command].filter(Boolean).join('\n\n') : null,
        packages: null,
      };
    }
  }

  return { details: null, packages: null };
}
import { presentCliApproval } from '../../../cli/approval-presentation.js';
