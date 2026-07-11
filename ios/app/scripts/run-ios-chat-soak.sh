#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_DIR="${SCRIPT_DIR:h}"
DESTINATION="${RISTAK_IOS_DESTINATION:-platform=iOS Simulator,name=Ristak iPhone}"
RESULT_BUNDLE="${RISTAK_SOAK_RESULT_BUNDLE:-${TMPDIR:-/tmp}/RistakChatSoak-$(date +%Y%m%d-%H%M%S).xcresult}"
DERIVED_DATA="${RISTAK_SOAK_DERIVED_DATA:-${TMPDIR:-/tmp}/RistakChatSoakDerived-$(date +%Y%m%d-%H%M%S)}"

export RISTAK_SOAK_CHAT_COUNT="${RISTAK_SOAK_CHAT_COUNT:-10000}"
export RISTAK_SOAK_ITERATIONS="${RISTAK_SOAK_ITERATIONS:-250}"

case "$RESULT_BUNDLE" in
  /*.xcresult) ;;
  *) print -u2 "RISTAK_SOAK_RESULT_BUNDLE debe ser una ruta absoluta terminada en .xcresult"; exit 64 ;;
esac
rm -rf -- "$RESULT_BUNDLE"

print "Soak sintético de render/scroll: ${RISTAK_SOAK_CHAT_COUNT} chats, ${RISTAK_SOAK_ITERATIONS} iteraciones"
print "Alcance: UI local sin sesión ni red; no valida backend ni proveedores externos."

xcodebuild test \
  -project "$APP_DIR/Ristak.xcodeproj" \
  -scheme Ristak \
  -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED_DATA" \
  -resultBundlePath "$RESULT_BUNDLE" \
  -only-testing:RistakUITests/RistakUITests/testSyntheticChatSoak

print "Resultado soak: $RESULT_BUNDLE"
