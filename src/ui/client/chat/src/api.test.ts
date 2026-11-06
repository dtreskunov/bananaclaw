import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UI_PROTOCOL_HEADER, UI_TIMESTAMP_PROTOCOL_VERSION } from '../../../shared/time';
import { api, postJson, patchJson, protocolFetch, UI_RELOAD_EVENT, UiProtocolError } from './api';
import { loadBootstrap } from './startup';
import { UiResponse, uiHeaders } from './api-test-fixtures';

beforeEach(() => vi.stubGlobal('window', new EventTarget()));
afterEach(() => vi.unstubAllGlobals());

describe('UI timestamp protocol boundary', () => {
  it.each([api, postJson, patchJson])('sends the current version through each API helper', async (request) => {
    const fetch = vi.fn().mockResolvedValue(UiResponse.json({ timestamp: 0 }));
    vi.stubGlobal('fetch', fetch);
    await request('api/groups');
    const headers = new Headers(fetch.mock.calls[0][1].headers);
    expect(headers.get(UI_PROTOCOL_HEADER)).toBe(String(UI_TIMESTAMP_PROTOCOL_VERSION));
  });

  it.each([api, postJson, patchJson])(
    'versions settings requests without reshaping numeric responses',
    async (request) => {
      const data = { expiresAt: 0, identities: [{ verified_at: 0 }, { verified_at: null }] };
      const fetch = vi.fn().mockResolvedValue(UiResponse.json(data));
      vi.stubGlobal('fetch', fetch);
      const response = await request('/ui/settings/api/identities/link/start');
      expect(new Headers(fetch.mock.calls[0][1].headers).get(UI_PROTOCOL_HEADER)).toBe('16');
      expect(request === api ? response : (response as { data: unknown }).data).toEqual(data);
    },
  );

  it.each([null, '15'])(
    'rejects settings protocol %j before consuming identity or expiry timestamps',
    async (version) => {
      const response = Response.json(
        { expiresAt: '2026-01-01T00:00:00Z' },
        {
          headers: version === null ? {} : { [UI_PROTOCOL_HEADER]: version },
        },
      );
      const json = vi.spyOn(response, 'json');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(api('/ui/settings/api/identities/link/status')).rejects.toBeInstanceOf(UiProtocolError);
      expect(json).not.toHaveBeenCalled();
    },
  );

  it('versions absolute same-origin settings APIs, but not static settings or an external lookalike', async () => {
    Object.assign(window, { location: { origin: 'https://nanoclaw.example.com' } });
    const fetch = vi.fn().mockImplementation(async () => UiResponse.json({}));
    vi.stubGlobal('fetch', fetch);
    await protocolFetch('https://nanoclaw.example.com/ui/settings/api/profile');
    await protocolFetch('/ui/settings/');
    await protocolFetch('https://external.example.com/ui/settings/api/profile');
    expect(fetch.mock.calls.map(([, options]) => new Headers(options.headers).has(UI_PROTOCOL_HEADER))).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('keeps caller headers while overriding a stale protocol request header', async () => {
    const fetch = vi.fn().mockResolvedValue(UiResponse.json({ groups: [] }));
    vi.stubGlobal('fetch', fetch);
    await api('/ui/chat/api/groups', {
      headers: new Headers({ [UI_PROTOCOL_HEADER]: '15', 'Content-Type': 'application/json', 'If-Match': 'revision' }),
    });
    const headers = new Headers(fetch.mock.calls[0][1].headers);
    expect(headers.get(UI_PROTOCOL_HEADER)).toBe('16');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('If-Match')).toBe('revision');
  });

  it.each([null, '15', '16.0', ''])('rejects protocol %j before reading timestamps', async (version) => {
    const response = Response.json(
      { timestamp: '2026-01-01T00:00:00Z' },
      {
        headers: version === null ? {} : { [UI_PROTOCOL_HEADER]: version },
      },
    );
    const json = vi.spyOn(response, 'json');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const reload = vi.fn();
    window.addEventListener(UI_RELOAD_EVENT, reload);
    await expect(api('api/groups')).rejects.toBeInstanceOf(UiProtocolError);
    expect(json).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each([
    ['api/me', null],
    ['api/me', '15'],
    ['api/groups', null],
    ['api/groups', '15'],
  ])('checks %s protocol %j at bootstrap before accepting startup data', async (staleUrl, version) => {
    const stale = Response.json(
      staleUrl === 'api/me'
        ? { userId: 'user' }
        : {
            groups: [{ id: 'group', lastActivityAt: '2026-01-01 00:00:00' }],
          },
      {
        headers: version === null ? {} : { [UI_PROTOCOL_HEADER]: version },
      },
    );
    const json = vi.spyOn(stale, 'json');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        url === staleUrl ? stale : UiResponse.json(url === 'api/me' ? { userId: 'user' } : { groups: [] }),
      ),
    );
    await expect(loadBootstrap(new AbortController().signal)).rejects.toBeInstanceOf(UiProtocolError);
    expect(json).not.toHaveBeenCalled();
  });

  it('accepts epoch zero and explicit missing activity in current startup responses', async () => {
    const groups = [
      { id: 'zero', name: 'Zero', lastActivityAt: 0 },
      { id: 'empty', name: 'Empty', lastActivityAt: null },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => UiResponse.json(url === 'api/me' ? { userId: 'user' } : { groups })),
    );
    expect(await loadBootstrap(new AbortController().signal)).toEqual([{ userId: 'user' }, { groups }]);
  });

  it('adapts omitted startup activity to explicit null, without treating zero as missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        UiResponse.json(
          url === 'api/me'
            ? { userId: 'user' }
            : {
                groups: [
                  { id: 'empty', name: 'Empty' },
                  { id: 'zero', name: 'Zero', lastActivityAt: 0 },
                ],
              },
        ),
      ),
    );
    const [, response] = await loadBootstrap(new AbortController().signal);
    expect(response.groups).toEqual([
      { id: 'empty', name: 'Empty', lastActivityAt: null },
      { id: 'zero', name: 'Zero', lastActivityAt: 0 },
    ]);
  });

  it.each(['2026-01-01T00:00:00Z', NaN, Infinity, 1.5, 8640000000000001])(
    'rejects same-version malformed startup activity %j',
    async (lastActivityAt) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url) => ({
          ok: true,
          status: 200,
          headers: uiHeaders,
          json: async () =>
            url === 'api/me'
              ? { userId: 'user' }
              : {
                  groups: [{ id: 'invalid', name: 'Invalid', lastActivityAt }],
                },
        })),
      );
      await expect(loadBootstrap(new AbortController().signal)).rejects.toThrow('invalid group data');
    },
  );

  it('leaves external metadata and its request untouched', async () => {
    const metadata = { createdAt: '2026-01-01T00:00:00Z' };
    const fetch = vi.fn().mockResolvedValue(Response.json(metadata));
    vi.stubGlobal('fetch', fetch);
    const response = await protocolFetch('https://vault.example.com/metadata');
    expect(new Headers(fetch.mock.calls[0][1].headers).has(UI_PROTOCOL_HEADER)).toBe(false);
    expect(await response.json()).toEqual(metadata);
  });

  it('preserves transient proxy failures without requiring a protocol header on their error page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Unavailable', { status: 503 })));
    await expect(api('api/groups')).rejects.toThrow('HTTP 503');
  });
});
