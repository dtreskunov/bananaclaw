import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../state', () => ({ isMobile: { value: false } }));
vi.mock('../appearance-state', () => ({ appearance: { value: { preferences: { density: 'comfortable' } } } }));
import { isMobile } from '../state';
import { ComposerInput } from './ComposerInput';

beforeEach(() => {
  isMobile.value = false;
});
describe('shared composer input modes', () => {
  it('supports passive drafts without a send button, microphone, or Enter-to-submit interception', () => {
    const node = ComposerInput({
      inputRef: { current: null },
      textarea: { value: 'Optional note', maxLength: 4000 },
      multiLine: false,
      listening: false,
    });
    expect(node.props.class).toContain('composer-input-wrap composer-passive');
    const [textarea, controls, voice, send] = node.props.children;
    expect(textarea.type).toBe('textarea');
    expect(textarea.props.maxLength).toBe(4000);
    expect(textarea.props.rows).toBe(1);
    expect(textarea.props.onKeyDown).toBeUndefined();
    expect(controls).toBeUndefined();
    expect(voice).toBeNull();
    expect(send).toBeNull();
  });
  it.each([
    { mobile: false, shift: false, composing: false, submits: true },
    { mobile: false, shift: true, composing: false, submits: false },
    { mobile: true, shift: false, composing: false, submits: false },
    { mobile: false, shift: false, composing: true, submits: false },
  ])('preserves active composer Enter behavior: %j', ({ mobile, shift, composing, submits }) => {
    isMobile.value = mobile;
    const submit = vi.fn(),
      prevent = vi.fn();
    const node = ComposerInput({
      inputRef: { current: null },
      textarea: { value: 'Answer' },
      multiLine: false,
      listening: false,
      send: { label: 'Send', title: 'Send answer', disabled: false },
    });
    const textarea = node.props.children[0];
    textarea.props.onKeyDown({
      key: 'Enter',
      shiftKey: shift,
      isComposing: composing,
      currentTarget: { form: { requestSubmit: submit } },
      preventDefault: prevent,
    });
    expect(submit).toHaveBeenCalledTimes(submits ? 1 : 0);
    expect(prevent).toHaveBeenCalledTimes(submits ? 1 : 0);
  });
});
