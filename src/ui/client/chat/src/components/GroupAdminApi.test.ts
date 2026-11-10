import { describe, expect, it } from 'vitest';
import { settingsPatch } from './GroupAdminApi';

describe('settingsPatch', () => {
  const draft = { provider: 'native', model: 'local/unknown', effort: 'high', assistant_name: 'Agent' };

  it('omits unchanged thinking settings from unrelated edits', () => {
    expect(settingsPatch(draft, new Set(['assistant_name']))).toEqual({ assistant_name: 'Agent' });
  });

  it('retains explicit nulls when clearing a thinking override', () => {
    expect(settingsPatch({ ...draft, effort: null }, new Set(['effort']))).toEqual({ effort: null });
  });

  it('includes changed provider, model and effort together', () => {
    expect(settingsPatch(draft, new Set(['provider', 'model', 'effort']))).toEqual({
      provider: 'native',
      model: 'local/unknown',
      effort: 'high',
    });
  });

  it('does not send non-config changes or unchanged voice fields', () => {
    expect(
      settingsPatch(
        { voice_input_enabled: false, voice_input_backend: 'elevenlabs' },
        new Set(['voice_input_enabled', 'model_params', 'name']),
      ),
    ).toEqual({ voice_input_enabled: false });
    expect(settingsPatch(draft, new Set())).toEqual({});
  });
});
