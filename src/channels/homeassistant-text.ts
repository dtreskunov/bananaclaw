export const HA_CHANNEL_TYPE = 'homeassistant';

export function extractDisplayQuery(text: string): string {
  return text
    .replace(/\[Conversation so far\][\s\S]*?\[End conversation so far\]\n*/g, '')
    .replace(/\[Tool Result(?::[^\]\n]*)?\][\s\S]*?\[End Tool Result\]\n*/g, '')
    .trim();
}
