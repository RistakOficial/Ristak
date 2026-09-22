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

const { constrainAccessConfigToLicense, hasLicenseFeatureAccess } = require('../src/utils/accessControl.ts')
const user = {
  role: 'admin', licenseEnforced: true, licensePlan: 'medium',
  licenseFeatures: { contacts: true, chat: true, team_access: true, sites: false, email: false }
}

test('el equipo puede administrar accesos sin el módulo de correo y conservar una selección parcial', () => {
  assert.equal(hasLicenseFeatureAccess(user, 'settings_users'), true)
  assert.equal(hasLicenseFeatureAccess(user, 'settings_email'), false)
  assert.equal(hasLicenseFeatureAccess(user, 'settings_custom_fields'), true)
  const access = constrainAccessConfigToLicense(user, { contacts: 'read', chat: 'none', sites: 'write', settings_email: 'write' }, 'employee')
  assert.equal(access.contacts, 'read')
  assert.equal(access.chat, 'none')
  assert.equal(access.sites, 'none')
  assert.equal(access.settings_email, 'none')
  assert.equal(access.settings_users, 'none')
})

test('administrador tampoco amplía módulos del plan; una desactivación explícita manda', () => {
  const access = constrainAccessConfigToLicense(user, { sites: 'write', contacts: 'write' }, 'admin')
  assert.equal(access.sites, 'none')
  assert.equal(access.contacts, 'write')
  assert.equal(access.settings_users, 'write')
  assert.equal(hasLicenseFeatureAccess({ ...user, licenseFeatures: { ...user.licenseFeatures, settings_custom_fields: false } }, 'settings_custom_fields'), false)
})
