import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { initTestSessionDb, closeSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { requestAccess } from './access.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('request_access MCP tool', () => {
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
