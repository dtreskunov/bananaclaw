import { pickActivityDetail } from './types.js';

type InputFields = readonly [
  primary: readonly string[],
  extra: ReadonlyArray<readonly [label: string, path: string]>,
];

export const BUILTIN_ACTIVITY_INPUTS = new Map<string, InputFields>([
  ['send_message', [['to'], []]],
  ['send_file', [['paths', 'path'], [['To', 'to'], ['Filename', 'filename']]]],
  ['edit_message', [['messageId'], []]],
  ['add_reaction', [['emoji'], [['Message', 'messageId']]]],
  ['send_email', [['to'], [['Subject', 'subject'], ['Attachments', 'files']]]],
  ['ask_user_question', [['question'], [['Title', 'title'], ['Response mode', 'responseMode'], ['Options', 'options']]]],
  ['send_card', [['card.title'], [['Actions', 'card.actions']]]],
  ['schedule_task', [['processAfter'], [['Prompt', 'prompt'], ['Recurrence', 'recurrence']]]],
  ['list_tasks', [['status'], []]],
  ['update_task', [['taskId'], [['Prompt', 'prompt'], ['First run', 'processAfter'], ['Recurrence', 'recurrence']]]],
  ['cancel_task', [['taskId'], []]],
  ['pause_task', [['taskId'], []]],
  ['resume_task', [['taskId'], []]],
  ['create_agent', [['name'], []]],
  ['add_agent_destination', [['local_name'], [['Agent group', 'target_group_id'], ['Reverse link', 'also_reverse'], ['Reverse name', 'reverse_local_name']]]],
  ['install_packages', [['apt', 'npm', 'pip'], [['APT', 'apt'], ['npm', 'npm'], ['pip', 'pip'], ['Reason', 'reason']]]],
  ['add_mcp_server', [['name'], [['Transport', 'transport']]]],
  ['set_thread_title', [['title'], []]],
  ['request_login_link', [['userId'], []]],
  ['mint_file_link', [['path'], [['Recipient', 'userId'], ['Lifetime (minutes)', 'ttlMinutes'], ['Uses', 'uses']]]],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function builtinName(tool: string): string | undefined {
  const name = tool.toLowerCase();
  if (name.startsWith('mcp__nanoclaw__')) return name.slice('mcp__nanoclaw__'.length);
  if (name.startsWith('nanoclaw.')) return name.slice('nanoclaw.'.length);
  if (name.startsWith('nanoclaw_')) return name.slice('nanoclaw_'.length).replace(/^_/, '');
  return undefined;
}

function inputValue(input: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => isRecord(value) ? value[key] : undefined, input);
}

function displayValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const labels = value.flatMap((item) => {
      const label = typeof item === 'string' ? item : isRecord(item) && typeof item.label === 'string' ? item.label : '';
      return label.trim() ? [label] : [];
    });
    return labels.length ? labels.join(', ') : undefined;
  }
  return undefined;
}

/** Capture only declared display metadata, never bodies, credentials or generated links. */
export function toolActivityFields(tool: string, input: unknown): { detail?: string; description?: string } {
  const name = builtinName(tool);
  const fields = name ? BUILTIN_ACTIVITY_INPUTS.get(name) : undefined;
  if (!fields) {
    const detail = pickActivityDetail(isRecord(input) ? input : undefined);
    return detail ? { detail } : {};
  }
  const [primary, extra] = fields;
  const values = primary.map((key) => displayValue(inputValue(input, key)));
  const detail = name === 'install_packages' ? values.filter(Boolean).join(', ') : values.find(Boolean);
  const description = extra.flatMap(([label, path]) => {
    const value = displayValue(inputValue(input, path));
    return value === undefined ? [] : [`${label}: ${value}`];
  }).join('\n');
  return { ...(detail ? { detail } : {}), ...(description ? { description } : {}) };
}

/** MCP errors are returned values, not necessarily thrown SDK tool errors. */
export function builtinToolResultError(tool: string, output: unknown): string | undefined {
  if (!BUILTIN_ACTIVITY_INPUTS.has(builtinName(tool) ?? '') || !isRecord(output) || output.isError !== true)
    return undefined;
  const messages = Array.isArray(output.content) ? output.content.flatMap((item) =>
    isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? [item.text] : []) : [];
  return messages.join('\n') || 'Tool reported an error';
}
