import { describe, expect, it, vi } from 'vitest';
import { ReplySuggestion } from './ReplySuggestion';

describe('compact suggestion button', () => {
  it('sends from the label and offers a sibling gray edit control inside the same border', () => {
    const onChoose = vi.fn(),
      onSend = vi.fn(),
      stopPropagation = vi.fn();
    const chip = ReplySuggestion({
      label: 'Fix references',
      disabled: false,
      sendDisabled: false,
      onChoose,
      onSend,
    });
    expect(chip.type).toBe('span');
    const [label, edit] = chip.props.children;
    expect(label.type).toBe('button');
    expect(label.props.type).toBe('button');
    expect(edit.type).toBe('button');
    expect(edit.props.type).toBe('button');
    expect(edit.props.class).toBe('msg-action-btn reply-suggestion-edit');
    expect(edit.props.title).toBe('Edit suggestion');
    expect(label.props.children).toBe('Fix references');
    expect(edit.props['aria-label']).toBe('Edit suggestion: Fix references');
    label.props.onClick({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Fix references');
    expect(onChoose).not.toHaveBeenCalled();
    edit.props.onClick({ stopPropagation });
    expect(onChoose).toHaveBeenCalledExactlyOnceWith('Fix references');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('can disable sending separately from drafting', () => {
    const chip = ReplySuggestion({
      label: 'A draft',
      disabled: false,
      sendDisabled: true,
      onChoose: vi.fn(),
      onSend: vi.fn(),
    });
    const [label, edit] = chip.props.children;
    expect(label.props.disabled).toBe(true);
    expect(edit.props.disabled).toBe(false);
  });

  it('preserves Markdown formatting and uses native button keyboard activation', () => {
    const onSend = vi.fn(),
      stopPropagation = vi.fn();
    const chip = ReplySuggestion({
      label: 'Formatted text',
      labelHtml: '<strong>Formatted</strong> <em>text</em>',
      disabled: false,
      sendDisabled: false,
      onChoose: vi.fn(),
      onSend,
    });
    const label = chip.props.children[0];
    expect(label.props.dangerouslySetInnerHTML).toEqual({ __html: '<strong>Formatted</strong> <em>text</em>' });
    expect(label.type).toBe('button');
    expect(label.props.type).toBe('button');
    expect(label.props.onKeyDown).toBeUndefined();
    label.props.onClick({ stopPropagation });
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Formatted text');
  });

  it('does not send disabled text or edit a disabled composer', () => {
    const onChoose = vi.fn(),
      onSend = vi.fn(),
      stopPropagation = vi.fn();
    const chip = ReplySuggestion({
      label: 'Disabled',
      disabled: true,
      sendDisabled: true,
      onChoose,
      onSend,
    });
    const [label, edit] = chip.props.children;
    label.props.onClick({ stopPropagation });
    edit.props.onClick({ stopPropagation });
    expect(onChoose).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });
});
