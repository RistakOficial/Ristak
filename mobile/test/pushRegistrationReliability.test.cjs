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

const {
  getNativePushRegistrationRetryDelay,
  shouldAutoRegisterNativePush,
  shouldOpenNativeNotificationSettings,
  shouldRetryNativePushRegistration,
} = require('../src/pushRegistrationReliability.ts');

test('el registro automatico nunca abre el permiso nativo', () => {
  assert.equal(shouldAutoRegisterNativePush('granted'), true);
  assert.equal(shouldAutoRegisterNativePush('prompt'), false);
  assert.equal(shouldAutoRegisterNativePush('denied'), false);
  assert.equal(shouldAutoRegisterNativePush('unsupported'), false);
});

test('un permiso ya negado se corrige desde los ajustes del sistema', () => {
  assert.equal(shouldOpenNativeNotificationSettings('denied'), true);
  assert.equal(shouldOpenNativeNotificationSettings('prompt'), false);
  assert.equal(shouldOpenNativeNotificationSettings('granted'), false);
});

test('reintenta fallas transitorias de registro push Android', () => {
  assert.equal(shouldRetryNativePushRegistration('failed'), true);
  assert.equal(shouldRetryNativePushRegistration('not_configured'), true);
  assert.equal(shouldRetryNativePushRegistration('subscribed'), false);
  assert.equal(shouldRetryNativePushRegistration('denied'), false);
  assert.equal(shouldRetryNativePushRegistration('not_supported'), false);
});

test('usa espera progresiva y limita el ultimo intervalo', () => {
  assert.equal(getNativePushRegistrationRetryDelay(0), 5_000);
  assert.equal(getNativePushRegistrationRetryDelay(1), 15_000);
  assert.equal(getNativePushRegistrationRetryDelay(2), 60_000);
  assert.equal(getNativePushRegistrationRetryDelay(99), 300_000);
});
