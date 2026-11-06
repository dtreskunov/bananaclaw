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
2. Summarize production LOC and total/average complexity deltas, test/support and
   tooling growth separately, and production hotspots. Distinguish unchanged
   hotspots from regressions. Non-test code is not automatically production code.
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
- Categories are mutually exclusive and cover all measured files. Apply these
  rules in order, identically to both historical and staged snapshots:
  1. **Tests/support:** test/spec/fixture/mock filenames, and test, fixture, mock,
     and test-helper directories, even when nested in a runtime tree or skill.
  2. **Tooling/setup:** scripts/setup directories, coding-agent skills, build,
     lint, and test configuration. This includes this metrics utility and its
     CLI; its tests belong to tests/support, not tooling.
  3. **Production:** remaining runtime source under `src/` (host, UI, runtime CLI)
     and `container/agent-runner/src/`. Runtime configuration such as
     `src/config.ts`, database migrations, the UI service worker, and the audio
     worklet remain production.
  4. **Tooling/setup:** other source roots, including top-level setup and
     operational scripts. Unknown roots are not assumed to be production.
     This is source-role classification, not coverage or a dependency-graph analysis.
- Compare both size and complexity: totals, average, p95, functions above 20,
  maximum, and branch points per KLOC. Use the component breakdown and file
  deltas to explain where growth occurred. File moves can appear as additions
  and deletions; do not describe them as wholly new functionality.
- Summarize findings rather than dumping JSON. When linking hotspots, use current
  working-tree locations only if they match the measured snapshot.

Add `--json` for machine-readable results, including resolved snapshots,
methodology, category totals, production hotspots, file deltas with before/after
categories, and cache statistics. `classificationVersion: 2` corrects the former
non-test-equals-production definition; old reports are not directly comparable.

For time charts, use the same exported `classifyFile` helper as this report.
Reaggregate cached per-blob measurements with the current classification on
every snapshot. Do not copy classification regexes into chart scripts. Plot only
complete totals, mark cache gaps, and provide an inline text chart/table if local
image links cannot be displayed.

## Cache

Per-blob results persist under the repository's Git common directory:
`code-metrics-cache/v1-<eslint>-<parser>-<typescript>/`.
Linked worktrees share this cache. Keys include the content hash and extension;
renames reuse results, while changed blobs or analyzer versions are remeasured.
Aggregates are rebuilt for each comparison, so staging and classification
changes cannot reuse stale snapshot totals.
Classification changes do not invalidate raw per-blob measurements: preserve the
cache and recompute category totals rather than reparsing unchanged code.

`--no-cache` bypasses persistent reads/writes for verification. A corrupt cache
entry is an explicit error naming the entry; remove that specific file and
retry. Cache writes are atomic and safe for concurrent comparisons. Nothing
is uploaded.

## Validation

```bash
pnpm exec vitest run --config vitest.skills.config.ts .claude/skills/code-metrics/tests/compare.test.ts
```
