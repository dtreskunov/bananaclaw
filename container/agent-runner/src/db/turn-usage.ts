/**
 * Per-turn provider usage: cost, tokens, model, timing.
 * Written to `turn_usage` in outbound.db by the poll-loop after each
 * provider result. Read by the host UI for per-message and per-thread
 * usage display.
 */
import { getOutboundDb } from './connection.js';
import type { TurnUsage } from '../providers/types.js';

export function writeTurnUsage(id: string, messageOutId: string, data: TurnUsage): void {
  getOutboundDb()
    .prepare(
      `INSERT OR REPLACE INTO turn_usage
         (id, message_out_id, cost_usd, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens,
          num_turns, duration_ms, duration_api_ms,
          model, context_window, max_output_tokens, context_tokens, timestamp)
       VALUES ($id, $message_out_id, $cost_usd, $input_tokens, $output_tokens,
          $cache_read_tokens, $cache_write_tokens, $reasoning_tokens,
          $num_turns, $duration_ms, $duration_api_ms,
          $model, $context_window, $max_output_tokens, $context_tokens, datetime('now'))`,
    )
    .run({
      $id: id,
      $message_out_id: messageOutId,
      $cost_usd: data.cost_usd,
      $input_tokens: data.input_tokens,
      $output_tokens: data.output_tokens,
      $cache_read_tokens: data.cache_read_tokens,
      $cache_write_tokens: data.cache_write_tokens,
      $reasoning_tokens: data.reasoning_tokens ?? null,
      $num_turns: data.num_turns ?? null,
      $duration_ms: data.duration_ms ?? null,
      $duration_api_ms: data.duration_api_ms ?? null,
      $model: data.model,
      $context_window: data.context_window ?? null,
      $max_output_tokens: data.max_output_tokens ?? null,
      $context_tokens: data.context_tokens ?? null,
    });
}
