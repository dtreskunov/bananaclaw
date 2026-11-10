const STANDARD = ['low', 'medium', 'high'] as const;
const EXTENDED = [...STANDARD, 'xhigh', 'max'] as const;

export function isThinkingLevel(value: unknown): value is string {
  return typeof value === 'string' && ['none', ...EXTENDED].includes(value);
}

/** Mirrored in the isolated runner; both sides assert model-contract-cases.json. */
export function thinkingLevels(provider: string | null, model: string | null): readonly string[] {
  if (!model || (provider !== 'claude' && provider !== 'native')) return [];
  if (provider === 'native' && model.indexOf('/') <= 0) return [];
  const id = provider === 'native' ? model.slice(model.indexOf('/') + 1) : model;
  if (provider === 'native') {
    if (/^MiniMax-M3\.1-Flash(?:-Preview)?$/i.test(id)) return EXTENDED;
    if (/^(?:o1|o3(?:-mini)?|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return STANDARD;
    if (/^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return STANDARD;
    if (/^gpt-5\.[12](?:-\d{4}-\d{2}-\d{2})?$/.test(id)) {
      return id.startsWith('gpt-5.2') ? ['none', ...STANDARD, 'xhigh'] : ['none', ...STANDARD];
    }
    if (/^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return ['none', ...STANDARD, 'xhigh'];
  }
  if (/^claude-(?:opus-4-[78]|(?:opus|sonnet)-5(?:-5)?|haiku-5-5)(?:-\d{8})?$/.test(id)) return EXTENDED;
  if (/^claude-(?:opus|sonnet)-4-6(?:-\d{8})?$/.test(id)) return [...STANDARD, 'max'];
  if (/^claude-opus-4-5(?:-\d{8})?$/.test(id) || (provider === 'claude' && /^(?:opus|sonnet)$/.test(id)))
    return STANDARD;
  return [];
}

/** Reviewed API defaults only; the Claude SDK can override these through its own settings. */
export function defaultThinkingLevel(provider: string | null, model: string | null): string | null {
  const levels = thinkingLevels(provider, model);
  if (provider !== 'native' || !model || levels.length === 0) return null;
  const id = model.slice(model.indexOf('/') + 1);
  if (/^MiniMax-M3\.1-Flash(?:-Preview)?$/i.test(id)) return 'max';
  if (id.startsWith('claude-')) return /^claude-(?:opus|haiku)-5-5(?:-\d{8})?$/.test(id) ? 'medium' : 'high';
  return levels.includes('none') ? 'none' : 'medium';
}

export function thinkingLevelError(provider: string | null, model: string | null, effort: unknown): string | null {
  if (effort == null || effort === '') return null;
  const levels = thinkingLevels(provider, model);
  if (typeof effort === 'string' && levels.includes(effort)) return null;
  return levels.length
    ? `Thinking level must be one of: ${levels.join(', ')} for ${model}.`
    : `Configurable thinking is not supported for ${provider ?? 'this provider'}/${model ?? 'the default model'}. Clear the effort override or choose a supported model.`;
}

export function thinkingLevelLabel(level: string): string {
  if (level === 'none') return 'Off';
  if (level === 'xhigh') return 'Extra high';
  if (level === 'max') return 'Maximum';
  return level.charAt(0).toUpperCase() + level.slice(1);
}
