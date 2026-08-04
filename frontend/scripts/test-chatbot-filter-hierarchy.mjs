import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [
  desktopChatSource,
  desktopChatStyles,
  phoneChatSource,
  phoneChatStyles,
  androidSource,
  androidApiSource,
  androidTypesSource,
  iosFilterSource,
  iosInboxSource,
  iosInboxScreenSource,
  iosAgentServiceSource
] = await Promise.all([
  readFile(new URL('../src/pages/DesktopChat/DesktopChat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/DesktopChat/DesktopChat.module.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/PhoneChat/PhoneChat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/PhoneChat/PhoneChat.module.css', import.meta.url), 'utf8'),
  readFile(new URL('../../mobile/src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../mobile/src/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../mobile/src/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../ios/app/Ristak/Features/Chats/Shared/ChatInboxFilterModels.swift', import.meta.url), 'utf8'),
  readFile(new URL('../../ios/app/Ristak/Features/Chats/Inbox/InboxViewModel.swift', import.meta.url), 'utf8'),
  readFile(new URL('../../ios/app/Ristak/Features/Chats/Inbox/InboxScreen.swift', import.meta.url), 'utf8'),
  readFile(new URL('../../ios/app/Ristak/Core/Services/AgentStateService.swift', import.meta.url), 'utf8')
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

assert.match(phoneChatSource, /id: 'agent',[\s\S]*label: 'Chatbot',[\s\S]*quickFilter: 'agent'/, '/movil debe tener Chatbot como filtro principal')
assert.match(phoneChatSource, /type AgentInboxStatusFilter = 'all' \| 'active' \| 'paused' \| 'completed'/, '/movil sólo debe ofrecer los cuatro estados útiles')
assert.match(phoneChatSource, /agentGoalCompletedUnreviewed === true[\s\S]*return hasActiveAgent \|\| hasPausedAgent \|\| hasUnreviewedGoal/, '/movil debe excluir conversaciones normales')
assert.match(phoneChatSource, /goalCompletedUnreviewed \? \{ goalCompletedUnreviewed: 'true' \}/, '/movil debe pedir metas sin revisar al servidor')
assert.doesNotMatch(phoneChatSource, /<div className=\{styles\.topActionRow\}[\s\S]{0,500}renderAgentRobotButton\(/, '/movil no debe conservar el acceso flotante del bot en la bandeja')
assert.match(phoneChatStyles, /\.agentInboxStatusSection\s*\{[^}]*border-top:\s*1px solid var\(--phone-chat-border\)/, '/movil debe separar los subfiltros sin teñir el panel')
assert.doesNotMatch(phoneChatStyles.match(/\.agentInboxStatusSection\s*\{[^}]*\}/)?.[0] || '', /background/, '/movil no debe pintar el panel al seleccionar Chatbot')
assert.match(phoneChatSource, /agentGoalCompletedUnreviewed:\s*false/, '/movil debe retirar una meta de la bandeja al abrirla')

assert.match(androidSource, /DEFAULT_CHAT_FILTER_IDS = \['all', 'chatbot'/, 'Android debe fijar Chatbot junto a los filtros principales')
assert.match(androidSource, /type ChatbotStatusFilter = 'all' \| 'active' \| 'paused' \| 'completed'/, 'Android sólo debe ofrecer los cuatro estados útiles')
assert.match(androidSource, /return hasActiveAgent \|\| hasPausedAgent \|\| hasUnreviewedGoal/, 'Android debe excluir conversaciones normales')
assert.match(androidApiSource, /goalCompletedUnreviewed:\s*options\.goalCompletedUnreviewed/, 'Android debe mandar el scope de metas sin revisar')
assert.match(androidApiSource, /listAgentStates\(statuses:[\s\S]*\/conversational-agent\/states/, 'Android debe cargar activos y pausados sin consultar chat por chat')
assert.match(androidTypesSource, /agentGoalCompletedUnreviewed\?: boolean/, 'Android debe conservar la marca de meta pendiente')
assert.doesNotMatch(androidSource, /setAgentHubOpen\(true\)/, 'Android no debe conservar el acceso flotante del bot en la bandeja')
assert.doesNotMatch(androidSource.match(/chatbotStatusSection:\s*\{[^}]*\}/)?.[0] || '', /backgroundColor/, 'Android no debe pintar el panel al seleccionar Chatbot')
assert.match(androidSource, /agentGoalCompletedUnreviewed:\s*false/, 'Android debe retirar una meta de la bandeja al abrirla')

assert.match(iosFilterSource, /case chatbot/, 'iOS debe tener Chatbot como filtro principal')
assert.match(iosFilterSource, /enum ChatbotInboxStatusFilter[\s\S]*case all[\s\S]*case active[\s\S]*case paused[\s\S]*case completed/, 'iOS sólo debe ofrecer los cuatro estados útiles')
assert.match(iosFilterSource, /case \.all: return hasActive \|\| hasPaused \|\| hasCompleted/, 'iOS debe excluir conversaciones normales')
assert.match(iosInboxSource, /chatbotGoalRows[\s\S]*fetchStates\(statuses: \["active", "paused"\]\)/, 'iOS debe combinar metas sin revisar con activos y pausados')
assert.match(iosAgentServiceSource, /func fetchStates\(statuses:[\s\S]*\/conversational-agent\/states/, 'iOS debe cargar los estados del bot en una sola consulta')
assert.doesNotMatch(iosInboxScreenSource, /showsAgentHub|ToolbarItem\(placement: \.topBarLeading\)[\s\S]*AgentBotGlyph/, 'iOS no debe conservar el robot flotante en la bandeja')
assert.doesNotMatch(iosInboxScreenSource, /if viewModel\.activeFilter == \.quick\(\.chatbot\)[\s\S]{0,900}\.background\(/, 'iOS no debe pintar el panel al seleccionar Chatbot')
assert.match(iosInboxSource, /chatbotGoalRows\[index\]\.agentGoalCompletedUnreviewed = false/, 'iOS debe retirar una meta de la bandeja al abrirla')

console.log('Desktop, /movil, Android and iOS chatbot filter hierarchy contract OK')
