import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { initTestSessionDb, closeSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { requestAccess } from './access.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('request_access MCP tool', () => {
  it('carries explicit query-key placement without credential values', async () => {
    const authentication = { type: 'api-key', location: 'query', parameter: 'api_key' };
    const result = await requestAccess.handler({ resource_url: 'https://api.example.com/data',
      reason: 'Read the requested data.', authentication });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(getUndeliveredMessages()[0].content)).toMatchObject({ authentication });
    expect((await requestAccess.handler({ resource_url: 'https://api.example.com/data', reason: 'Read',
      authentication: { type: 'api-key', location: { value: 'secret' } } })).isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });
  it('uses the existing host message transport and never claims permission was granted', async () => {
    const result = await requestAccess.handler({ resource_url: 'https://api.example.com/v1/items', reason: 'Finish the report.' });
    const receipt = JSON.parse(result.content[0].text);
    expect(receipt.status).toBe('submitted');
    const messages = getUndeliveredMessages();
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0].content)).toMatchObject({
      action: 'request_access', requestId: receipt.request_id, resource_url: 'https://api.example.com/v1/items',
      reason: 'Finish the report.',
    });
  });
  it('carries only the named server target, not a credential or binding selector', async () => {
    const result = await requestAccess.handler({ resource_url: 'https://api.example.com/mcp', reason: 'Read personal mail.', mcp_server: 'gmail_personal' });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(getUndeliveredMessages()[0].content)).toMatchObject({ mcp_server: 'gmail_personal' });
  });
  it('carries researched nonsecret hints and scopes but rejects secret-valued hints', async () => {
    const request = { resource_url: 'https://api.example.com/mcp', reason: 'Read mail.',
      authentication: { type: 'mcp_oauth', app_id: 'google' }, scopes: ['mail.read'] };
    expect((await requestAccess.handler(request)).isError).not.toBe(true);
    expect(JSON.parse(getUndeliveredMessages()[0].content)).toMatchObject({
      authentication: { type: 'mcp_oauth', app_id: 'google' }, scopes: ['mail.read'],
    });
    expect((await requestAccess.handler({ ...request, authentication: { type: 'bearer', token: 'secret' } })).isError).toBe(true);
    expect((await requestAccess.handler({ ...request, authentication: { type: 'custom', headers: { 'X-Key': 'secret' } } })).isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });
  it('rejects owner/secret overrides and unsafe destinations before delivery', async () => {
    for (const raw of [
      { resource_url: 'http://api.example.com/', reason: 'Read' },
      { resource_url: 'https://user:secret@api.example.com/', reason: 'Read' },
      { resource_url: 'https://api.example.com/?key=secret', reason: 'Read' },
      { resource_url: 'https://api.example.com/', reason: 'Read', owner: 'alice' },
      { resource_url: 'https://api.example.com/', reason: 'Read', token: 'secret' },
    ]) expect((await requestAccess.handler(raw)).isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
