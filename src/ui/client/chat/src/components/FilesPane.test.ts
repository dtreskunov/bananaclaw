import { afterEach, expect, it, vi } from 'vitest';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
const hooks = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
}));
vi.mock('preact/hooks', async (original) => ({
  ...(await original<typeof import('preact/hooks')>()),
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => {
    hooks.effects.push(effect);
  },
}));
vi.mock('../uploads', async (original) => ({
  ...(await original<typeof import('../uploads')>()),
  uploadFiles: vi.fn(),
}));

import { groupId, groups } from '../state';
import { uploadFiles } from '../uploads';
import { FilesPane } from './FilesPane';

const disposers: (() => void)[] = [];

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  hooks.effects = [];
  groupId.value = null;
  groups.value = [];
  vi.clearAllMocks();
});

it('uploads dropped files without a drop-zone banner', () => {
  groupId.value = 'group';
  groups.value = [{ id: 'group', name: 'Group', isAdmin: true, lastActivityAt: null }];
  const body = FilesPane().props.children;
  expect(JSON.stringify(body)).not.toMatch(/dropzone|drop-hint/);
  const target = Object.assign(new EventTarget(), { classList: { toggle: vi.fn() } });
  body.ref.current = target;
  hooks.effects.splice(0).forEach((effect) => {
    const dispose = effect();
    if (dispose) disposers.push(dispose);
  });
  const files = [new File(['test'], 'upload.txt')];
  const event = new Event('drop', { cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files },
  });
  target.dispatchEvent(event);
  expect(uploadFiles).toHaveBeenCalledExactlyOnceWith(files);
});
