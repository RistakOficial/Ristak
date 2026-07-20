import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const setupSource = await readFile(
  new URL('../../frontend/src/pages/Login/Setup.tsx', import.meta.url),
  'utf8'
)
const authControllerSource = await readFile(
  new URL('../src/controllers/authController.js', import.meta.url),
  'utf8'
)

test('el onboarding gestionado nunca cae a crear una segunda contraseña', () => {
  assert.doesNotMatch(setupSource, /setAutoSetup\(['"]manual['"]\)/)
  assert.match(setupSource, /if \(tokenState\.loading \|\| tokenModeReady\)/)
  assert.match(setupSource, /const installerLoginMode = tokenState\.requiresToken && !tokenState\.valid/)
  assert.match(setupSource, /if \(installerLoginMode\) \{\s*await login\(effectiveEmail, password\)/)
})

test('el onboarding gestionado conserva Google cuando el enlace falta o venció', () => {
  assert.match(setupSource, /installerLoginMode && \(\s*<>\s*<GoogleLoginButton/)
  assert.match(setupSource, /window\.location\.href = await requestGoogleLoginUrl\(redirectPath\)/)
  assert.match(setupSource, /la contraseña que creaste en Ristak/i)
})

test('el primer SSO crea al dueño Google sin pedir ni guardar su contraseña de Google', () => {
  assert.match(authControllerSource, /Primer usuario creado desde acceso seguro del Installer/)
  assert.match(authControllerSource, /peeked\.password_hash \|\| hashPassword\(crypto\.randomBytes/)
})
