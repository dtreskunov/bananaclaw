import { afterEach, describe, expect, it, vi } from 'vitest';
import { alignReaderMessage, readerKey, readerPages } from './transcript-reader';
import { conversationPresentation } from './conversation-state';
import { testAccountInteraction, testSnapshot } from './conversation-test-fixtures';
import type { ChatMessage, TranscriptRow } from './types';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
afterEach(() => vi.unstubAllGlobals());

const message: ChatMessage = { id: 'message', direction: 'out', text: 'A readable reply', timestamp: 1791219601000 };

describe('reader timeline', () => {
  it('includes bodies, cards, attachments and completed answers but not operational events or empty traces', () => {
    const rows: TranscriptRow[] = [
      { kind: 'message', message },
      { kind: 'message', message: { ...message, id: 'file', text: '', files: [{ filename: 'note.txt', size: 10 }] } },
      {
        kind: 'message',
        message: { ...message, id: 'answer', direction: 'in' },
      },
      { kind: 'message', message: { ...message, id: 'event', direction: 'event' } },
      { kind: 'message', message: { ...message, id: 'notice', systemGenerated: true } },
      { kind: 'message', message: { ...message, id: 'empty', text: '' } },
      {
        kind: 'message',
        message: {
          ...message,
          id: 'card',
          text: '',
          card: { title: 'Card', description: '', children: [], actions: [] },
        },
      },
    ];
    expect(readerPages(rows).map((page) => page.key)).toEqual([
      'message:message',
      'message:file',
      'message:answer',
      'message:card',
    ]);
  });

  it('adds an ordinary follow-up without changing the preceding reader page', () => {
    const before = conversationPresentation(testSnapshot({ messages: [message] }).conversation).transcript;
    expect(before).toEqual([{ kind: 'message', message }]);
    const answer: ChatMessage = {
      ...message,
      id: 'answer',
      direction: 'in',
      text: 'first',
    };
    const after = conversationPresentation(testSnapshot({ messages: [message, answer] }).conversation).transcript;
    const page = readerPages(after).find((page) => page.key === readerKey({ kind: 'message', id: answer.id }));
    expect(page).toMatchObject({
      key: 'message:answer',
      anchorId: 'answer',
      row: { kind: 'message', message: answer },
    });
    expect(readerPages(after).length).toBe(readerPages(before).length + 1);
    expect(readerPages(after)[0].key).toBe(readerPages(before)[0].key);
  });

  it('omits cancelled inputs from the reader', () => {
    const answer: ChatMessage = {
      ...message,
      direction: 'in',
      inputState: { messageId: message.id, status: 'cancelled' },
    };
    const rows = conversationPresentation(testSnapshot({ messages: [answer] }).conversation).transcript;
    expect(rows).toEqual([]);
    expect(readerPages(rows)).toEqual([]);
  });

  it('updates position/count without changing message identity or duplicating references', () => {
    const first: TranscriptRow = { kind: 'message', message };
    const latest: TranscriptRow = { kind: 'message', message: { ...message, id: 'latest' } };
    expect(readerPages([first, latest, latest]).map((page) => page.key)).toEqual(['message:message', 'message:latest']);
    expect(readerPages([first, latest])[0].key).toBe(readerPages([latest, first])[1].key);
  });
  it('skips pending and resolved approval/account requests even when they have readable content', () => {
    const requests: TranscriptRow[] = [
      { kind: 'interaction', interaction: testAccountInteraction() },
      { kind: 'interaction', interaction: testAccountInteraction({ kind: 'account_setup', status: 'completed' }) },
      {
        kind: 'interaction',
        interaction: {
          kind: 'confirmation',
          id: 'confirmation',
          title: 'Install package',
          details: 'Install this package',
          action: 'install_packages',
          packages: null,
          options: [],
          status: 'pending',
          agentGroupId: 'group',
          agentGroupName: 'Group',
          createdAt: message.timestamp,
        },
      },
    ];
    expect(readerPages([...requests, { kind: 'message', message }]).map((page) => page.key)).toEqual([
      'message:message',
    ]);
  });
});

describe('reader transcript alignment', () => {
  it.each([100, 900])('aligns a message at %i even when the last short message needs tail space', (messageTop) => {
    const properties = new Map<string, string>();
    let scroll = 0;
    const viewport = {
      clientTop: 0,
      clientHeight: 500,
      style: {
        removeProperty: (name: string) => properties.delete(name),
        setProperty: (name: string, value: string) => properties.set(name, value),
      },
      get scrollHeight() {
        return 1000 + parseFloat(properties.get('--reader-tail-space') ?? '0');
      },
      get scrollTop() {
        return scroll;
      },
      set scrollTop(value: number) {
        scroll = Math.min(value, this.scrollHeight - this.clientHeight);
      },
      getBoundingClientRect: () => ({ top: 60 }),
    };
    const target = { getBoundingClientRect: () => ({ top: 60 + messageTop - scroll }) };
    vi.stubGlobal('getComputedStyle', () => ({ scrollPaddingTop: '18px' }));
    alignReaderMessage(viewport as unknown as HTMLElement, target as HTMLElement);
    expect(scroll).toBe(messageTop - 18);
    expect(target.getBoundingClientRect().top).toBe(78);
    expect(parseFloat(properties.get('--reader-tail-space')!)).toBe(Math.max(0, messageTop - 518));
    alignReaderMessage(viewport as unknown as HTMLElement, target as HTMLElement);
    expect(target.getBoundingClientRect().top).toBe(78);
  });
});
