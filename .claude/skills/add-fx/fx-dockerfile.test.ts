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

  // The toolchain is only worth downloading when fx was actually asked for, so
  // the build stage is selected by name rather than guarded by a shell `if`.
  test('skips the build toolchain entirely when fx is off', () => {
    expect(dockerfile).toMatch(/^FROM node:22-slim AS fx-build-false$/m);
    expect(dockerfile).toMatch(/^FROM node:22-slim AS fx-build-true$/m);
    expect(dockerfile).toMatch(/^FROM fx-build-\$\{INSTALL_FX\} AS fx-artifacts$/m);
  });

  test('pins a version rather than tracking latest', () => {
    expect(dockerfile).toMatch(/^ARG FX_VERSION=v\d+\.\d+\.\d+$/m);
    expect(dockerfile).not.toContain('releases.fx.sh/latest');
  });

  // fx's GitHub releases lag its git tags by several minor versions, so it is
  // built from source. A tag can be repointed at a different commit; the commit
  // hash is the thing that actually pins the source, and FX_VERSION is only its
  // human-readable label. Fetching by hash also makes a moved tag a hard error.
  test('builds fx from a commit-pinned source checkout', () => {
    expect(dockerfile).toMatch(/^ARG FX_COMMIT=[0-9a-f]{40}$/m);
    expect(dockerfile).toContain('git fetch -q --depth 1 origin "$FX_COMMIT"');
    expect(dockerfile).toContain('git checkout -q FETCH_HEAD');
  });

  // ziglang.org has no official image and no stable mirror we control, so the
  // tarball is verified against the digest published alongside it.
  test('verifies the zig toolchain against pinned per-arch checksums', () => {
    expect(dockerfile).toMatch(/^ARG ZIG_VERSION=\d+\.\d+\.\d+$/m);
    expect(dockerfile).toMatch(/^ARG ZIG_SHA256_X86_64=[0-9a-f]{64}$/m);
    expect(dockerfile).toMatch(/^ARG ZIG_SHA256_AARCH64=[0-9a-f]{64}$/m);
    expect(dockerfile).toContain('sha256sum -c -');
  });

  // `-Dtarget` is not redundant with the build host's arch: a native build
  // bakes in the builder's CPU features and then faults with SIGILL on older
  // hardware pulling the same image.
  test('builds for an explicit target rather than native', () => {
    expect(dockerfile).toContain('-Dtarget="${zigarch}-linux"');
  });
});
