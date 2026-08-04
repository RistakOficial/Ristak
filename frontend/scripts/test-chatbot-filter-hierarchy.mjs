import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [desktopChatSource, desktopChatStyles] = await Promise.all([
  readFile(new URL('../src/pages/DesktopChat/DesktopChat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/DesktopChat/DesktopChat.module.css', import.meta.url), 'utf8')
])

assert.match(
  desktopChatSource,
  /\{ id: 'agent', label: 'Chatbot', agentIcon: true \}/,
  'Chatbot debe vivir como filtro principal con el mismo icono de robot'
)
assert.doesNotMatch(
  desktopChatSource,
  /label: 'Meta completada'/,
  'Meta completada no debe seguir duplicada entre los filtros principales'
)
assert.doesNotMatch(
  desktopChatSource,
  /agentInboxButton/,
  'la entrada flotante animada del chatbot debe quedar eliminada del encabezado'
)
assert.match(
  desktopChatSource,
  /agentAssignedViewOpen && !commentsView[\s\S]*agentStatusFilterSection[\s\S]*AGENT_INBOX_STATUS_FILTERS\.map/,
  'los estados existentes del chatbot deben aparecer debajo al seleccionar Chatbot'
)
assert.match(
  desktopChatSource,
  /aria-pressed=\{filter\.id === chatFilter\}/,
  'el filtro principal Chatbot debe comunicar que permanece seleccionado'
)
assert.match(
  desktopChatStyles,
  /\.agentStatusFilterSection\s*\{[\s\S]*border-top:\s*1px solid var\(--border\)/,
  'los estados del chatbot deben tener un separador visual basado en tokens'
)
assert.doesNotMatch(
  desktopChatStyles,
  /\.inboxHeader \.agentInboxButton/,
  'los estilos de la burbuja flotante del encabezado deben quedar eliminados'
)

console.log('Desktop Chat chatbot filter hierarchy contract OK')
