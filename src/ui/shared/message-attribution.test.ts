import { describe, expect, it } from 'vitest';
import { messageAttribution, otherAuthorName } from './conversation.js';

describe('shared sender attribution', () => {
  it.each([
    [{ userId: 'viewer', displayName: 'Me' }, undefined],
    [{ userId: 'other', displayName: 'Other user' }, 'Other user'],
    [{ agentGroupId: 'current', displayName: 'This agent' }, undefined],
    [{ agentGroupId: 'peer', displayName: 'Peer agent' }, 'Peer agent'],
    [undefined, undefined],
    [null, undefined],
  ] as const)('labels other senders and omits the current identity: %j', (author, expected) => {
    expect(otherAuthorName(author, 'viewer', 'current')).toBe(expected);
    expect(messageAttribution({ author: author ?? undefined }, 'viewer', 'current')).toBe(expected);
  });

  it('labels outbound peer destinations instead of presenting them as replies to the human', () => {
    expect(
      messageAttribution(
        {
          recipient: { agentGroupId: 'peer', displayName: 'Peer agent' },
        },
        'viewer',
        'current',
      ),
    ).toBe('To Peer agent');
  });
});
