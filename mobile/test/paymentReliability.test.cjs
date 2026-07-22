const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(outputText, filename);
};

const { shouldRotatePaymentAttemptAfterError } = require('../src/paymentSafety.ts');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');

test('rota el intento cuando una validacion 400/422 se puede corregir', () => {
  assert.equal(shouldRotatePaymentAttemptAfterError({ status: 400 }), true);
  assert.equal(shouldRotatePaymentAttemptAfterError({ status: 422 }), true);
});

test('conserva la llave ante timeout, conflicto, rate limit o error ambiguo', () => {
  for (const status of [402, 408, 409, 425, 429, 500, 502, 503, 504]) {
    assert.equal(shouldRotatePaymentAttemptAfterError({ status }), false, `status ${status}`);
  }
  assert.equal(shouldRotatePaymentAttemptAfterError(new Error('Network request failed')), false);
});

test('muestra pago manual, enlace y tarjeta guardada en ese orden', () => {
  const methodStep = appSource.indexOf("formStep === 'method'");
  const methodStepStart = appSource.indexOf('<View style={styles.paymentChoiceList}>', methodStep);
  const methodStepEnd = appSource.indexOf("{mode === 'subscription' ? (", methodStepStart);
  const methodStepSource = appSource.slice(methodStepStart, methodStepEnd);
  const manualIndex = methodStepSource.indexOf('title="Registrar pago manual"');
  const linkIndex = methodStepSource.indexOf('title="Enviar enlace de pago"');
  const savedCardIndex = methodStepSource.indexOf('title="Cobrar tarjeta guardada"');

  assert.ok(methodStepStart >= 0);
  assert.ok(methodStepEnd > methodStepStart);
  assert.ok(manualIndex >= 0);
  assert.ok(linkIndex > manualIndex);
  assert.ok(savedCardIndex > linkIndex);
});
