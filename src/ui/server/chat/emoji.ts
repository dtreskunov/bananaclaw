/**
 * Emoji shortcode → unicode resolution for the web channel.
 *
 * The `add_reaction` MCP tool ships a shortcode name (e.g. `thumbs_up`,
 * `white_check_mark`) rather than a raw character — real channels rely on
 * the platform to interpret it. The web channel has no platform, so we own
 * the mapping and resolve to unicode before the reaction reaches the client.
 *
 * Covers the shortcodes the agent instructions advertise plus the common
 * set. Unknown shortcodes fall back to `:name:` so nothing is silently lost.
 */
const SHORTCODE_TO_EMOJI: Record<string, string> = {
  thumbs_up: '\u{1F44D}',
  '+1': '\u{1F44D}',
  thumbsup: '\u{1F44D}',
  thumbs_down: '\u{1F44E}',
  '-1': '\u{1F44E}',
  thumbsdown: '\u{1F44E}',
  white_check_mark: '\u2705',
  check: '\u2714\uFE0F',
  heavy_check_mark: '\u2714\uFE0F',
  x: '\u274C',
  heart: '\u2764\uFE0F',
  eyes: '\u{1F440}',
  fire: '\u{1F525}',
  tada: '\u{1F389}',
  rocket: '\u{1F680}',
  pray: '\u{1F64F}',
  raised_hands: '\u{1F64C}',
  clap: '\u{1F44F}',
  wave: '\u{1F44B}',
  ok_hand: '\u{1F44C}',
  thinking: '\u{1F914}',
  thinking_face: '\u{1F914}',
  zipper_mouth_face: '\u{1F910}',
  shushing_face: '\u{1F92B}',
  smile: '\u{1F604}',
  grinning: '\u{1F600}',
  joy: '\u{1F602}',
  sob: '\u{1F62D}',
  cry: '\u{1F622}',
  sweat_smile: '\u{1F605}',
  wink: '\u{1F609}',
  sunglasses: '\u{1F60E}',
  warning: '\u26A0\uFE0F',
  bulb: '\u{1F4A1}',
  hourglass: '\u23F3',
  hourglass_flowing_sand: '\u23F3',
  point_up: '\u261D\uFE0F',
  star: '\u2B50',
  sparkles: '\u2728',
  question: '\u2753',
  exclamation: '\u2757',
  '100': '\u{1F4AF}',
  boom: '\u{1F4A5}',
  zap: '\u26A1',
};

/**
 * Resolve an emoji shortcode to its unicode character. Strips any wrapping
 * colons (`:heart:` → `heart`), lowercases, and falls back to `:name:` when
 * the shortcode isn't in the table so unknown reactions still render as text.
 */
export function shortcodeToEmoji(raw: string): string {
  const name = raw.trim().replace(/^:|:$/g, '').toLowerCase();
  if (!name) return raw;
  // Already a raw emoji (no ASCII letters) — pass through unchanged.
  if (!/[a-z0-9_+-]/.test(name)) return raw;
  return SHORTCODE_TO_EMOJI[name] ?? `:${name}:`;
}
