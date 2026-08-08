#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
bun install
bun run build
echo "Built @otto-assistant/opencode-commandcode"
echo "Install into OpenCode with: opencode plugin file://$ROOT"
