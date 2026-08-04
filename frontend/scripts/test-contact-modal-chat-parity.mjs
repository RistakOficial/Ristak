import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [contactModalSource, desktopChatSource, desktopChatStyles] = await Promise.all([
  readFile(new URL('../src/components/common/ContactDetailsModal/ContactDetailsModal.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/DesktopChat/DesktopChat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/DesktopChat/DesktopChat.module.css', import.meta.url), 'utf8')
])

assert.match(
  contactModalSource,
  /<LazyEmbeddedDesktopChat embeddedContact=\{embeddedChatContact\} \/>/,
  'la ficha de Contactos debe montar el runtime real de Desktop Chat'
)
assert.match(
  contactModalSource,
  /data-contact-chat-shared-runtime="desktop-chat"/,
  'la superficie compartida debe quedar identificable para QA'
)
assert.doesNotMatch(
  contactModalSource,
  /hasSingleResult\s*\?\s*renderContactChatPanel\(\)/,
  'la ficha no debe volver a renderizar su compositor legacy'
)
assert.doesNotMatch(
  contactModalSource,
  /subscribeToChatLiveEvents/,
  'la ficha no debe abrir una segunda suscripción live paralela al chat compartido'
)
assert.doesNotMatch(
  contactModalSource,
  /<ChatScheduleModal/,
  'la ficha no debe montar otro modal independiente de mensajes programados'
)

assert.match(
  desktopChatSource,
  /embeddedContact\?: Contact \| null/,
  'Desktop Chat debe conservar su contrato embebible por contacto'
)
assert.match(
  desktopChatSource,
  /data-desktop-chat-embedded=\{embeddedMode \? 'true' : undefined\}/,
  'el runtime debe exponer su modo embebido sin alterar la ruta principal'
)
assert.match(
  desktopChatSource,
  /if \(embeddedMode\) \{[\s\S]*?setChatsLoading\(false\)[\s\S]*?return[\s\S]*?\}/,
  'el modo embebido no debe descargar la bandeja completa de conversaciones'
)
assert.match(desktopChatSource, /<span>Plantillas<\/span>/, 'el menú compartido debe conservar plantillas')
assert.match(desktopChatSource, /<span>Fotos y videos<\/span>/, 'el menú compartido debe conservar multimedia')
assert.match(desktopChatSource, /<span>Documentos<\/span>/, 'el menú compartido debe conservar documentos')
assert.match(desktopChatSource, /<span>Ubicación<\/span>/, 'el menú compartido debe conservar ubicación')
assert.match(desktopChatSource, /<span>CLABE<\/span>/, 'el menú compartido debe conservar CLABE')
assert.match(desktopChatSource, /aria-label=\{voiceRecording \? 'Terminar grabación'/, 'el compositor compartido debe conservar notas de voz')
assert.match(desktopChatSource, /renderScheduledMessageActions\(message\)/, 'el historial compartido debe conservar acciones de programados')

assert.match(
  desktopChatStyles,
  /\.chatShell\.embeddedChatShell\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/,
  'el chat embebido debe ocupar una sola columna sin bandeja ni ficha duplicadas'
)

console.log('Contact modal uses the full Desktop Chat runtime contract OK')
