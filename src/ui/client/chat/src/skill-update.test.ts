import { afterEach, describe, expect, it, vi } from 'vitest';

import { updateInstalledSkill } from './skill-update';

afterEach(() => vi.unstubAllGlobals());

describe('one-click cached skill update', () => {
  it('posts only the group to the installed skill update endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          skill: { slug: 'example', commit: 'a'.repeat(40) },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(updateInstalledSkill('group', 'example')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      '/ui/chat/api/skills/example/update',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ gid: 'group' }),
      }),
    );
  });

  it.each([400, 403, 409, 500])('surfaces HTTP %s errors without a confirmation or retry', async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'The skill was not changed.' }), { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(updateInstalledSkill('group', 'example')).rejects.toThrow('The skill was not changed.');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('surfaces network errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(updateInstalledSkill('group', 'example')).rejects.toThrow('offline');
  });

  it.each([{}, { skill: { slug: 'wrong', commit: 'a' } }, { skill: { slug: 'example' } }])(
    'does not treat a malformed success response as an update',
    async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
      await expect(updateInstalledSkill('group', 'example')).rejects.toThrow('installed skill revision');
    },
  );
});
