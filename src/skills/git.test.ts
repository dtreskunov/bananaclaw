import { describe, expect, it } from 'vitest';
import { gitErrorDetail } from './git.js';

describe('gitErrorDetail', () => {
  it('includes the remote failure rather than only the failed command', () => {
    const stderr = "Cloning into 'checkout'...\nremote: Repository not found.\nfatal: repository not found\n";
    const err = Object.assign(new Error('Command failed: git clone ...\n' + stderr), { stderr });
    expect(gitErrorDetail(err)).toBe(stderr.trim());
  });

  it('handles buffered stderr', () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: Buffer.from('fatal: unable to access remote\n'),
    });
    expect(gitErrorDetail(err)).toBe('fatal: unable to access remote');
  });

  it('preserves timeout or spawn errors without stderr', () => {
    expect(gitErrorDetail(new Error('spawnSync git ETIMEDOUT'))).toBe('spawnSync git ETIMEDOUT');
    expect(gitErrorDetail(Object.assign(new Error('git missing'), { stderr: '' }))).toBe('git missing');
    expect(gitErrorDetail('unknown failure')).toBe('unknown failure');
  });
});
