#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir -p .data
# Keep terminal output visible and retain local startup diagnostics for debugging.
apps/agent/.venv/bin/voiceai-agent dev 2>&1 | tee .data/agent.log
