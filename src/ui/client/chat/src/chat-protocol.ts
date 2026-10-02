import type { Direction, SuggestedAction } from './types';

export type DeliveryOrigin = 'send_message' | 'send_file' | 'response' | undefined;

export function showsMidTurnLabel(deliveryOrigin: DeliveryOrigin, turnActive: boolean): boolean {
  return deliveryOrigin === 'send_message' && turnActive;
}

export function isSystemNotice(
  direction: Direction,
  systemGenerated: boolean | undefined,
  suggestedAction: SuggestedAction | undefined,
): boolean {
  return direction === 'out' && (systemGenerated === true || suggestedAction !== undefined);
}

export function publicWebMessageId(clientMessageId: string): string {
  return `web-${clientMessageId}`;
}
