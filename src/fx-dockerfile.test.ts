import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'container/Dockerfile'), 'utf8');
const buildSh = fs.readFileSync(path.join(ROOT, 'container/build.sh'), 'utf8');

describe('fx container install', () => {
  test('is opt-in so the default image stays lean', () => {
    expect(dockerfile).toMatch(/^ARG INSTALL_FX=false$/m);
    expect(buildSh).toContain('--build-arg INSTALL_FX=true');
  });

  test('pins a version rather than tracking latest', () => {
    expect(dockerfile).toMatch(/^ARG FX_VERSION=v\d+\.\d+\.\d+$/m);
    expect(dockerfile).not.toContain('releases.fx.sh/latest');
  });

  // releases.fx.sh serves a mutable path, so the version tag alone is not a
  // supply-chain guarantee. Both per-arch digests must stay pinned and checked.
  test('verifies the download against pinned per-arch checksums', () => {
    expect(dockerfile).toMatch(/^ARG FX_SHA256_X86_64=[0-9a-f]{64}$/m);
    expect(dockerfile).toMatch(/^ARG FX_SHA256_AARCH64=[0-9a-f]{64}$/m);
    expect(dockerfile).toContain('sha256sum -c -');
  });
});
