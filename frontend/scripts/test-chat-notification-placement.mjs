import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const toastContainerSource = await readFile(
  new URL('../src/components/common/Toast/ToastContainer.module.css', import.meta.url),
  'utf8'
)
const desktopChatSource = await readFile(
  new URL('../src/pages/DesktopChat/DesktopChat.tsx', import.meta.url),
  'utf8'
)

const desktopToastContainer = toastContainerSource.slice(
  toastContainerSource.indexOf('.container {'),
  toastContainerSource.indexOf(':global(body[data-phone-app')
)

assert.match(
  desktopToastContainer,
  /right:\s*24px;/,
  'los avisos de escritorio deben conservar el anclaje global del lado derecho'
)
assert.doesNotMatch(
  toastContainerSource,
  /data-desktop-chat-active|left:\s*24px;/,
  'Chat no debe mover el ToastContainer global al lado izquierdo'
)
assert.doesNotMatch(
  desktopChatSource,
  /dataset\.desktopChatActive/,
  'DesktopChat no debe activar excepciones visuales para los avisos globales'
)
assert.match(
  desktopChatSource,
  /const \{ showToast \} = useNotification\(\)/,
  'DesktopChat debe seguir publicando feedback mediante NotificationContext'
)

console.log('Desktop Chat notification placement contract OK')
