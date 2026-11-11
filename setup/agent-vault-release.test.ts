import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('./lib/version-pins.js', () => ({ readVersionPin: vi.fn(() => 'gw-v0.4.0') }));

import { downloadGatewayRelease, gatewayRelease, verifyGatewayRelease } from './agent-vault-release.js';
import { readVersionPin } from './lib/version-pins.js';

let directory: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(execFileSync).mockReset();
  vi.mocked(readVersionPin).mockReturnValue('gw-v0.4.0');
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-gateway-release-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true });
});

describe('pinned gateway release', () => {
  it.each([
    ['linux', 'x64', 'linux_amd64', '0085bc9008b637c256dbd29079ddccacba1a4014b8590d58fea5c95b17f8fa25'],
    ['linux', 'arm64', 'linux_arm64', 'f9c0e28ea23733155802133c40ef22e04066b1712556ed004849a4aaf299c7b6'],
    ['darwin', 'arm64', 'darwin_arm64', 'ec0c1c2685e403e743f800a5f3fd3e93fddcf9858042efae682fb906bc1e9ff6'],
  ])('pins %s/%s to the reviewed standalone asset', (platform, arch, target, sha256) => {
    expect(gatewayRelease(platform, arch)).toEqual({
      version: 'gw-v0.4.0',
      commit: '7f7c3fc2f3e88138d3e36ed53a15f33aab2a561b',
      asset: `agent-vault_gw-v0.4.0_${target}`,
      sha256,
    });
    expect(readVersionPin).toHaveBeenCalledWith('agent-vault-gateway');
  });

  it.each([
    ['darwin', 'x64'],
    ['win32', 'x64'],
    ['linux', 'ia32'],
  ])('rejects unsupported %s/%s', (platform, arch) => {
    expect(() => gatewayRelease(platform, arch)).toThrow('Unsupported');
  });

  it('refuses a version pin without reviewed source and checksum metadata', () => {
    vi.mocked(readVersionPin).mockReturnValue('gw-v0.5.0');
    expect(() => gatewayRelease()).toThrow('No reviewed');
  });

  it('stops before download when gh cannot verify attestations', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('unknown command attestation');
    });
    const staging = path.join(directory, 'staging');
    expect(() => downloadGatewayRelease(staging)).toThrow('recent GitHub CLI');
    expect(fs.existsSync(staging)).toBe(false);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('downloads the explicit version, notices and verification files, never latest or an archive', () => {
    expect(() => downloadGatewayRelease(path.join(directory, 'staging'))).toThrow('ENOENT');
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      'gh',
      [
        'release',
        'download',
        'gw-v0.4.0',
        '--repo',
        'dtreskunov/agent-vault',
        '--dir',
        path.join(directory, 'staging'),
        ...[
          gatewayRelease().asset,
          'SHA256SUMS',
          'build-provenance.jsonl',
          'LICENSE',
          'MCP-SDK-LICENSE',
          'MCP-SDK-NOTICE',
        ].flatMap((asset) => ['--pattern', asset]),
      ],
      { stdio: 'inherit' },
    );
  });

  it('does not reuse or overwrite an existing staging directory', () => {
    expect(() => downloadGatewayRelease(directory)).toThrow('EEXIST');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('fail-closed release verification', () => {
  function fixture() {
    const release = {
      ...gatewayRelease('linux', 'x64'),
      sha256: createHash('sha256').update('test binary').digest('hex'),
    };
    fs.writeFileSync(path.join(directory, release.asset), 'test binary');
    fs.writeFileSync(path.join(directory, 'SHA256SUMS'), `${release.sha256}  ${release.asset}\n`);
    fs.writeFileSync(path.join(directory, 'build-provenance.jsonl'), '{}\n');
    return release;
  }

  it('checks the binary against the pin, not just a matching downloaded manifest', () => {
    const release = fixture();
    expect(() => verifyGatewayRelease(directory, { ...release, sha256: '0'.repeat(64) })).toThrow(
      'Pinned SHA-256 mismatch',
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.each(['missing', 'wrong', 'duplicate'])('rejects a %s checksum entry before provenance verification', (kind) => {
    const release = fixture();
    const line = `${release.sha256}  ${release.asset}\n`;
    fs.writeFileSync(
      path.join(directory, 'SHA256SUMS'),
      kind === 'missing' ? '' : kind === 'wrong' ? `${'0'.repeat(64)}  ${release.asset}\n` : line + line,
    );
    expect(() => verifyGatewayRelease(directory, release)).toThrow('manifest mismatch');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('binds signed provenance to the exact repository, workflow, tag and source commit', () => {
    const release = fixture();
    expect(verifyGatewayRelease(directory, release)).toBe(path.join(directory, release.asset));
    expect(execFileSync).toHaveBeenCalledWith(
      'gh',
      [
        'attestation',
        'verify',
        path.join(directory, release.asset),
        '--repo',
        'dtreskunov/agent-vault',
        '--bundle',
        path.join(directory, 'build-provenance.jsonl'),
        '--signer-workflow',
        'dtreskunov/agent-vault/.github/workflows/gateway-release.yml',
        '--source-ref',
        'refs/tags/gw-v0.4.0',
        '--source-digest',
        '7f7c3fc2f3e88138d3e36ed53a15f33aab2a561b',
        '--deny-self-hosted-runners',
      ],
      { stdio: 'inherit' },
    );
  });

  it('propagates any attestation failure without returning an installable path', () => {
    const release = fixture();
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('source or signature mismatch');
    });
    expect(() => verifyGatewayRelease(directory, release)).toThrow('source or signature mismatch');
  });

  it('propagates a failed download', () => {
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => Buffer.from('help'))
      .mockImplementationOnce(() => {
        throw new Error('download failed');
      });
    expect(() => downloadGatewayRelease(path.join(directory, 'staging'))).toThrow('download failed');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});
