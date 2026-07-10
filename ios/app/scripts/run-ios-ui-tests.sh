#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_DIR="${SCRIPT_DIR:h}"
DESTINATION="${RISTAK_IOS_DESTINATION:-platform=iOS Simulator,name=Ristak iPhone}"
RESULT_BUNDLE="${RISTAK_UI_RESULT_BUNDLE:-${TMPDIR:-/tmp}/RistakUITests-$(date +%Y%m%d-%H%M%S).xcresult}"

rm -rf "$RESULT_BUNDLE"

xcodebuild test \
  -project "$APP_DIR/Ristak.xcodeproj" \
  -scheme Ristak \
  -destination "$DESTINATION" \
  -resultBundlePath "$RESULT_BUNDLE" \
  -skip-testing:RistakUITests/RistakUITests/testSyntheticChatSoak

print "Resultado XCUITest: $RESULT_BUNDLE"
