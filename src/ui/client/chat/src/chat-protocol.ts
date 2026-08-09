import type { Direction } from './types';

export type DeliveryOrigin = 'send_message' | 'send_file' | 'response' | undefined;

export function isFinalResponse(direction: Direction, deliveryOrigin: DeliveryOrigin): boolean {
  return direction === 'out' && deliveryOrigin !== 'send_message' && deliveryOrigin !== 'send_file';
}

export function isWebEchoForClientMessage(serverMessageId: string, clientMessageId: string): boolean {
  const webMessageId = `web-${clientMessageId}`;
  return (
    serverMessageId === clientMessageId ||
    serverMessageId === webMessageId ||
    serverMessageId.startsWith(`${webMessageId}:`)
  );
}
