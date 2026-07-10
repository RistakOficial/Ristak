#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_DIR="${SCRIPT_DIR:h}"
DESTINATION="${RISTAK_IOS_DESTINATION:-platform=iOS Simulator,name=Ristak iPhone}"
RESULT_BUNDLE="${RISTAK_LIVE_RESULT_BUNDLE:-${TMPDIR:-/tmp}/RistakLiveSmoke-$(date +%Y%m%d-%H%M%S).xcresult}"

export RISTAK_LIVE_SMOKE=1
rm -rf "$RESULT_BUNDLE"

print "Smoke opt-in de la app real. Usa únicamente la sesión/configuración ya guardada en el simulador."
print "El script no solicita, imprime ni inyecta credenciales."

xcodebuild test \
  -project "$APP_DIR/Ristak.xcodeproj" \
  -scheme Ristak \
  -destination "$DESTINATION" \
  -resultBundlePath "$RESULT_BUNDLE" \
  -only-testing:RistakUITests/RistakUITests/testLiveAppSurfaceSmokeOptIn

print "Resultado smoke real: $RESULT_BUNDLE"
