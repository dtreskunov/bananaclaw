# Before every commit

Follow the repository's [code-metrics skill](../.claude/skills/code-metrics/SKILL.md).
After staging the final intended changes and before creating every commit, run:

```bash
pnpm exec tsx .claude/skills/code-metrics/scripts/compare.ts --staged
```

Summarize HEAD-to-index LOC and complexity deltas and notable hotspots. Do not
substitute the working tree or a weekly comparison. Surface analysis failures;
rerun whenever staged content changes, including restaged hook-generated edits.
Metrics supplement normal tests and typechecks, and do not impose a regression
threshold. Do not stage changes or create a commit merely to run the analysis.
