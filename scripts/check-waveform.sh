#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
BUILD_ROOT="${VOICE_BUILD_ROOT:-/private/tmp/voicestack-build}"
result=0
swift test --package-path Packages/VoiceStackCore --scratch-path "$BUILD_ROOT/core" --disable-index-store --filter AudioLevelTests || result=1
PRODUCTS="$BUILD_ROOT/core/out/Products/Debug"
SOURCES="$BUILD_ROOT/meter-check-sources"
mkdir -p "$SOURCES"
cp Apps/Shared/NativeAudio.swift Apps/Shared/VoiceModel.swift Tests/NativeMeterCheck.swift "$SOURCES/"
xcrun swiftc -swift-version 5 -parse-as-library -I "$PRODUCTS" -L "$PRODUCTS" -lVoiceStackCore "$SOURCES/NativeAudio.swift" "$SOURCES/VoiceModel.swift" "$SOURCES/NativeMeterCheck.swift" -o "$BUILD_ROOT/native-meter-check"
"$BUILD_ROOT/native-meter-check" || result=1
exit "$result"
