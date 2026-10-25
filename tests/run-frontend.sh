#!/usr/bin/env bash
# Run from any directory; JavaScriptCore and WebKit require macOS.
set -euo pipefail
cd "$(dirname "$0")/.."

export SWIFT_MODULECACHE_PATH="${SWIFT_MODULECACHE_PATH:-${TMPDIR:-/tmp}/noctua-swift-module-cache}"
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$SWIFT_MODULECACHE_PATH}"
mkdir -p "$SWIFT_MODULECACHE_PATH"

for test in tests/*.swift; do
  case "$test" in
    tests/reader.swift|tests/chat-rendering.swift) continue ;;
    # Manual media generators require local inputs and are not regression tests.
    tests/pr3-recordings.swift|tests/pr3-screenshots.swift|tests/note-qol-recordings.swift) continue ;;
  esac
  echo "Running $test"
  swift -module-cache-path "$SWIFT_MODULECACHE_PATH" "$test"
done

echo "Running WebKit chat rendering checks"
swift -module-cache-path "$SWIFT_MODULECACHE_PATH" tests/chat-rendering.swift
for page in tests/fonts.html tests/selects.html tests/workspace.html tests/skill-picker.html tests/note-layout.html; do
  echo "Running WebKit checks: $page"
  swift -module-cache-path "$SWIFT_MODULECACHE_PATH" tests/reader.swift "$page"
done

# Full PDF rendering smoke tests remain manual; see docs/ci.md.
