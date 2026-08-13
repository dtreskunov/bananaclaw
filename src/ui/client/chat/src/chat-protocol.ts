import type { Direction } from './types';

export type DeliveryOrigin = 'send_message' | 'send_file' | 'response' | undefined;

export function isFinalResponse(direction: Direction, deliveryOrigin: DeliveryOrigin): boolean {
  return direction === 'out' && deliveryOrigin !== 'send_message' && deliveryOrigin !== 'send_file';
}

export function publicWebMessageId(clientMessageId: string): string {
  return `web-${clientMessageId}`;
}
