import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'

const utilityUrl = new URL('../src/utils/chatComposerAvailability.ts', import.meta.url)
const source = await readFile(utilityUrl, 'utf8')
const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2020' })
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`
const {
  isChatComposerIntegrationRouteConnected,
  isNativeWhatsAppComposerRouteConnected
} = await import(moduleUrl)

const disconnected = {
  highLevelConnected: false,
  metaMessengerConnected: false,
  metaInstagramConnected: false,
  emailConnected: false
}

assert.equal(isChatComposerIntegrationRouteConnected('highlevel', disconnected), false)
assert.equal(isChatComposerIntegrationRouteConnected('messenger', disconnected), false)
assert.equal(isChatComposerIntegrationRouteConnected('instagram', disconnected), false)
assert.equal(isChatComposerIntegrationRouteConnected('email', disconnected), false)

assert.equal(isChatComposerIntegrationRouteConnected('highlevel', {
  ...disconnected,
  highLevelConnected: true
}), true)
assert.equal(isChatComposerIntegrationRouteConnected('messenger', {
  ...disconnected,
  metaMessengerConnected: true
}), true)
assert.equal(isChatComposerIntegrationRouteConnected('instagram', {
  ...disconnected,
  metaInstagramConnected: true
}), true)
assert.equal(isChatComposerIntegrationRouteConnected('email', {
  ...disconnected,
  emailConnected: true
}), true)

assert.equal(isNativeWhatsAppComposerRouteConnected({
  businessPhoneValue: '+526561111111',
  apiAvailable: true,
  qrReady: false
}), true)
assert.equal(isNativeWhatsAppComposerRouteConnected({
  businessPhoneValue: '+526561111111',
  apiAvailable: false,
  qrReady: true
}), true)
assert.equal(isNativeWhatsAppComposerRouteConnected({
  businessPhoneValue: '+526561111111',
  apiAvailable: false,
  qrReady: false
}), false)
assert.equal(isNativeWhatsAppComposerRouteConnected({
  businessPhoneValue: '',
  apiAvailable: true,
  qrReady: false
}), false)

const [desktopSource, phoneSource] = await Promise.all([
  readFile(new URL('../src/pages/DesktopChat/DesktopChat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/PhoneChat/PhoneChat.tsx', import.meta.url), 'utf8')
])

for (const [surface, surfaceSource] of [['desktop', desktopSource], ['movil', phoneSource]]) {
  assert.match(
    surfaceSource,
    /isChatComposerIntegrationRouteConnected\('highlevel'/,
    `${surface} debe ocultar las rutas HighLevel desconectadas`
  )
  assert.match(
    surfaceSource,
    /isChatComposerIntegrationRouteConnected\((?:option\.value|'messenger')/,
    `${surface} debe filtrar las rutas sociales por conexión`
  )
  assert.match(
    surfaceSource,
    /isNativeWhatsAppComposerRouteConnected\(/,
    `${surface} debe ocultar remitentes WhatsApp sin transporte listo`
  )
}

console.log('Chat composer connected-channel availability OK')
