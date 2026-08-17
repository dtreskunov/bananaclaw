## Task scheduling (`schedule_task`)

For any recurring task, use `schedule_task`. This is the scheduling path — tasks persist across sessions and restarts, and support the pre-task `script` hook described below.

To inspect or change existing tasks, use `list_tasks` (returns one row per series with the stable id) and `update_task` / `cancel_task` / `pause_task` / `resume_task`. Prefer `update_task` over cancel + reschedule.

Frequent recurring scheduled tasks — more than a few times a day — consume API credits and can risk account restrictions. You can add a `script` that runs first, and you will only be called when the check passes.

### How it works

1. Provide a bash `script` alongside the `prompt` when scheduling
2. When the task fires, the script runs first
3. Script returns: `{ "wakeAgent": true/false, "data": {...} }`
4. If `wakeAgent: false` — the occurrence is recorded as skipped and the task waits for its next run
5. If `wakeAgent: true` — claude receives the script's data + prompt and handles

The final non-empty line on stdout must be the JSON object above, and the
script must exit with status 0. A nonzero exit, malformed/missing JSON, or an
expired timeout fails the occurrence without invoking the provider. Earlier
stdout and stderr are retained as diagnostic output.

`scriptTimeoutMs` is optional and defaults to 600000 milliseconds. It accepts
values from 1000 through 900000. On timeout or output overflow, NanoClaw
terminates the script's entire process group so child processes cannot continue
mutating data after the occurrence has failed.

Every execution is stored as a distinct attempt with its trigger source,
script outcome, provider invocation, duration, and terminal status. Clicking
Run now creates a manual occurrence and does not move or replace the pending
scheduled occurrence. Manual attempts therefore do not alter recurrence
cadence or count toward the recurrence failure policy.

A recurring task is automatically paused after three consecutive failed or
timed-out scheduled attempts. A completed or intentionally skipped scheduled
attempt resets that count. Inspect recent attempts and repair the task before
resuming it.

### Always test your script first

Before scheduling, run the script directly to verify it works:

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

### When NOT to use scripts

If a task requires your judgment every time (daily briefings, reminders, reports), skip the script — just use a regular prompt. Do not attempt to do things like sentiment analysis or advanced nlp in scripts.

### Frequent task guidance

If a user wants a task to run more than a few times a day and a script can't be used:

- Explain that each time the task fires it uses API credits and risks rate limits
- Suggest adjusting the task requirements in a way that will allow you to use a script
- If the user needs an LLM to evaluate data, suggest using an API key with direct Anthropic API calls inside the script
- Help the user find the minimum viable frequency
