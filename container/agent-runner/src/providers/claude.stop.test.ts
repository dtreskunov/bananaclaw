import { expect, it, spyOn } from 'bun:test';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { ClaudeProvider } from './claude.js';
import type { ProviderEvent } from './types.js';

it('forwards cancellation to the actual Claude SDK and closes the settled query', async () => {
  let controller: AbortController | undefined;
  let closed = 0;
  const sdkQuery = spyOn(sdk, 'query').mockImplementation((input) => {
    controller = input.options?.abortController;
    const events = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'preserved-session' };
      if (!controller!.signal.aborted) {
        await new Promise<void>((resolve) =>
          controller!.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
      throw new Error('SDK interrupted');
    })();
    return Object.assign(events, {
      close() {
        closed++;
      },
    }) as unknown as ReturnType<typeof sdk.query>;
  });
  try {
    const query = new ClaudeProvider().query({
      prompt: 'cancel me',
      cwd: process.cwd(),
      continuation: 'preserved-session',
    });
    const seen: ProviderEvent[] = [];
    const consume = (async () => {
      for await (const event of query.events) {
        seen.push(event);
        if (event.type === 'init') queueMicrotask(() => query.abort());
      }
    })();
    await expect(consume).rejects.toThrow('SDK interrupted');
    expect(controller?.signal.aborted).toBe(true);
    expect(closed).toBe(1);
    expect(query.push('new work')).toBe(false);
    expect(seen).toContainEqual({ type: 'init', continuation: 'preserved-session' });
    expect(sdkQuery.mock.calls[0][0].options?.resume).toBe('preserved-session');
  } finally {
    sdkQuery.mockRestore();
  }
});
