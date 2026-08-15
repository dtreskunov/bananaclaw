import type { Direction } from './types';

export type DeliveryOrigin = 'send_message' | 'send_file' | 'response' | undefined;

export function isFinalResponse(direction: Direction, deliveryOrigin: DeliveryOrigin): boolean {
  return direction === 'out' && deliveryOrigin !== 'send_message' && deliveryOrigin !== 'send_file';
}

/**
 * Whether a message should carry the "mid-turn update" caption.
 *
 * `delivery_origin` is stamped when the row is written and never revised, so a
 * turn that ends without a final response — aborted, or its closing block
 * dropped as a duplicate of what `send_message` already sent — leaves the
 * update as the agent's last word while still claiming more is coming. Once
 * the turn settles with nothing after it, drop the caption.
 */
export function showsMidTurnLabel(deliveryOrigin: DeliveryOrigin, isLatest: boolean, turnActive: boolean): boolean {
  if (deliveryOrigin !== 'send_message') return false;
  return turnActive || !isLatest;
}

export function publicWebMessageId(clientMessageId: string): string {
  return `web-${clientMessageId}`;
}
