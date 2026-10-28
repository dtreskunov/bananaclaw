import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readVersionPin } from './lib/version-pins.js';

const REPO = 'dtreskunov/agent-vault';
const WORKFLOW = `${REPO}/.github/workflows/gateway-release.yml`;
const RELEASES: Record<string, { commit: string; hashes: Record<string, string> }> = {
  'gw-v0.1.1': {
    commit: '32f233b2ebc53786ab4e74b28fc4ef6d75e674e9',
    hashes: {
      linux_amd64: '474b807a88bb227901d5fa03c9cc1ec90a2f69573ce46af4d476fd14f906c9e6',
      linux_arm64: '70d619482c0a931b1cd5f33f8d8b0b616017f811f7e9bc788616c6eb35d04c79',
      darwin_arm64: 'c1db265b207574459126a3d438de4e86cab727ef96620bdbb56587e7de08c7a1',
    },
  },
};

export function gatewayRelease(platform: string = process.platform, arch: string = process.arch) {
  const version = readVersionPin('agent-vault-gateway');
  const release = RELEASES[version];
  if (!release) throw new Error(`No reviewed Agent Vault release metadata for ${version}`);
  const target = `${platform}_${arch === 'x64' ? 'amd64' : arch}`;
  const sha256 = release.hashes[target];
  if (!sha256) throw new Error(`Unsupported Agent Vault platform: ${platform}/${arch}`);
  return { version, commit: release.commit, sha256, asset: `agent-vault_${version}_${target}` };
}

export function verifyGatewayRelease(directory: string, release: ReturnType<typeof gatewayRelease>): string {
  const binary = path.join(directory, release.asset);
  const digest = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  if (digest !== release.sha256) throw new Error(`Pinned SHA-256 mismatch for ${release.asset}`);
  const entries = fs
    .readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.endsWith(`  ${release.asset}`));
  if (entries.length !== 1 || entries[0] !== `${release.sha256}  ${release.asset}`) {
    throw new Error(`Release checksum manifest mismatch for ${release.asset}`);
  }
  execFileSync(
    'gh',
    [
      'attestation',
      'verify',
      binary,
      '--repo',
      REPO,
      '--bundle',
      path.join(directory, 'build-provenance.jsonl'),
      '--signer-workflow',
      WORKFLOW,
      '--source-ref',
      `refs/tags/${release.version}`,
      '--source-digest',
      release.commit,
      '--deny-self-hosted-runners',
    ],
    { stdio: 'inherit' },
  );
  return binary;
}

/** Downloads into a new staging directory only; never installs or restarts a service. */
export function downloadGatewayRelease(directory: string): string {
  const release = gatewayRelease();
  try {
    execFileSync('gh', ['attestation', 'verify', '--help'], { stdio: 'pipe' });
  } catch (cause) {
    throw new Error('A recent GitHub CLI with gh attestation verify support is required; nothing was installed.', {
      cause,
    });
  }
  fs.mkdirSync(directory, { mode: 0o700 });
  execFileSync(
    'gh',
    [
      'release',
      'download',
      release.version,
      '--repo',
      REPO,
      '--dir',
      directory,
      ...[
        release.asset,
        'SHA256SUMS',
        'build-provenance.jsonl',
        'LICENSE',
        'MCP-SDK-LICENSE',
        'MCP-SDK-NOTICE',
      ].flatMap((asset) => ['--pattern', asset]),
    ],
    { stdio: 'inherit' },
  );
  return verifyGatewayRelease(directory, release);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3)
      throw new Error('Usage: pnpm exec tsx setup/agent-vault-release.ts <new-staging-directory>');
    const binary = downloadGatewayRelease(path.resolve(process.argv[2]!));
    console.log(`Verified release (not installed): ${binary}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
