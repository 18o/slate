#!/usr/bin/env bash
# Build all frontend assets and compile them into the Rust binary.
#
# Usage:
#   ./build.sh                # Build all examples
#   ./build.sh react-salvo    # Build specific example
#
# Prerequisites: Node.js 20+, npm 10+
#
# The repo uses npm workspaces — running `npm install` at the root
# installs ALL adapter + example dependencies at once.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

ensure_installed() {
  if [ ! -d "$REPO_ROOT/node_modules" ]; then
    echo "📦 Installing workspace dependencies (first time only)..."
    (cd "$REPO_ROOT" && npm install)
  fi
}

build_example() {
  local name="$1"
  local example_dir="$REPO_ROOT/examples/$name"
  local frontend_dir="$example_dir/frontend"
  local build_dir="$example_dir/build"

  echo ""
  echo "━━━ Building $name ━━━"

  if [ ! -d "$frontend_dir" ]; then
    echo "  ⏭  No frontend/ directory, skipping"
    return
  fi

  # Build frontend → IIFE bundle
  echo "  🔨 Building frontend..."
  (cd "$frontend_dir" && npm run build)

  # Verify output
  if [ -f "$build_dir/entry.js" ]; then
    local size
    size=$(wc -c < "$build_dir/entry.js" | tr -d ' ')
    echo "  ✅ entry.js ($size bytes)"
  else
    echo "  ❌ build/entry.js not found!"
    return 1
  fi

  # List client assets
  if [ -d "$build_dir/client" ]; then
    local count
    count=$(find "$build_dir/client" -type f | wc -l | tr -d ' ')
    echo "  ✅ client/ ($count files)"
  fi
}

ensure_installed

if [ $# -eq 0 ]; then
  # Build all examples with frontend directories
  for dir in "$REPO_ROOT"/examples/*/; do
    name=$(basename "$dir")
    if [ -d "$dir/frontend" ]; then
      build_example "$name"
    fi
  done
else
  build_example "$1"
fi

echo ""
echo "━━━ Done ━━━"
echo "Run any example:"
echo "  cd examples/react-salvo && cargo run"
echo "  cd examples/vue-salvo && cargo run"
echo "  cd examples/sveltekit-salvo && cargo run"
echo "  cd examples/sveltekit-axum && cargo run"
