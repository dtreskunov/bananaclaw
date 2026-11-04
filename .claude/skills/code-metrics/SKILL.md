---
name: code-metrics
description: Compare lines of code (LOC) and cyclomatic complexity between Git revisions, against one week ago, or before a commit using the staged index. Use for code size, complexity trends, hotspots, and pre-commit metrics. Caches unchanged Git blobs locally.
---

# Code metrics

Run from the repository root using the existing host dependencies. This utility
does not install packages, change tracked files, stage changes, or create commits.

## Historical comparison

Default: the last ancestor commit before seven days ago versus `HEAD`.

```bash
pnpm exec tsx .claude/skills/code-metrics/scripts/compare.ts
```

For another period or explicit revisions:

```bash
pnpm exec tsx .claude/skills/code-metrics/scripts/compare.ts --days 14
pnpm exec tsx .claude/skills/code-metrics/scripts/compare.ts --from <base-ref> --to <target-ref>
```

The cutoff is relative to the current time, not the latest commit's timestamp.
Both resolved commit IDs are printed. If history does not reach the cutoff, use
an explicit base rather than inventing a baseline.

## Before every commit

After staging the intended changes, and after any formatter/build hook changes
have been staged, run:

```bash
pnpm exec tsx .claude/skills/code-metrics/scripts/compare.ts --staged
```

This compares **HEAD against the staged index only**, not the working tree and
not the one-week baseline. An initial commit compares against an empty snapshot.
Unmerged index entries are an error.

Before creating the commit:

1. Ensure the command succeeds; surface errors instead of claiming metrics ran.
2. Summarize non-test LOC and total/average complexity deltas, test/support LOC
   growth, and notable hotspots. Distinguish unchanged hotspots from regressions.
3. If anything is staged afterward, rerun against the final index. This includes
   restaging changes made by a pre-commit hook.

This is a reporting requirement, not a regression threshold or a Git hook.
Do not silently remove code, suppress results, or block solely on an increase.
Run normal targeted tests/typechecks separately; metrics do not replace them.

## Measurement and reporting

- Scope: Git-tracked TS/TSX/JS/JSX/MTS/CTS/MJS/CJS regular files, including tooling
  and skills. Excludes `dist`, `build`, `coverage`, `vendor`, and `node_modules`
  directories and symlinks. No working-tree or untracked content is measured.
- LOC: nonblank physical lines containing a non-comment parser token.
- Complexity: the installed ESLint `complexity` rule's `classic` variant, per
  function. Includes logical/optional/default-parameter branches; excludes
  top-level code and implicit class-field/static-block paths.
- Tests/support: test/spec/fixture filenames and test, fixture, and test-helper
  directories are reported separately. This is classification, not coverage.
- Compare both size and complexity: totals, average, p95, functions above 20,
  maximum, and branch points per KLOC. Use the component breakdown and file
  deltas to explain where growth occurred. File moves can appear as additions
  and deletions; do not describe them as wholly new functionality.
- Summarize findings rather than dumping JSON. When linking hotspots, use current
  working-tree locations only if they match the measured snapshot.

Add `--json` for machine-readable results, including resolved snapshots,
methodology, aggregates, hotspots, file deltas, and cache statistics.

## Cache

Per-blob results persist under the repository's Git common directory:
`code-metrics-cache/v1-<eslint>-<parser>-<typescript>/`.
Linked worktrees share this cache. Keys include the content hash and extension;
renames reuse results, while changed blobs or analyzer versions are remeasured.
Aggregates are rebuilt for each comparison, so staging and classification
changes cannot reuse stale snapshot totals.

`--no-cache` bypasses persistent reads/writes for verification. A corrupt cache
entry is an explicit error naming the entry; remove that specific file and
retry. Cache writes are atomic and safe for concurrent comparisons. Nothing
is uploaded.

## Validation

```bash
pnpm exec vitest run --config vitest.skills.config.ts .claude/skills/code-metrics/tests/compare.test.ts
```
