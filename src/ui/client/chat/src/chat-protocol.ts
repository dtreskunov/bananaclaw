export type DeliveryOrigin = 'send_message' | 'send_file' | 'response' | undefined;

export function showsMidTurnLabel(deliveryOrigin: DeliveryOrigin, turnActive: boolean): boolean {
  return deliveryOrigin === 'send_message' && turnActive;
}

export function publicWebMessageId(clientMessageId: string): string {
  return `web-${clientMessageId}`;
}
