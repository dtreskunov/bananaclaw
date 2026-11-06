import { beforeEach, expect, it, vi } from 'vitest';

const command = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFileSync: command }));
vi.mock('../../../config.js', () => ({
  CONTAINER_IMAGE: 'agent:default',
  CONTAINER_IMAGE_BASE: 'agent',
}));
vi.mock('../../../container-runtime.js', () => ({ CONTAINER_RUNTIME_BIN: 'docker' }));

beforeEach(() => {
  vi.resetModules();
  command.mockReset();
});

it('imports command metadata once into numeric image records, including epoch zero', async () => {
  command.mockReturnValue(
    [
      { Tag: 'zero', Created: 0 },
      { Tag: 'default', CreatedAt: '2026-06-04 02:10:12 +0000 UTC' },
      { tag: 'podman', Created: '2026-06-05T02:10:12.000Z' },
      { Tag: 'unknown' },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  );
  const { listImages } = await import('./image-catalog.js');
  const images = listImages();
  expect(images.map((image) => image.label)).toEqual(['podman', 'default', 'unknown', 'zero']);
  expect(images.find((image) => image.label === 'zero')?.createdAt).toBe(0);
  expect(images.find((image) => image.label === 'default')).toMatchObject({
    createdAt: 1780539012000,
    isDefault: true,
  });
  expect(images.find((image) => image.label === 'unknown')?.createdAt).toBeNull();
  expect(listImages()).toBe(images);
  expect(command).toHaveBeenCalledOnce();
});
