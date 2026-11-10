import type { NativeModel } from './catalog.js';

const STANDARD = ['low', 'medium', 'high'] as const;
const EXTENDED = [...STANDARD, 'xhigh', 'max'] as const;

/** Mirrored by the host/UI; both sides assert model-contract-cases.json. */
export function nativeThinkingLevels(modelId: string): readonly string[] {
  if (/^MiniMax-M3\.1-Flash(?:-Preview)?$/i.test(modelId)) return EXTENDED;
  if (/^(?:o1|o3(?:-mini)?|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) return STANDARD;
  if (/^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) return STANDARD;
  if (/^gpt-5\.[12](?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) {
    return modelId.startsWith('gpt-5.2') ? ['none', ...STANDARD, 'xhigh'] : ['none', ...STANDARD];
  }
  if (/^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) return ['none', ...STANDARD, 'xhigh'];
  if (/^claude-(?:opus-4-[78]|(?:opus|sonnet)-5(?:-5)?|haiku-5-5)(?:-\d{8})?$/.test(modelId)) return EXTENDED;
  if (/^claude-(?:opus|sonnet)-4-6(?:-\d{8})?$/.test(modelId)) return [...STANDARD, 'max'];
  if (/^claude-opus-4-5(?:-\d{8})?$/.test(modelId)) return STANDARD;
  return [];
}

export function nativeThinkingOptions(
  model: NativeModel,
  effort: string | undefined,
): Record<string, { effort?: string; reasoningEffort?: string; thinking?: { type: 'adaptive' } }> {
  if (!effort) return {};
  const levels = nativeThinkingLevels(model.modelId);
  if (!levels.includes(effort)) {
    throw new Error(
      `Unsupported thinking level "${effort}" for ${model.wireId}. ` +
        (levels.length ? `Choose ${levels.join(', ')} or Default.` : 'Choose Default.'),
    );
  }
  const claude = model.modelId.startsWith('claude-');
  const miniMax = /^MiniMax-M3\.1-Flash(?:-Preview)?$/i.test(model.modelId);
  if (model.protocol === 'anthropic-messages') {
    if (!claude && !miniMax)
      throw new Error(`Thinking configuration for ${model.wireId} requires OpenAI Chat Completions.`);
    return {
      anthropic: {
        effort,
        ...(claude && !/^claude-opus-4-5/.test(model.modelId) ? { thinking: { type: 'adaptive' as const } } : {}),
      },
    };
  }
  if (claude) throw new Error(`Thinking configuration for ${model.wireId} requires Anthropic Messages.`);
  return { [model.providerId]: { reasoningEffort: effort } };
}
