# Before every commit

Follow the repository's [code-metrics skill](../.claude/skills/code-metrics/SKILL.md).
After staging the final intended changes and before creating every commit, run:

```bash
pnpm exec tsx .claude/skills/code-metrics/scripts/compare.ts --staged
```

Summarize HEAD-to-index production LOC/complexity deltas and hotspots, with
tests/support and tooling/setup reported separately. Non-test code is not
automatically production: coding-agent skills and metrics utilities are tooling.
Do not substitute the working tree or a weekly comparison. Surface analysis failures;
rerun whenever staged content changes, including restaged hook-generated edits.
Metrics supplement normal tests and typechecks, and do not impose a regression
threshold. Do not stage changes or create a commit merely to run the analysis.
