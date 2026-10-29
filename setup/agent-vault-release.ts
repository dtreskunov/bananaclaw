import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readVersionPin } from './lib/version-pins.js';

const REPO = 'dtreskunov/agent-vault';
const WORKFLOW = `${REPO}/.github/workflows/gateway-release.yml`;
const RELEASES: Record<string, { commit: string; hashes: Record<string, string> }> = {
  'gw-v0.2.0': {
    commit: '9a99f613d54bec30cc3709351277d39de2f3fe6e',
    hashes: {
      linux_amd64: '45d49615f380f5b7b0b4e7cec4e4bafbca5a514ccdb594e33b6cb55fd0949633',
      linux_arm64: '187097aed926dae42335112e0b55f3d1f9c3b77a37cccebf7f96e7bbb668df05',
      darwin_arm64: '295a0624f52f8df49a68e70746707683aa6f41b0d83d46e680f32f65c3cbe047',
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
