import type { ModelMessage, ToolSet } from 'ai';
import { NativeStore } from './store.js';
import type { ActivityStep, ProviderEvent } from '../types.js';
import { nativeToolOutcome, toolActivityFields, type NativeToolOutcome } from '../tool-activity.js';

export const INTERRUPTED_TOOL =
  'Interrupted; outcome unknown. External side effects may have occurred. Do not retry without checking.';

type ModelToolOutput = Extract<
  Extract<ModelMessage, { role: 'tool' }>['content'][number], { type: 'tool-result' }
>['output'];
interface JournalToolCall {
  name: string;
  input: unknown;
  outcome: NativeToolOutcome;
  modelOutput: ModelToolOutput;
}

/** Persist input and valid call/result pairs even before an SDK step finishes. */
export class NativeTurnJournal {
  private readonly calls = new Map<string, JournalToolCall>();
  private readonly executions = new Set<Promise<unknown>>();
  private readonly toolControllers = new Map<string, AbortController>();
  private readonly completedActivity: ActivityStep[] = [];
  private text = '';
  private anchor: string;
  private readonly firstInputRef: string;
  private readonly protectedInputs = new Set<string>();
  checkpoint: string;

  constructor(
    private store: NativeStore,
    private conversation: string,
    incoming: ModelMessage,
  ) {
    this.firstInputRef = this.anchor = this.checkpoint = store.append(conversation, [incoming]);
    this.protectedInputs.add(this.anchor);
  }

  inputRefs(): ReadonlySet<string> {
    return this.protectedInputs;
  }

  hasToolExecutions(): boolean {
    return this.calls.size > 0;
  }

  stopTool(toolCallId: string): boolean {
    const controller = this.toolControllers.get(toolCallId);
    if (!controller) return false;
    controller.abort(new Error(INTERRUPTED_TOOL));
    return true;
  }

  announceTool(toolCallId: string): void {
    if (!this.calls.has(toolCallId)) this.registerTool(toolCallId);
  }

  private registerTool(toolCallId: string): AbortController {
    let controller = this.toolControllers.get(toolCallId);
    if (!controller) {
      controller = new AbortController();
      this.toolControllers.set(toolCallId, controller);
    }
    return controller;
  }

  wrap(tools: ToolSet, signal: AbortSignal): ToolSet {
    return Object.fromEntries(
      Object.entries(tools).map(([name, definition]) => {
        const execute = definition.execute;
        if (!execute) return [name, definition];
        const toModelOutput: NonNullable<typeof definition.toModelOutput> =
          definition.toModelOutput ?? (({ output }: { output: unknown }): ModelToolOutput => ({
            type: 'text',
            value: typeof output === 'string' ? output : (JSON.stringify(output) ?? 'null'),
          }));
        return [
          name,
          {
            ...definition,
            toModelOutput: (options: Parameters<typeof toModelOutput>[0]) =>
              this.calls.get(options.toolCallId)?.modelOutput ?? toModelOutput(options),
            execute: (input: unknown, options: Parameters<NonNullable<typeof execute>>[1]) => {
              signal.throwIfAborted();
              const call: JournalToolCall = {
                name, input, outcome: { status: 'interrupted', error: INTERRUPTED_TOOL },
                modelOutput: { type: 'error-text', value: INTERRUPTED_TOOL },
              };
              const controller = this.registerTool(options.toolCallId);
              const toolSignal = AbortSignal.any([signal, controller.signal]);
              this.calls.set(options.toolCallId, call);
              this.save();
              const execution = (async () => {
                try {
                  toolSignal.throwIfAborted();
                  const result = await execute(input, { ...options, abortSignal: toolSignal });
                  call.modelOutput = await toModelOutput({ toolCallId: options.toolCallId, input, output: result });
                  call.outcome = nativeToolOutcome(name, result) ?? { status: 'completed' };
                  return result;
                } catch (error) {
                  const message = toolSignal.aborted ? INTERRUPTED_TOOL : String(error);
                  call.outcome = { status: toolSignal.aborted ? 'interrupted' : 'error', error: message };
                  call.modelOutput = { type: 'error-text', value: message };
                  if (controller.signal.aborted && !signal.aborted) throw new Error(INTERRUPTED_TOOL);
                  throw error;
                } finally {
                  this.toolControllers.delete(options.toolCallId);
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
    return [...this.completedActivity, ...[...this.calls].map(([id, call]): ActivityStep => ({
        kind: 'tool',
        id,
        tool: call.name,
        ...call.outcome,
        ...toolActivityFields(call.name, call.input),
      }))];
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
              output: call.modelOutput,
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

  acknowledgeResult(result: Extract<ProviderEvent, { type: 'result' }>, signal: AbortSignal): void {
    if (!signal.aborted && (result.replies?.length || result.silence !== undefined))
      this.store.finishTurn(this.conversation, this.firstInputRef, this.checkpoint);
  }

  /** Seal a completed SDK segment before appending another input. */
  finishSegment(messages: ModelMessage[]): string {
    this.finish(messages);
    this.completedActivity.splice(0, this.completedActivity.length, ...this.activity());
    this.calls.clear();
    this.toolControllers.clear();
    this.text = '';
    this.anchor = this.checkpoint;
    return this.checkpoint;
  }

  applySteering(id: string, message: ModelMessage): boolean {
    const ref = this.store.appendSteering(this.conversation, id, message);
    if (ref === null) return false;
    // Future incremental saves may replace only output after the injected input.
    this.anchor = this.checkpoint = ref;
    this.protectedInputs.add(ref);
    return true;
  }
}
