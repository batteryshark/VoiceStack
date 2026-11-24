#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
BUILD_ROOT="${VOICE_BUILD_ROOT:-/private/tmp/voicestack-build}"
swift test --package-path Packages/VoiceStackCore --scratch-path "$BUILD_ROOT/core" --disable-index-store
PRODUCTS="$BUILD_ROOT/core/out/Products/Debug"
SOURCES="$BUILD_ROOT/native-check-sources"
mkdir -p "$SOURCES"
CHECK_SOURCE=NativeLiveCheck
CHECK_BINARY=native-live-check
if [ "${1:-}" = --startup ]; then CHECK_SOURCE=NativeStartupCheck; CHECK_BINARY=native-startup-check; fi
if [ "${1:-}" = --listening ]; then CHECK_SOURCE=NativeAutoListenCheck; CHECK_BINARY=native-listening-check; fi
cp Apps/Shared/VoiceModel.swift Apps/Shared/NativeAudio.swift "Tests/$CHECK_SOURCE.swift" "$SOURCES/"
xcrun swiftc -swift-version 5 -parse-as-library -I "$PRODUCTS" -L "$PRODUCTS" -lVoiceStackCore \
  "$SOURCES/VoiceModel.swift" "$SOURCES/NativeAudio.swift" "$SOURCES/$CHECK_SOURCE.swift" \
  -o "$BUILD_ROOT/$CHECK_BINARY"
if [ "$CHECK_SOURCE" != NativeLiveCheck ]; then "$BUILD_ROOT/$CHECK_BINARY"
else echo "Built $BUILD_ROOT/$CHECK_BINARY; pipe pairing-code JSON on stdin and set VOICE_SWITCHBOARD_BASE to run."
fi
