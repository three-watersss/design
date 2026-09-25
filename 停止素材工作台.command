#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
node scripts/stop.mjs
