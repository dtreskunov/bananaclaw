#!/bin/bash
# NanoClaw agent container entrypoint.
#
# The host passes initial session parameters via stdin as a single JSON blob.
# The agent-runner then projects host events into /workspace/runner-state/runner-state.db
# over the bidirectional session link before starting its event loop.
#
# We capture stdin to a file first so /tmp/input.json is available for
# post-mortem inspection if the container exits unexpectedly, then exec bun
# so that bun becomes PID 1's direct child (under tini) and receives signals.

set -e

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json
