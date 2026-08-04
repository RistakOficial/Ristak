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
  /type AgentInboxStatusFilter = 'all' \| 'active' \| 'paused' \| 'completed'/,
  'la bandeja Chatbot sólo debe ofrecer el conjunto útil y sus tres estados'
)
assert.match(
  desktopChatSource,
  /const DEFAULT_AGENT_INBOX_STATUS_FILTER: AgentInboxStatusFilter = 'all'/,
  'al entrar a Chatbot se debe mostrar la unión de los chats relevantes'
)
assert.doesNotMatch(
  desktopChatSource,
  /\{ id: '(?:skipped|unassigned)', label: '(?:Omitidos|No asignados)' \}/,
  'Omitidos y No asignados no pertenecen a la bandeja Chatbot'
)
assert.match(
  desktopChatSource,
  /const hasUnreviewedGoal = contact\.agentGoalCompletedUnreviewed === true[\s\S]*return hasActiveAgent \|\| hasPausedAgent \|\| hasUnreviewedGoal/,
  'Chatbot sólo debe unir activos, pausados y metas que siguen sin revisar'
)
assert.match(
  desktopChatSource,
  /const goalCompletedUnreviewed = chatFilter === 'agent'[\s\S]*loadChats\(\{ goalCompletedUnreviewed \}\)/,
  'la bandeja debe pedir al servidor las metas pendientes de abrir'
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
assert.doesNotMatch(
  desktopChatSource,
  /styles\.(?:pageAgentInbox|inboxPanelAgent|chatRowAgentAssigned)/,
  'seleccionar Chatbot no debe cambiar el color del panel'
)
assert.doesNotMatch(
  desktopChatStyles,
  /\.(?:pageAgentInbox|inboxPanelAgent|chatRowAgentAssigned)/,
  'la bandeja Chatbot debe conservar la misma superficie visual que las demás'
)

console.log('Desktop Chat chatbot filter hierarchy contract OK')
