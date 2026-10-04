import { describe, expect, it } from 'bun:test';
import { listRegisteredTools } from '../mcp-tools/registry.js';
import { BUILTIN_ACTIVITY_INPUTS, builtinToolResultError, toolActivityFields } from './tool-activity.js';
import { formatClaudeToolUse } from './claude.js';

const examples: Array<[string, Record<string, unknown>, { detail: string; description?: string }]> = [
  ['send_message', { to: 'alice', text: 'private body' }, { detail: 'alice' }],
  ['send_file', { to: 'alice', paths: ['a.pdf', 'b.png'], filename: 'report.pdf' }, { detail: 'a.pdf, b.png', description: 'To: alice\nFilename: report.pdf' }],
  ['edit_message', { messageId: 'message-1', text: 'private body' }, { detail: 'message-1' }],
  ['add_reaction', { messageId: 'message-1', emoji: ':heart:' }, { detail: ':heart:', description: 'Message: message-1' }],
  ['send_email', { to: 'alice@example.test', subject: ' \nReport <literal>\n ', body: 'private body', files: ['a.pdf'] }, { detail: 'alice@example.test', description: 'Subject:  \nReport <literal>\n \nAttachments: a.pdf' }],
  ['ask_user_question', { question: 'Which?\n<literal>', title: 'Choose', responseMode: 'choice', options: [{ label: 'First', value: 'private value' }] }, { detail: 'Which?\n<literal>', description: 'Title: Choose\nResponse mode: choice\nOptions: First' }],
  ['send_card', { card: { title: 'Review', actions: [{ label: 'Approve', url: 'private URL' }], body: 'private body' } }, { detail: 'Review', description: 'Actions: Approve' }],
  ['schedule_task', { processAfter: '2026-10-06T12:00:00Z', prompt: 'Check updates', recurrence: '0 12 * * *', script: 'private code' }, { detail: '2026-10-06T12:00:00Z', description: 'Prompt: Check updates\nRecurrence: 0 12 * * *' }],
  ['list_tasks', { status: 'pending' }, { detail: 'pending' }],
  ['update_task', { taskId: 'task-1', prompt: 'Check updates', processAfter: 'noon', recurrence: 'daily' }, { detail: 'task-1', description: 'Prompt: Check updates\nFirst run: noon\nRecurrence: daily' }],
  ['cancel_task', { taskId: 'task-1' }, { detail: 'task-1' }],
  ['pause_task', { taskId: 'task-1' }, { detail: 'task-1' }],
  ['resume_task', { taskId: 'task-1' }, { detail: 'task-1' }],
  ['create_agent', { name: 'Research', instructions: 'private instructions' }, { detail: 'Research' }],
  ['add_agent_destination', { local_name: 'research', target_group_id: 'group-1', also_reverse: false, reverse_local_name: 'home' }, { detail: 'research', description: 'Agent group: group-1\nReverse link: false\nReverse name: home' }],
  ['install_packages', { apt: ['ffmpeg'], npm: ['vercel@1.0.0'], pip: ['yt-dlp'], reason: 'Convert media' }, { detail: 'ffmpeg, vercel@1.0.0, yt-dlp', description: 'APT: ffmpeg\nnpm: vercel@1.0.0\npip: yt-dlp\nReason: Convert media' }],
  ['add_mcp_server', { name: 'search', transport: 'http', env: { TOKEN: 'private token' }, headers: { Authorization: 'private token' }, command: 'private command', args: ['private arg'], url: 'private URL' }, { detail: 'search', description: 'Transport: http' }],
  ['set_thread_title', { title: 'A useful title' }, { detail: 'A useful title' }],
  ['request_login_link', { userId: 'user-1' }, { detail: 'user-1' }],
  ['mint_file_link', { userId: 'user-1', path: 'report.pdf', ttlMinutes: 5, uses: 1 }, { detail: 'report.pdf', description: 'Recipient: user-1\nLifetime (minutes): 5\nUses: 1' }],
];

describe('builtin tool activity capture', () => {
  it('covers every actual registered tool with a fixture and a capture declaration', () => {
    const names = listRegisteredTools().map((definition) => definition.tool.name).sort();
    expect([...BUILTIN_ACTIVITY_INPUTS.keys()].sort()).toEqual(names);
    expect(examples.map(([name]) => name).sort()).toEqual(names);
  });

  it.each(examples)('captures only allowlisted %s input in every provider namespace', (name, input, fields) => {
    for (const prefix of ['mcp__nanoclaw__', 'nanoclaw.', 'nanoclaw_', 'nanoclaw__']) {
      expect(toolActivityFields(prefix + name, { ...input, url: 'private URL', body: 'private body' })).toEqual(fields);
    }
    expect(formatClaudeToolUse('call-1', `mcp__nanoclaw__${name}`, input)).toEqual({
      kind: 'tool', id: 'call-1', tool: `mcp__nanoclaw__${name}`, status: 'running', ...fields,
    });
  });

  it('never substitutes bodies, prompts or titles for missing builtin arguments', () => {
    expect(toolActivityFields('nanoclaw.send_email', { body: 'private', title: 'unrelated' })).toEqual({});
    expect(toolActivityFields('nanoclaw.send_file', { path: 'a.pdf' })).toEqual({ detail: 'a.pdf' });
    expect(toolActivityFields('nanoclaw.send_message', { text: 'private', prompt: 'unrelated' })).toEqual({});
    expect(toolActivityFields('nanoclaw.list_tasks', {})).toEqual({});
  });

  it('preserves generic capture without specializing foreign tools', () => {
    expect(toolActivityFields('other.send_email', { to: 'alice', subject: 'report', query: 'find report' }))
      .toEqual({ detail: 'find report' });
    expect(toolActivityFields('bash', { command: 'echo one\necho two' })).toEqual({ detail: 'echo one\necho two' });
    expect(toolActivityFields('todo', { todos: [{ content: 'Verify', status: 'pending' }] }))
      .toEqual({ detail: 'Pending: Verify' });
  });

  it('classifies actual MCP failures without exposing successful result contents', () => {
    const output = { isError: true, content: [{ type: 'text', text: 'Not permitted' }] };
    expect(builtinToolResultError('mcp__nanoclaw__send_email', output)).toBe('Not permitted');
    expect(builtinToolResultError('nanoclaw.send_email', { isError: true })).toBe('Tool reported an error');
    expect(builtinToolResultError('nanoclaw.send_email', { ...output, isError: false })).toBeUndefined();
    expect(builtinToolResultError('other.send_email', output)).toBeUndefined();
  });
});
