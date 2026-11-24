#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
BUILD_ROOT="${VOICE_BUILD_ROOT:-/private/tmp/voicestack-build}"
mkdir -p "$BUILD_ROOT"
npm ci --ignore-scripts --no-audit --no-fund
npm test
if command -v "${BUN:-bun}" >/dev/null 2>&1; then (cd Switchboard && "${BUN:-bun}" test)
else echo 'bun not found: skipping the Switchboard tests'
fi
swift test --package-path Packages/VoiceStackCore --scratch-path "$BUILD_ROOT/core" --disable-index-store
python3 scripts/generate-project.py
xcodebuild -project VoiceStack.xcodeproj -scheme 'VoiceStack Mac' -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath "$BUILD_ROOT/mac" CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO build
xcodebuild -project VoiceStack.xcodeproj -scheme 'VoiceStack iOS' -configuration Debug -destination 'generic/platform=iOS' -derivedDataPath "$BUILD_ROOT/ios" CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO build
