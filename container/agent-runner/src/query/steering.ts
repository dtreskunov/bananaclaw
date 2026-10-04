/**
 * Native steering for an active query: offers pending chat input to the
 * in-flight turn, records the provider's acceptance and application, and
 * releases anything the turn finished without applying.
 */
import { getOutboundDb } from '../db/connection.js';
import {
  getPendingMessages,
  getSteeringCandidates,
  markCompleted,
  markProcessing,
  type MessageInRow,
} from '../db/messages-in.js';
import { extractFileAttachments, extractMessageText, formatMessages, type RoutingContext } from '../formatter.js';
import type { AgentProvider, AgentQuery } from '../providers/types.js';
import { signalTurnState } from '../session-link.js';
import { steeringDisposition, writeInputState } from '../steering.js';
import { associateInput, type TurnExecution } from '../turn-execution.js';

export class SteeringSession {
  /** Accepted by the provider, not yet applied, keyed by input ID. */
  readonly inputs = new Map<string, MessageInRow>();
  private readonly declined = new Set<string>();
  readonly supported: boolean;

  constructor(
    private readonly provider: AgentProvider,
    private readonly query: AgentQuery,
    persistContinuation: boolean,
  ) {
    this.supported = persistContinuation && provider.supportsSteering === true && query.steer !== undefined;
  }

  /** Publish the live turn state, including which input controls it supports. */
  publishTurn(turnId: string, stopping: boolean, routing: RoutingContext): void {
    const { provider, query } = this;
    signalTurnState({
      id: turnId,
      status: stopping ? 'stopping' : 'running',
      channelType: routing.channelType ?? '',
      platformId: routing.platformId ?? '',
      threadId: routing.threadId,
      ...(this.supported ? { supportsSteering: true } : {}),
      ...(this.supported && provider.supportsInputEditing === true && query.replaceSteering
        ? { supportsInputEditing: true }
        : {}),
      ...(this.supported && provider.supportsInputCancellation === true && query.cancelSteering
        ? { supportsInputCancellation: true }
        : {}),
    });
  }

  /**
   * Called while a turn is active: publish a disposition for every waiting
   * chat input, then hand the provider steering candidates until it accepts
   * one or none remain.
   */
  offer(activeTurnRouting: RoutingContext, turnId: string): void {
    // Queue visibility must not depend on which inputs fit the next prompt.
    for (const message of getPendingMessages(false, { uncapped: true })) {
      if (!['chat', 'chat-sdk'].includes(message.kind) || message.trigger !== 1 || this.inputs.has(message.id))
        continue;
      const disposition = steeringDisposition(message, activeTurnRouting, turnId, this.supported);
      // "Waiting to steer" means the provider has accepted the input.
      writeInputState({ ...disposition, status: 'queued', queuedForNextTurn: true });
    }
    if (!this.supported) return;
    let accepted = false;
    while (!accepted) {
      const candidates = getSteeringCandidates(activeTurnRouting, [...this.inputs.keys(), ...this.declined]);
      if (candidates.length === 0) break;
      for (const message of candidates) {
        const disposition = steeringDisposition(message, activeTurnRouting, turnId, true);
        if (disposition.status !== 'steering') {
          this.declined.add(message.id);
          writeInputState({ ...disposition, queuedForNextTurn: true });
          continue;
        }
        const files = extractFileAttachments([message]);
        if (
          !this.query.steer!({
            id: message.id,
            prompt: formatMessages([message]),
            ...(files.length ? { files } : {}),
          })
        ) {
          this.declined.add(message.id);
          writeInputState({ ...disposition, status: 'queued', reason: 'turn_finished', queuedForNextTurn: true });
          continue;
        }
        accepted = true;
        this.inputs.set(message.id, message);
        writeInputState(disposition);
      }
    }
  }

  /**
   * Record that the provider applied an accepted input to the current turn.
   * Returns the prompt record and message text for the activity trace.
   */
  apply(id: string, execution: TurnExecution, stopped: boolean): { prompt: string; text: string } {
    const message = this.inputs.get(id);
    if (!message) throw new Error(`Provider applied unaccepted steering input: ${id}`);
    getOutboundDb().transaction(() => {
      writeInputState({ messageId: id, status: 'applied', turnId: execution.turnId });
      associateInput(execution, id, 'applied');
      if (stopped) markCompleted([id]);
      else markProcessing([id]);
    })();
    this.inputs.delete(id);
    return { prompt: formatMessages([message]), text: extractMessageText(message) };
  }

  /** The turn finished: accepted-but-unapplied inputs go back to the queue. */
  releaseUnapplied(): void {
    for (const messageId of this.inputs.keys()) {
      writeInputState({ messageId, status: 'queued', reason: 'turn_finished', queuedForNextTurn: true });
    }
    this.inputs.clear();
    this.declined.clear();
  }
}
