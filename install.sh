#!/bin/bash
# Prepares Call to Tasks on this computer and installs its Claude Code skill.
#   bash install.sh             install or update
#   bash install.sh --no-skill  prepare the app only, do not touch ~/.claude
# Safe to run again: it never overwrites your .env.local or config.json.
set -euo pipefail

WITH_SKILL=1
for arg in "$@"; do
  case "$arg" in
    --no-skill) WITH_SKILL=0 ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/call-to-tasks"
MARKER=".installed-by-call-to-tasks-installer"

if [ ! -f "$HERE/package.json" ] || [ ! -f "$HERE/skill/call-to-tasks/SKILL.md" ]; then
  echo "Run install.sh from inside the call-to-tasks folder you downloaded (package.json and skill/ must be beside it)." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install version 22 or newer from https://nodejs.org and run this again." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js $(node -v) is too old. Version 22 or newer is needed: https://nodejs.org" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. It comes with Node.js: reinstall Node from https://nodejs.org" >&2
  exit 1
fi

cd "$HERE"
echo "Installing the one small package the app needs..."
npm install --no-audit --no-fund --loglevel=error

if [ -f .env.local ]; then
  echo "Kept your existing .env.local"
else
  cp .env.example .env.local
  chmod 600 .env.local
  echo "Created .env.local (fill it in: README step 2 onwards)"
fi
if [ -f config.json ]; then
  echo "Kept your existing config.json"
else
  cp config.example.json config.json
  echo "Created config.json (put your team in it: README step 4)"
fi

if [ "$WITH_SKILL" -eq 1 ]; then
  # A call-to-tasks skill that this installer did not put there is backed up before anything is copied.
  if [ -d "$DEST" ] && [ ! -f "$DEST/$MARKER" ]; then
    BACKUP="$(dirname "$(dirname "$DEST")")/skill-backups/call-to-tasks-$(date +%Y%m%d-%H%M%S)"
    echo "Found an existing call-to-tasks skill. Backing it up to $BACKUP"
    mkdir -p "$(dirname "$BACKUP")"
    cp -R "$DEST" "$BACKUP"
  fi
  mkdir -p "$DEST"
  cp "$HERE/skill/call-to-tasks/SKILL.md" "$DEST/SKILL.md"
  printf '%s\n' "$HERE" > "$DEST/project-path.txt"
  touch "$DEST/$MARKER"
  echo "Installed the Claude Code skill to $DEST"
  echo "(If you move this folder later, run install.sh again so the skill can find it.)"
fi

echo
echo "Next:"
echo "  npm test        offline tests, no accounts needed"
echo "  npm run demo    see the sample call go through the pipeline, offline"
echo "  then follow README.md from step 2, or say \"set up call to tasks\" in Claude Code"
