import type { ModelMessage, ToolSet } from 'ai';
import { NativeStore } from './store.js';
import type { ActivityStep } from '../types.js';

export const INTERRUPTED_TOOL =
  'Interrupted; outcome unknown. External side effects may have occurred. Do not retry without checking.';

/** Persist input and valid call/result pairs even before an SDK step finishes. */
export class NativeTurnJournal {
  private readonly calls = new Map<string, { name: string; input: unknown; output: unknown; failed: boolean }>();
  private readonly executions = new Set<Promise<unknown>>();
  private text = '';
  private anchor: string;
  checkpoint: string;

  constructor(
    private store: NativeStore,
    private conversation: string,
    incoming: ModelMessage,
  ) {
    this.anchor = this.checkpoint = store.append(conversation, [incoming]);
  }

  wrap(tools: ToolSet, signal: AbortSignal): ToolSet {
    return Object.fromEntries(
      Object.entries(tools).map(([name, definition]) => {
        const execute = definition.execute;
        if (!execute) return [name, definition];
        return [
          name,
          {
            ...definition,
            execute: (input: unknown, options: Parameters<NonNullable<typeof execute>>[1]) => {
              signal.throwIfAborted();
              const call = { name, input, output: INTERRUPTED_TOOL as unknown, failed: true };
              this.calls.set(options.toolCallId, call);
              this.save();
              const execution = (async () => {
                try {
                  const result = await execute(input, { ...options, abortSignal: signal });
                  call.output = result;
                  call.failed = false;
                  return result;
                } catch (error) {
                  call.output = signal.aborted ? INTERRUPTED_TOOL : String(error);
                  throw error;
                } finally {
                  this.save();
                }
              })();
              this.executions.add(execution);
              void execution.finally(() => this.executions.delete(execution)).catch(() => {});
              return execution;
            },
          },
        ];
      }),
    ) as ToolSet;
  }

  appendText(text: string): void {
    this.text += text;
  }

  updateInput(message: ModelMessage): void {
    this.store.updateMessage(this.conversation, this.anchor, message);
  }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.executions]);
  }

  activity(): ActivityStep[] {
    return [...this.calls].map(([id, call]) => ({
      kind: 'tool',
      id,
      tool: call.name,
      status: call.failed ? (call.output === INTERRUPTED_TOOL ? 'interrupted' : 'error') : 'completed',
      ...(call.failed ? { error: String(call.output) } : {}),
    }));
  }

  private messages(): ModelMessage[] {
    const messages: ModelMessage[] = [];
    for (const [id, call] of this.calls) {
      messages.push(
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: call.name, input: call.input }] },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: id,
              toolName: call.name,
              output: call.failed
                ? { type: 'error-text', value: String(call.output) }
                : {
                    type: 'text',
                    value: typeof call.output === 'string' ? call.output : (JSON.stringify(call.output) ?? 'null'),
                  },
            },
          ],
        },
      );
    }
    if (this.text) messages.push({ role: 'assistant', content: this.text });
    return messages;
  }

  save(stopped = false, byUser = true): string {
    const messages = this.messages();
    if (stopped)
      messages.push({
        role: 'user',
        content: `[${byUser ? 'The user stopped this turn.' : 'This turn was interrupted.'} The preceding input is cancelled, not pending. Keep completed work; do not resume or replay it unless explicitly asked. Interrupted tool outcomes are unknown.]`,
      });
    return (this.checkpoint = this.store.replaceAfter(this.conversation, this.anchor, messages));
  }

  finish(messages: ModelMessage[]): string {
    return (this.checkpoint = this.store.replaceAfter(this.conversation, this.anchor, messages));
  }
}
