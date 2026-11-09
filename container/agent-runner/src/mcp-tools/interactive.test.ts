import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { sendCard } from './interactive.js';
import { listRegisteredTools } from './registry.js';

it('offers Markdown replies without registering a suggestion tool', () => {
  expect(listRegisteredTools().some(({ tool }) => tool.name === 'suggest_responses')).toBe(false);
  const instructions = readFileSync(new URL('./interactive.instructions.md', import.meta.url), 'utf8');
  expect(instructions).toContain('[Fix references](reply:)');
  expect(instructions).toContain('The visible label is the exact message sent or drafted');
  expect(instructions).toContain('No tool call is needed');
  expect(instructions).toContain('the end of the message');
  expect(instructions).not.toContain('suggest_responses');
  expect(instructions).not.toContain('ask_user_question');
  expect(sendCard.tool.inputSchema.required).toEqual(['card']);
});
