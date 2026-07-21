const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    },
    fileName: filename
  })
  module._compile(outputText, filename)
}

const { hasWebAnalyticsAccess } = require('../src/utils/accessControl.ts')

const licensedUser = (licensePlan, webAnalytics = true) => ({
  licenseEnforced: true,
  licensePlan,
  licenseFeatures: { web_analytics: webAnalytics }
})

test('la interfaz web reserva analítica web para Profesional', () => {
  assert.equal(hasWebAnalyticsAccess(licensedUser('basic')), false)
  assert.equal(hasWebAnalyticsAccess(licensedUser('medium')), false)
  assert.equal(hasWebAnalyticsAccess(licensedUser('professional')), true)
  assert.equal(hasWebAnalyticsAccess(licensedUser('premium')), true)
  assert.equal(hasWebAnalyticsAccess(licensedUser('professional', false)), false)
  assert.equal(hasWebAnalyticsAccess({ licenseEnforced: false }), true)
})

test('la interfaz web falla cerrada si el origen de features es inválido', () => {
  assert.equal(hasWebAnalyticsAccess({
    ...licensedUser('professional'),
    licenseFeaturesSourceValid: false
  }), false)
})
