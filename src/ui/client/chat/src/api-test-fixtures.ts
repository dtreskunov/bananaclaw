import { UI_PROTOCOL_HEADER, UI_TIMESTAMP_PROTOCOL_VERSION } from '../../../shared/time';

export const uiHeaders = new Headers({ [UI_PROTOCOL_HEADER]: String(UI_TIMESTAMP_PROTOCOL_VERSION) });

/** Successful chat API fixtures include the same protocol header as the host. */
export class UiResponse extends Response {
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    const headers = new Headers(init?.headers);
    headers.set(UI_PROTOCOL_HEADER, String(UI_TIMESTAMP_PROTOCOL_VERSION));
    super(body, { ...init, headers });
  }

  static override json(data: unknown, init?: ResponseInit): UiResponse {
    const headers = new Headers(init?.headers);
    headers.set('Content-Type', 'application/json');
    return new UiResponse(JSON.stringify(data), { ...init, headers });
  }
}
