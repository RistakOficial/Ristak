#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_DIR="${SCRIPT_DIR:h}"
DESTINATION="${RISTAK_IOS_DESTINATION:-platform=iOS Simulator,name=Ristak iPhone}"
RESULT_BUNDLE="${RISTAK_LIVE_RESULT_BUNDLE:-${TMPDIR:-/tmp}/RistakLiveSmoke-$(date +%Y%m%d-%H%M%S).xcresult}"
DERIVED_DATA="${RISTAK_LIVE_DERIVED_DATA:-${TMPDIR:-/tmp}/RistakLiveSmokeDerived-$(date +%Y%m%d-%H%M%S)}"

export RISTAK_LIVE_SMOKE=1
# xcodebuild no hereda variables arbitrarias al proceso de XCTest. El prefijo
# TEST_RUNNER_ es el contrato oficial para pasarlas al runner y se elimina al
# iniciar la prueba, por lo que XCTest recibe RISTAK_LIVE_SMOKE=1.
export TEST_RUNNER_RISTAK_LIVE_SMOKE=1
case "$RESULT_BUNDLE" in
  /*.xcresult) ;;
  *) print -u2 "RISTAK_LIVE_RESULT_BUNDLE debe ser una ruta absoluta terminada en .xcresult"; exit 64 ;;
esac
rm -rf -- "$RESULT_BUNDLE"

print "Smoke opt-in de la app real. Usa únicamente la sesión/configuración ya guardada en el simulador."
print "El script no solicita, imprime ni inyecta credenciales."

xcodebuild test \
  -project "$APP_DIR/Ristak.xcodeproj" \
  -scheme Ristak \
  -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED_DATA" \
  -resultBundlePath "$RESULT_BUNDLE" \
  -only-testing:RistakUITests/RistakUITests/testLiveAppSurfaceSmokeOptIn

print "Resultado smoke real: $RESULT_BUNDLE"
