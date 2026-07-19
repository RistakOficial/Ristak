import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const setupSource = await readFile(
  new URL('../../frontend/src/pages/Login/Setup.tsx', import.meta.url),
  'utf8'
)

test('el onboarding gestionado nunca cae a crear una segunda contraseña', () => {
  assert.doesNotMatch(setupSource, /setAutoSetup\(['"]manual['"]\)/)
  assert.match(setupSource, /if \(tokenState\.loading \|\| tokenModeReady\)/)
  assert.match(setupSource, /const installerLoginMode = tokenState\.requiresToken && !tokenState\.valid/)
  assert.match(setupSource, /if \(installerLoginMode\) \{\s*await login\(effectiveEmail, password\)/)
})
