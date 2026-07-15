import { describe, it, expect } from 'vitest';

import { shortcodeToEmoji } from './emoji.js';

describe('shortcodeToEmoji', () => {
  it('resolves known shortcodes to unicode', () => {
    expect(shortcodeToEmoji('thumbs_up')).toBe('\u{1F44D}');
    expect(shortcodeToEmoji('white_check_mark')).toBe('\u2705');
    expect(shortcodeToEmoji('heart')).toBe('\u2764\uFE0F');
    expect(shortcodeToEmoji('eyes')).toBe('\u{1F440}');
    expect(shortcodeToEmoji('zipper_mouth_face')).toBe('\u{1F910}');
  });

  it('strips wrapping colons and normalizes case', () => {
    expect(shortcodeToEmoji(':thumbs_up:')).toBe('\u{1F44D}');
    expect(shortcodeToEmoji('THUMBS_UP')).toBe('\u{1F44D}');
    expect(shortcodeToEmoji('  heart  ')).toBe('\u2764\uFE0F');
  });

  it('falls back to :name: for unknown shortcodes', () => {
    expect(shortcodeToEmoji('not_a_real_emoji')).toBe(':not_a_real_emoji:');
  });

  it('passes through a raw emoji character unchanged', () => {
    expect(shortcodeToEmoji('\u{1F44D}')).toBe('\u{1F44D}');
    expect(shortcodeToEmoji('\u2705')).toBe('\u2705');
  });
});
