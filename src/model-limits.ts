/**
 * How a model catalog's raw limits become the numbers the UI shows.
 *
 * The container records limits with the identical rule
 * (container/agent-runner/src/providers/model-catalog.ts). The two trees can't
 * import each other, so both are asserted against
 * providers/model-contract-cases.json — otherwise the picker can advertise an
 * output cap the recorder deliberately drops.
 */

export interface RawLimits {
  context: number;
  output: number;
}

export interface ModelLimits {
  context_window?: number;
  max_output_tokens?: number;
}

/**
 * An output cap at or above the whole context window is the absence of a cap,
 * not a cap.
 */
export function normalizeLimits(raw: Partial<RawLimits> | undefined): ModelLimits {
  const rawContext = raw?.context ?? 0;
  const rawOutput = raw?.output ?? 0;
  const context = rawContext > 0 ? rawContext : undefined;
  const output = rawOutput > 0 && (!context || rawOutput < context) ? rawOutput : undefined;
  return { context_window: context, max_output_tokens: output };
}
