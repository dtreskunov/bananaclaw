import { afterEach, expect, it, vi } from 'vitest';
import { closeDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';

vi.mock('./chat.js', () => {
  throw new Error('Conversation reads must not load the HTTP controller');
});
vi.mock('./routes.js', () => {
  throw new Error('Conversation reads must not load the HTTP router');
});
vi.mock('../server.js', () => {
  throw new Error('Conversation reads must not load HTTP startup');
});
import { resolveTurnContext } from './conversation-context.js';
import { readChatHistory } from './history.js';
import { readConversation } from './conversation.js';
import { approvalOrigin } from './approval-transcript.js';

afterEach(closeDb);

it('loads authorized read models without HTTP controllers and rejects inaccessible conversations', () => {
  runMigrations(initTestDb());
  expect(resolveTurnContext('viewer', 'missing', 'thread')).toBeNull();
  expect(() => readChatHistory('viewer', 'missing', 'thread')).toThrow('not accessible');
  expect(() => readConversation('viewer', 'missing', 'thread')).toThrow('not accessible');
  expect(approvalOrigin('viewer', { session_id: null })).toBeNull();
});

it('reads an authorized empty web conversation without provisioning a session or starting HTTP', () => {
  const db = initTestDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO users(id,kind,created_at) VALUES('viewer','web',1767225600000);
    INSERT INTO agent_groups(id,name,folder,created_at) VALUES('group','Group','group',1767225600000);
    INSERT INTO agent_group_members(user_id,agent_group_id,added_at) VALUES('viewer','group',1767225600000);
    INSERT INTO messaging_groups(id,channel_type,instance,platform_id,is_group,created_at)
      VALUES('web-group','web','web','group:group',1,1767225600000);
  `);
  expect(resolveTurnContext('viewer', 'group', 'thread')).toEqual({
    sessionId: undefined,
    channelType: 'web',
    platformIds: ['group:group'],
    threadId: 'thread',
    canSend: true,
  });
  expect(readChatHistory('viewer', 'group', 'thread')).toEqual([]);
  expect(readConversation('viewer', 'group', 'thread').messages).toEqual([]);
  expect(db.prepare('SELECT * FROM sessions').all()).toEqual([]);
});
