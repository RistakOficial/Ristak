#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_DIR="${SCRIPT_DIR:h}"
DESTINATION="${RISTAK_IOS_DESTINATION:-platform=iOS Simulator,name=Ristak iPhone}"
RESULT_BUNDLE="${RISTAK_UI_RESULT_BUNDLE:-${TMPDIR:-/tmp}/RistakUITests-$(date +%Y%m%d-%H%M%S).xcresult}"
DERIVED_DATA="${RISTAK_UI_DERIVED_DATA:-${TMPDIR:-/tmp}/RistakUITestsDerived-$(date +%Y%m%d-%H%M%S)}"

case "$RESULT_BUNDLE" in
  /*.xcresult) ;;
  *) print -u2 "RISTAK_UI_RESULT_BUNDLE debe ser una ruta absoluta terminada en .xcresult"; exit 64 ;;
esac
rm -rf -- "$RESULT_BUNDLE"

xcodebuild test \
  -project "$APP_DIR/Ristak.xcodeproj" \
  -scheme Ristak \
  -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED_DATA" \
  -resultBundlePath "$RESULT_BUNDLE" \
  -skip-testing:RistakUITests/RistakUITests/testSyntheticChatSoak

print "Resultado XCUITest: $RESULT_BUNDLE"
