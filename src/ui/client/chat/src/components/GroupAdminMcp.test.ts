import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServersSection, type McpServerConfigDto } from './GroupAdminMcp';
import { isMobile } from '../state';
import { MobileDialog } from './MobileDialog';

const hooks = vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  return { slots: [] as unknown[], cursor: 0 };
});
vi.mock('preact/hooks', () => ({
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.slots[index],
      (value: unknown) => {
        hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useEffect: vi.fn(),
}));

interface TestNode {
  type: unknown;
  props: {
    children?: unknown;
    footer?: unknown;
    title?: string;
    connection?: string;
    onChange: (value: McpServerConfigDto) => void;
    onTypeChange: (value: 'stdio' | 'http' | 'sse') => void;
    onNameChange: (value: string) => void;
    onConnectionChange: (value: string) => void;
    onSelect: (name: string) => void;
    onAdd: () => void;
    onRemove: () => void;
    onClick: () => void;
  };
}

function descendants(value: unknown): TestNode[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('props' in value) || !('type' in value)) return [];
  const node = value as TestNode;
  return [node, ...descendants(node.props.children), ...descendants(node.props.footer)];
}
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join('');
  if (!value || typeof value !== 'object' || !('props' in value)) return '';
  return text((value as TestNode).props.children);
}
function component(node: unknown, name: string): TestNode {
  const result = descendants(node).find((child) => typeof child.type === 'function' && child.type.name === name);
  if (!result) throw new Error(`Missing ${name}`);
  return result;
}
function harness(initial: Record<string, McpServerConfigDto>) {
  let value = initial;
  const onChange = vi.fn((next: Record<string, McpServerConfigDto>) => {
    value = next;
  });
  const draw = () => {
    hooks.cursor = 0;
    return McpServersSection({ value, busy: false, onChange, onTest: vi.fn() });
  };
  return { draw, value: () => value };
}
const remote: McpServerConfigDto = {
  type: 'http',
  url: 'https://example.com/mcp',
  headers: { 'X-Keep': 'unchanged' },
  authentication: { connection_id: 'personal', account_alias: 'Personal' },
  instructions: 'Keep',
  timeout: 30000,
};

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  isMobile.value = false;
});

describe('Tools type switching', () => {
  it('keeps the complete website address, including existing query placeholders', () => {
    const config: McpServerConfigDto = { type: 'http', url: 'https://example.com/mcp?api_key=__API_KEY__' };
    const h = harness({ tavily: config });
    component(h.draw(), 'McpServerEditor').props.onTypeChange('stdio');
    component(h.draw(), 'McpServerEditor').props.onTypeChange('http');
    expect(JSON.parse(JSON.stringify(h.value().tavily))).toEqual(config);
  });
  it('preserves remote settings through SSE and STDIO without saving mixed transport fields', () => {
    const h = harness({ tavily: remote });
    const editor = () => component(h.draw(), 'McpServerEditor');
    editor().props.onTypeChange('sse');
    expect(h.value().tavily).toEqual({ ...remote, type: 'sse' });
    editor().props.onTypeChange('stdio');
    expect(h.value().tavily).not.toHaveProperty('url');
    expect(h.value().tavily).not.toHaveProperty('headers');
    expect(h.value().tavily).not.toHaveProperty('authentication');
    editor().props.onChange({
      type: 'stdio',
      command: 'node',
      args: ['tool.js'],
      env: { MODE: 'test' },
      instructions: 'Updated',
      timeout: 60000,
    });
    editor().props.onTypeChange('http');
    expect(h.value().tavily).toEqual({ ...remote, instructions: 'Updated', timeout: 60000 });
    editor().props.onTypeChange('stdio');
    expect(h.value().tavily).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['tool.js'],
      env: { MODE: 'test' },
      instructions: 'Updated',
      timeout: 60000,
    });
  });

  it('does not revive cleared common settings when restoring command arguments and environment', () => {
    const h = harness({
      local: { command: 'node', args: ['tool.js'], env: { MODE: 'test' }, instructions: 'Old', timeout: 30000 },
    });
    const editor = () => component(h.draw(), 'McpServerEditor');
    editor().props.onTypeChange('http');
    editor().props.onChange({ type: 'http', url: 'https://example.com/mcp' });
    editor().props.onTypeChange('stdio');
    expect(JSON.parse(JSON.stringify(h.value().local))).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['tool.js'],
      env: { MODE: 'test' },
    });
  });

  it('keeps each tool draft when selecting a different tool', () => {
    const h = harness({ tavily: remote, other: { command: 'other' } });
    component(h.draw(), 'McpServerEditor').props.onTypeChange('stdio');
    component(h.draw(), 'McpServerList').props.onSelect('other');
    component(h.draw(), 'McpServerList').props.onSelect('tavily');
    component(h.draw(), 'McpServerEditor').props.onTypeChange('http');
    expect(h.value().tavily).toEqual(remote);
    expect(h.value().other).toEqual({ command: 'other' });
  });

  it('clears hidden drafts when a tool is removed and recreated with the same name', () => {
    const h = harness({ tavily: remote });
    component(h.draw(), 'McpServerEditor').props.onTypeChange('stdio');
    component(h.draw(), 'McpServerEditor').props.onRemove();
    descendants(h.draw())
      .find((node) => node.type === 'button' && text(node) === '+ Add tools')!
      .props.onClick();
    component(h.draw(), 'McpAddServerForm').props.onNameChange('tavily');
    component(h.draw(), 'McpAddServerForm').props.onConnectionChange('fresh-command');
    component(h.draw(), 'McpAddServerForm').props.onAdd();
    component(h.draw(), 'McpServerEditor').props.onTypeChange('http');
    expect(JSON.parse(JSON.stringify(h.value().tavily))).toEqual({ type: 'http', url: '' });
  });

  it('preserves command and website entry in the add-tools form across all three buttons', () => {
    const h = harness({});
    descendants(h.draw())
      .find((node) => node.type === 'button' && text(node) === '+ Add tools')!
      .props.onClick();
    const form = () => component(h.draw(), 'McpAddServerForm');
    form().props.onConnectionChange('node local-tool');
    form().props.onTypeChange('http');
    form().props.onConnectionChange('https://example.com/mcp');
    form().props.onTypeChange('sse');
    expect(form().props.connection).toBe('https://example.com/mcp');
    form().props.onTypeChange('stdio');
    expect(form().props.connection).toBe('node local-tool');
    form().props.onTypeChange('http');
    expect(form().props.connection).toBe('https://example.com/mcp');
  });

  it('names the tool in its removal button, dialog and confirmation', () => {
    const h = harness({ tavily: remote });
    const editor = component(h.draw(), 'McpServerEditor');
    hooks.slots = [];
    const draw = () => {
      hooks.cursor = 0;
      return (editor.type as (props: TestNode['props']) => TestNode)(editor.props);
    };
    descendants(draw())
      .find((node) => node.type === 'button' && text(node) === 'Remove tavily tools…')!
      .props.onClick();
    const dialog = descendants(draw()).find((node) => node.type === MobileDialog)!;
    expect(dialog.props.title).toBe('Remove tavily tools?');
    expect(descendants(dialog).some((node) => node.type === 'button' && text(node) === 'Remove tavily tools')).toBe(
      true,
    );
  });
});
