import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const centerSource = await readFile(
  new URL('../src/components/common/NotificationCenter/NotificationCenter.tsx', import.meta.url),
  'utf8'
)
const headerSource = await readFile(
  new URL('../src/components/layout/Header/Header.tsx', import.meta.url),
  'utf8'
)
const serviceSource = await readFile(
  new URL('../src/services/notificationsService.ts', import.meta.url),
  'utf8'
)

assert.match(headerSource, /<NotificationCenter\s*\/>/, 'el Header debe usar el centro de notificaciones compartido')
assert.match(centerSource, />\s*Marcar todas\s*</, 'el menú debe permitir marcar todas como leídas')
assert.match(centerSource, />\s*Marcar leída\s*</, 'cada aviso nuevo debe poder marcarse de forma individual')
assert.match(centerSource, />\s*Ver historial\s*</, 'el menú debe ofrecer acceso al historial')
assert.doesNotMatch(centerSource, /localStorage|NOTIFICATION_SEEN_KEY/, 'el estado leído no debe depender del navegador')
assert.doesNotMatch(centerSource, /if\s*\(nextOpen\)[\s\S]{0,120}mark/, 'abrir el menú no debe marcar avisos automáticamente')
assert.match(serviceSource, /\/settings\/notifications\/read-all/, 'el frontend debe persistir la lectura masiva')
assert.match(serviceSource, /\/settings\/notifications\/read/, 'el frontend debe persistir la lectura individual')

console.log('Notification center contract OK')
