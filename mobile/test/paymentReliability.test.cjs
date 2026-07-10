const assert = require('node:assert/strict');
const fs = require('node:fs');
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
