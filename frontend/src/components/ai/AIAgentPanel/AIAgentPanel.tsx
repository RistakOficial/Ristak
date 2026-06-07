import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ArrowUp, Bot, CalendarPlus, Check, Copy, CreditCard, Eraser, File as FileIcon, FileText, GitBranch, Image as ImageIcon, KeyRound, MessageCircle, Mic, Paperclip, Pause, SendHorizonal, Sparkles, TrendingUp, Video as VideoIcon, X } from 'lucide-react'
import { aiAgentService, type AIAgentAttachment, type AIAgentAttachmentKind, type AIAgentBusinessContextField, type AIAgentClarificationOption, type AIAgentConfigInput, type AIAgentConfigStatus, type AIAgentMessage, type AIAgentViewContext } from '@/services/aiAgentService'
import { sitesService, type SitesAICreationMessage } from '@/services/sitesService'
import { useNotification } from '@/contexts/NotificationContext'
import { AI_AGENT_CLOSE_REQUEST_EVENT, AI_AGENT_OPEN_REQUEST_EVENT, type AIAgentOpenRequestDetail, type AIAgentSitesCreationKind } from '@/utils/aiAgentEvents'
import styles from './AIAgentPanel.module.css'

const AI_AGENT_FLOATING_OPEN_KEY = 'ristak.aiAgentFloating.open'
const LEGACY_AI_AGENT_MESSAGES_KEY = 'ristak.aiAgentFloating.messages'
const VOICE_WAVE_BAR_COUNT = 128
const VOICE_WAVE_MIN_HEIGHT = 4
const VOICE_WAVE_MAX_HEIGHT = 30
const VOICE_WAVE_SILENCE_THRESHOLD = 4
const VOICE_WAVE_SIGNAL_RANGE = 30
const DEFAULT_AI_MODEL = 'gpt-5.5'
const MAX_ATTACHMENTS = 8
const MAX_DIRECT_ATTACHMENT_BYTES = 8 * 1024 * 1024
const MAX_ATTACHMENT_TOTAL_BYTES = 18 * 1024 * 1024
const MAX_TEXT_ATTACHMENT_BYTES = 1.5 * 1024 * 1024
const TEXT_ATTACHMENT_CHAR_LIMIT = 18000
const SITES_AI_DRAFT_CREATED_EVENT = 'ristak-sites-ai-draft-created'
const FILE_INPUT_ACCEPT = [
  'image/*',
  'video/*',
  'application/pdf',
  'text/*',
  '.csv',
  '.json',
  '.md',
  '.txt',
  '.log',
  '.html',
  '.xml',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.css',
  '.py',
  '.sql',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx'
].join(',')

type VoiceCaptureState = 'idle' | 'recording' | 'finalizing'
type VoiceEndAction = 'draft' | 'send'
type SendMessageOptions = {
  forceChat?: boolean
}
type AIAgentAttachmentDraft = AIAgentAttachment & {
  previewUrl?: string
}
type SitesCreationMode = {
  siteKind: AIAgentSitesCreationKind
  editSiteId?: string
  metaCapiEnabled?: boolean
  siteTitle?: string
}

const quickActions = [
  {
    label: 'Cobrar cliente',
    description: 'Arranca el flujo para cobrar más rápido.',
    prompt: 'Quiero cobrarle a un cliente. Inicia el flujo de cobro: identifica el contacto correcto, revisa si tiene tarjeta guardada o cobros previos, confirma monto, concepto y método recomendado, y dime la forma más rápida de enviar link de pago o cobrar con tarjeta guardada.',
    Icon: CreditCard
  },
  {
    label: 'Agendar cita',
    description: 'Resuelve contacto, calendario y horario.',
    prompt: 'Quiero agendar una cita. Inicia el flujo de agenda: identifica el contacto correcto, revisa el calendario disponible y confirma fecha, hora, duración, notas y cualquier dato faltante antes de crearla.',
    Icon: CalendarPlus
  },
  {
    label: 'Mandar a workflow',
    description: 'Resuelve contacto y workflow antes de ejecutar.',
    prompt: 'Quiero mandar a un contacto a un workflow. Ayúdame a encontrar el contacto correcto y seleccionar el workflow adecuado antes de ejecutarlo.',
    Icon: GitBranch
  },
  {
    label: 'Anuncios rentables',
    description: 'Mejor y peor campaña con recomendaciones.',
    prompt: 'Analiza mis anuncios empezando por la campaña que ahorita está siendo más rentable. Usa el rango visible actual si existe; si no, revisa el periodo reciente más útil. Primero dime la campaña más rentable y por qué con ROAS, utilidad, ingresos atribuidos y gasto. Después dime la campaña menos rentable y qué está fallando. Cierra con recomendaciones concretas para escalar, mantener, optimizar o cortar campañas, adsets y anuncios.',
    Icon: TrendingUp
  }
]

const routeLabels: Record<string, string> = {
  '/phone/agent-chat': 'Mobile AI agent',
  '/phone/agent-ai': 'Mobile AI agent',
  '/phone/ai-agent': 'Mobile AI agent',
  '/phone/dashboard': 'Mobile dashboard',
  '/phone/appointments': 'Mobile appointments',
  '/phone/transactions': 'Mobile payments',
  '/phone/contacts': 'Mobile contacts',
  '/phone/campaigns': 'Mobile ads',
  '/phone/reports': 'Mobile reports',
  '/phone/analytics': 'Mobile analytics',
  '/phone/settings': 'Mobile settings',
  '/dashboard': 'Dashboard',
  '/reports': 'Reportes',
  '/campaigns': 'Publicidad',
  '/transactions': 'Pagos',
  '/contacts': 'Contactos',
  '/appointments': 'Citas',
  '/analytics': 'Analíticas',
  '/settings': 'Configuración',
  '/sites': 'Sitios'
}

function getSitesAIIntro(siteKind: AIAgentSitesCreationKind, siteTitle = '') {
  if (siteTitle) {
    return [
      `Vamos a editar con IA el HTML de "${siteTitle}".`,
      '',
      'Pídeme el cambio como lo dirías a un diseñador:',
      '- Cambiar titulo, textos o CTA.',
      '- Cambiar imagenes por otras de internet o por una URL especifica.',
      '- Reordenar secciones.',
      '- Hacerlo mas premium, mas limpio o mas directo.',
      '- Agregar, quitar o ajustar campos del formulario.',
      '',
      'Cuando lo actualice, Ristak volvera a revisar los formularios para que puedas confirmar donde se guarda cada dato.'
    ].join('\n')
  }

  const pageLabel = siteKind === 'landing'
    ? 'pagina embudo'
    : siteKind === 'interactive_form'
      ? 'formulario interactivo'
      : 'formulario'
  return [
    `Vamos a crear un ${pageLabel} completo desde cero en HTML con IA.`,
    '',
    'La IA generara el HTML/CSS completo y Ristak lo importara como codigo propio para revisar formularios, campos y publicacion.',
    '',
    'Cuéntame esto en un solo mensaje si puedes:',
    '- Nicho o tipo de negocio.',
    '- Servicio, producto u oferta principal.',
    '- Objetivo de la pagina.',
    '- Cliente o prospecto ideal.',
    '- Estilo visual deseado.',
    '- Si quieres formulario y que campos debe pedir.',
    '- CTA principal.',
    '- Si quieres fotos de internet o alguna imagen por URL.',
    '- Si prefieres una pagina corta o una pagina mas completa.'
  ].join('\n')
}

function prepareSitesCreationMessages(messages: AIAgentMessage[]): SitesAICreationMessage[] {
  return prepareMessagesForApi(messages)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role,
      content: message.content
    }))
    .filter((message) => message.content.trim())
}

const emptyStatus: AIAgentConfigStatus = {
  configured: false,
  model: DEFAULT_AI_MODEL,
  tokenPreview: null,
  credentialStatus: 'missing',
  needsReconnect: false,
  connectionIssue: null,
  connectionIssueCode: null,
  businessContext: '',
  marketContext: '',
  idealCustomer: '',
  locationContext: '',
  competitorsContext: '',
  brandVoice: '',
  actionCustomizations: '',
  researchDomains: '',
  responseStyle: 'advisor',
  recommendationMode: 'when_useful',
  webSearchEnabled: false,
  updatedAt: null
}

const emptyForm: AIAgentConfigInput = {
  model: DEFAULT_AI_MODEL,
  businessContext: '',
  marketContext: '',
  idealCustomer: '',
  locationContext: '',
  competitorsContext: '',
  brandVoice: '',
  actionCustomizations: '',
  researchDomains: '',
  responseStyle: 'advisor',
  recommendationMode: 'when_useful',
  webSearchEnabled: false
}

const legacyBusinessContextFields = [
  { label: 'Mercado o nicho', key: 'marketContext' },
  { label: 'Cliente ideal', key: 'idealCustomer' },
  { label: 'Zona geográfica', key: 'locationContext' },
  { label: 'Competidores o referencias', key: 'competitorsContext' },
  { label: 'Tono, prioridades y reglas', key: 'brandVoice' }
] as const

const onboardingQuestions: Array<{
  field: AIAgentBusinessContextField
  question: string
}> = [
  {
    field: 'businessContext',
    question: 'Para darte recomendaciones con criterio, cuéntame en un solo mensaje qué vendes, a quién le vendes, dónde operas, quién compite contigo, qué tono quieres y qué reglas debe respetar el agente.'
  }
]

const defaultThinkingActions = [
  'Pensando'
]

const savingThinkingActions = [
  'Guardando configuración',
  'Validando contexto',
  'Actualizando agente'
]

type VisualChartType = 'bar' | 'line'

type VisualChartItem = {
  label: string
  value: number
  rawValue: string
  highlighted: boolean
}

type VisualChart = {
  type: VisualChartType
  title: string
  items: VisualChartItem[]
}

type AIAgentPanelProps = {
  variant?: 'floating' | 'embedded' | 'docked'
  onOpenChange?: (open: boolean) => void
}

function getStoredOpenState() {
  try {
    return window.localStorage.getItem(AI_AGENT_FLOATING_OPEN_KEY) === 'true'
  } catch {
    return false
  }
}

function saveOpenState(open: boolean) {
  try {
    window.localStorage.setItem(AI_AGENT_FLOATING_OPEN_KEY, String(open))
  } catch {
    // localStorage can fail in private or restricted browser contexts.
  }
}

function clearLegacyStoredMessages() {
  try {
    window.localStorage.removeItem(LEGACY_AI_AGENT_MESSAGES_KEY)
  } catch {
    // localStorage can fail in private or restricted browser contexts.
  }
}

function stripCitationArtifacts(value: string) {
  return String(value || '')
    .replace(/\s*\uE200cite[^\uE201]*\uE201/g, '')
    .replace(/\s*\u3010[^\u3011]*\u2020[^\u3011]*\u3011/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
}

function normalizeClarificationText(value: string) {
  return stripCitationArtifacts(value)
    .replace(/\[[^\]]+\]\([^)]+\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function isMarkdownListLine(line: string) {
  return /^\s*(?:[-*•]\s+|\d+[.)]\s+)/.test(line)
}

function stripMarkdownListMarker(line: string) {
  return line.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '')
}

function optionAppearsInLine(line: string, options: AIAgentClarificationOption[]) {
  const normalizedLine = normalizeClarificationText(stripMarkdownListMarker(line))
  if (!normalizedLine) return false

  return options.some((option) => {
    const normalizedLabel = normalizeClarificationText(option.label)
    if (normalizedLabel.length < 2) return false
    if (normalizedLine.includes(normalizedLabel)) return true

    const words = normalizedLabel.split(' ').filter((word) => word.length > 2)
    if (words.length < 2) return false

    const matches = words.filter((word) => normalizedLine.includes(word)).length
    return matches >= 2 && matches / words.length >= 0.6
  })
}

function removeDanglingOptionsHeading(lines: string[]) {
  let lastContentIndex = -1

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim()) {
      lastContentIndex = index
      break
    }
  }

  if (lastContentIndex < 0) return

  const normalized = normalizeClarificationText(lines[lastContentIndex].replace(/:$/, ''))
  const genericOptionHeadings = new Set([
    'opciones',
    'opciones disponibles',
    'estas opciones',
    'elige una opcion',
    'elige una',
    'selecciona una opcion',
    'selecciona una'
  ])

  if (genericOptionHeadings.has(normalized)) {
    lines.splice(lastContentIndex, lines.length - lastContentIndex)
  }
}

function stripClarificationOptionLists(content: string, options?: AIAgentClarificationOption[]) {
  if (!options?.length) return stripCitationArtifacts(content)

  const lines = stripCitationArtifacts(content).replace(/\r\n/g, '\n').split('\n')
  const output: string[] = []

  for (let index = 0; index < lines.length;) {
    if (!isMarkdownListLine(lines[index])) {
      output.push(lines[index])
      index += 1
      continue
    }

    const block: string[] = []
    let blockMentionsOptions = false

    while (index < lines.length) {
      const line = lines[index]

      if (isMarkdownListLine(line)) {
        block.push(line)
        blockMentionsOptions = blockMentionsOptions || optionAppearsInLine(line, options)
        index += 1
        continue
      }

      if (block.length && line.trim() && /^\s{2,}\S/.test(line)) {
        block.push(line)
        index += 1
        continue
      }

      break
    }

    if (blockMentionsOptions) {
      removeDanglingOptionsHeading(output)
      continue
    }

    output.push(...block)
  }

  const cleaned = output
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (cleaned) return cleaned
  return options.length === 1 ? 'Selecciona esta opción:' : 'Selecciona una opción:'
}

function getDisplayMessageContent(message: AIAgentMessage) {
  return message.role === 'assistant'
    ? stripClarificationOptionLists(message.content, message.clarificationOptions)
    : message.content
}

function createMessage(
  role: AIAgentMessage['role'],
  content: string,
  sources?: AIAgentMessage['sources'],
  clarificationOptions?: AIAgentClarificationOption[],
  attachments?: AIAgentAttachment[],
  selectedClarificationOption?: AIAgentMessage['selectedClarificationOption'],
  agentMemory?: AIAgentMessage['agentMemory'],
  trace?: AIAgentMessage['trace']
): AIAgentMessage {
  const cleanContent = role === 'assistant'
    ? stripClarificationOptionLists(content, clarificationOptions)
    : content

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    content: cleanContent,
    ...(attachments?.length ? { attachments } : {}),
    ...(agentMemory ? { agentMemory } : {}),
    ...(trace ? { trace } : {}),
    ...(selectedClarificationOption ? { selectedClarificationOption } : {}),
    sources,
    clarificationOptions,
    createdAt: new Date().toISOString()
  }
}

function formatTraceStatus(status?: string) {
  if (status === 'completed') return 'Completado'
  if (status === 'waiting_user') return 'Esperando respuesta'
  if (status === 'failed') return 'Falló'
  return 'En proceso'
}

function getRouteLabel(pathname: string) {
  const match = Object.entries(routeLabels).find(([path]) => pathname.startsWith(path))
  return match?.[1] || pathname
}

function getLatestUserText(messages: AIAgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      return messages[index].content
    }
  }

  return ''
}

function addThinkingAction(actions: string[], action: string) {
  if (!actions.includes(action)) {
    actions.push(action)
  }
}

function normalizeThinkingSource(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function addRelevantThinkingActions(actions: string[], source: string) {
  if (/(go\s*high\s*level|gohighlevel|go\s*hi\s*level|gohi\s*level|high\s*level|highlevel|ghl|custom field|campo personalizado|custom value|valor personalizado|formulario|form submissions|respuestas de formulario|survey|encuesta|funnel|embudo|trigger link|media storage|blog|workflow|task|tarea|tag|etiqueta|nota|conversation|conversacion|oportunidad|pipeline|producto|tienda|store)/.test(source)) {
    addThinkingAction(actions, 'Consultando HighLevel')
  }

  if (/(contacto|contactos|lead|leads|cliente|clientes|prospecto|prospectos|crm)/.test(source)) {
    addThinkingAction(actions, 'Buscando contactos')
    addThinkingAction(actions, 'Cruzando historial')
  }

  if (/(pago|pagos|cobro|cobrar|cobr|venta|ventas|ingreso|ingresos|factura|facturar|invoice|link)/.test(source)) {
    const isPaymentMutation = /(crea|crear|genera|generar|manda|mandar|envia|enviar|registra|registrar|programa|programar|cobra|cobrar|cobr)/.test(source)
    addThinkingAction(actions, isPaymentMutation ? 'Creando pago' : 'Revisando pagos')
    addThinkingAction(actions, 'Validando montos')
  }

  if (/(cita|citas|agenda|agendar|calendario|calendar|appointment|asistencia|asistieron|showed)/.test(source)) {
    addThinkingAction(actions, 'Revisando citas')
    addThinkingAction(actions, 'Comprobando calendario')
  }

  if (/(campana|campanas|meta|facebook|ads|anuncio|anuncios|adset|publicidad|roas)/.test(source)) {
    addThinkingAction(actions, 'Analizando campañas')
    addThinkingAction(actions, 'Midiendo rendimiento')
  }

  if (/(dashboard|reporte|reportes|analitica|analiticas|analytics|metrica|metricas|datos)/.test(source)) {
    addThinkingAction(actions, 'Comprobando métricas')
  }
}

function referencesCurrentView(source: string) {
  return /(esto|esta pantalla|este panel|esta pagina|esta vista|aqui|lo que estoy viendo|lo de aqui|esta seccion|este dashboard)/.test(source)
}

function getThinkingActions(messages: AIAgentMessage[], pathname: string, savingConfig: boolean) {
  if (savingConfig) {
    return savingThinkingActions
  }

  const latestUserText = normalizeThinkingSource(getLatestUserText(messages))
  const routeLabel = normalizeThinkingSource(getRouteLabel(pathname))
  const actions = ['Pensando']

  addRelevantThinkingActions(actions, latestUserText)

  if (actions.length === 1 && referencesCurrentView(latestUserText)) {
    addRelevantThinkingActions(actions, routeLabel)
  }

  if (actions.length > 1) {
    addThinkingAction(actions, 'Preparando respuesta')
  }

  return actions.length > 1 ? actions : defaultThinkingActions
}

function collectVisibleText() {
  const main = document.querySelector('main')
  const source = main instanceof HTMLElement ? main.innerText : document.body.innerText

  return source
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000)
}

function statusToForm(status: AIAgentConfigStatus): AIAgentConfigInput {
  return {
    model: status.model || DEFAULT_AI_MODEL,
    businessContext: getUnifiedBusinessContext(status),
    marketContext: '',
    idealCustomer: '',
    locationContext: '',
    competitorsContext: '',
    brandVoice: '',
    actionCustomizations: status.actionCustomizations || '',
    researchDomains: status.researchDomains || '',
    responseStyle: status.responseStyle || 'advisor',
    recommendationMode: status.recommendationMode || 'when_useful',
    webSearchEnabled: Boolean(status.webSearchEnabled)
  }
}

function hasBusinessContext(form: AIAgentConfigInput) {
  return Boolean(form.businessContext.trim())
}

function getUnifiedBusinessContext(status: AIAgentConfigStatus) {
  const primaryContext = (status.businessContext || '').trim()
  const legacyContext = legacyBusinessContextFields
    .map(({ label, key }) => {
      const value = String(status[key] || '').trim()
      return value ? `${label}: ${value}` : ''
    })
    .filter(Boolean)

  return [primaryContext, ...legacyContext].filter(Boolean).join('\n\n')
}

function prepareConfigForSave(config: AIAgentConfigInput): AIAgentConfigInput {
  return {
    ...config,
    marketContext: '',
    idealCustomer: '',
    locationContext: '',
    competitorsContext: '',
    brandVoice: ''
  }
}

function createInitialVoiceBars() {
  return Array.from({ length: VOICE_WAVE_BAR_COUNT }, () => VOICE_WAVE_MIN_HEIGHT)
}

function getVoiceBarHeight(samples: Uint8Array) {
  const average = samples.reduce((sum, value) => sum + Math.abs(value - 128), 0) / samples.length
  const gatedLevel = average <= VOICE_WAVE_SILENCE_THRESHOLD
    ? 0
    : Math.min(1, (average - VOICE_WAVE_SILENCE_THRESHOLD) / VOICE_WAVE_SIGNAL_RANGE)
  const responsiveLevel = Math.sqrt(gatedLevel)

  return Math.round(VOICE_WAVE_MIN_HEIGHT + responsiveLevel * (VOICE_WAVE_MAX_HEIGHT - VOICE_WAVE_MIN_HEIGHT))
}

function formatVoiceDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function getAudioContextConstructor() {
  const audioWindow = window as Window & {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }

  return audioWindow.AudioContext || audioWindow.webkitAudioContext || null
}

function getVoiceMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return ''
  }

  return [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/mpeg'
  ].find((type) => MediaRecorder.isTypeSupported(type)) || ''
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

function getAttachmentKind(file: File): AIAgentAttachmentKind {
  const mimeType = file.type.toLowerCase()
  const extension = file.name.split('.').pop()?.toLowerCase() || ''

  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType === 'application/pdf' || extension === 'pdf') return 'pdf'
  if (mimeType.startsWith('text/') || isTextLikeExtension(extension)) return 'text'
  return 'file'
}

function isTextLikeExtension(extension: string) {
  return [
    'txt',
    'csv',
    'tsv',
    'json',
    'md',
    'markdown',
    'log',
    'html',
    'htm',
    'xml',
    'yaml',
    'yml',
    'js',
    'jsx',
    'ts',
    'tsx',
    'css',
    'scss',
    'py',
    'sql',
    'env'
  ].includes(extension)
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('No pude leer el archivo.'))
    reader.readAsDataURL(file)
  })
}

function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('No pude leer el archivo.'))
    reader.readAsText(file)
  })
}

function createVideoThumbnail(file: File) {
  return new Promise<string>((resolve) => {
    const video = document.createElement('video')
    const objectUrl = URL.createObjectURL(file)
    let settled = false

    const finish = (value: string) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(objectUrl)
      resolve(value)
    }

    const drawFrame = () => {
      try {
        const canvas = document.createElement('canvas')
        const width = video.videoWidth || 640
        const height = video.videoHeight || 360
        canvas.width = Math.min(width, 960)
        canvas.height = Math.max(1, Math.round((canvas.width / width) * height))
        const context = canvas.getContext('2d')

        if (!context) {
          finish('')
          return
        }

        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        finish(canvas.toDataURL('image/jpeg', 0.82))
      } catch {
        finish('')
      }
    }

    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true
    video.crossOrigin = 'anonymous'
    video.onloadeddata = () => {
      const seekTo = Number.isFinite(video.duration) && video.duration > 1 ? 0.8 : 0
      if (seekTo > 0) {
        video.currentTime = seekTo
      } else {
        drawFrame()
      }
    }
    video.onseeked = drawFrame
    video.onerror = () => finish('')
    video.src = objectUrl
  })
}

async function createAttachmentFromFile(file: File): Promise<AIAgentAttachmentDraft> {
  const kind = getAttachmentKind(file)
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const mimeType = file.type || 'application/octet-stream'
  const extension = file.name.split('.').pop()?.toLowerCase() || ''
  const attachment: AIAgentAttachmentDraft = {
    id,
    name: file.name,
    mimeType,
    size: file.size,
    kind
  }

  if (kind === 'video') {
    attachment.previewUrl = URL.createObjectURL(file)
    attachment.thumbnailDataUrl = await createVideoThumbnail(file)
    return attachment
  }

  if (kind === 'text' && file.size <= MAX_TEXT_ATTACHMENT_BYTES) {
    const text = await readFileAsText(file)
    attachment.text = text.length > TEXT_ATTACHMENT_CHAR_LIMIT
      ? `${text.slice(0, TEXT_ATTACHMENT_CHAR_LIMIT)}\n\n[Archivo truncado para el agente: ${formatFileSize(file.size)}]`
      : text
    return attachment
  }

  if (file.size <= MAX_DIRECT_ATTACHMENT_BYTES) {
    attachment.dataUrl = await readFileAsDataUrl(file)
  }

  if (kind === 'image') {
    attachment.previewUrl = attachment.dataUrl
  } else if (isTextLikeExtension(extension) && file.size <= MAX_TEXT_ATTACHMENT_BYTES) {
    const text = await readFileAsText(file)
    attachment.text = text.length > TEXT_ATTACHMENT_CHAR_LIMIT
      ? `${text.slice(0, TEXT_ATTACHMENT_CHAR_LIMIT)}\n\n[Archivo truncado para el agente: ${formatFileSize(file.size)}]`
      : text
  }

  return attachment
}

function revokeAttachmentPreview(attachment: AIAgentAttachment | AIAgentAttachmentDraft) {
  const previewUrl = (attachment as AIAgentAttachmentDraft).previewUrl
  if (previewUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(previewUrl)
  }
}

function sanitizeAttachmentForApi(attachment: AIAgentAttachment | AIAgentAttachmentDraft): AIAgentAttachment {
  const { previewUrl: _previewUrl, ...safeAttachment } = attachment as AIAgentAttachmentDraft
  return safeAttachment
}

function stripAttachmentPayload(attachment: AIAgentAttachment | AIAgentAttachmentDraft): AIAgentAttachment {
  const safeAttachment = sanitizeAttachmentForApi(attachment)
  const { dataUrl: _dataUrl, text: _text, thumbnailDataUrl: _thumbnailDataUrl, ...metadata } = safeAttachment
  return metadata
}

function prepareMessagesForApi(messages: AIAgentMessage[]): AIAgentMessage[] {
  const latestUserIndex = [...messages].map((message, index) => ({ message, index })).reverse().find((item) => item.message.role === 'user')?.index ?? -1

  return messages.map((message, index) => {
    if (!message.attachments?.length) return message

    return {
      ...message,
      attachments: message.attachments.map((attachment) => (
        index === latestUserIndex ? sanitizeAttachmentForApi(attachment) : stripAttachmentPayload(attachment)
      ))
    }
  })
}

function buildAttachmentPrompt(attachments: AIAgentAttachment[]) {
  if (!attachments.length) return ''
  const files = attachments.length === 1 ? 'este archivo adjunto' : 'estos archivos adjuntos'
  return `Analiza ${files} y dime qué ves.`
}

function formatTranscriptTimestamp(value?: string | null) {
  if (!value) return ''

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  return new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
}

function formatTranscriptAttachments(attachments?: AIAgentAttachment[]) {
  if (!attachments?.length) return []

  return [
    '',
    '**Adjuntos**',
    ...attachments.map((attachment) => `- ${attachment.name} (${attachment.kind}, ${formatFileSize(attachment.size)})`)
  ]
}

function formatTranscriptSources(sources?: AIAgentMessage['sources']) {
  if (!sources?.length) return []

  return [
    '',
    '**Fuentes**',
    ...sources.map((source) => `- ${source.title || source.url}: ${source.url}`)
  ]
}

function formatTranscriptClarifications(options?: AIAgentClarificationOption[]) {
  if (!options?.length) return []

  return [
    '',
    '**Opciones ofrecidas por el agente**',
    ...options.map((option) => {
      const description = option.description ? ` - ${option.description}` : ''
      return `- ${option.label}${description}`
    })
  ]
}

function buildChatTranscript(
  messages: AIAgentMessage[],
  context: {
    panelTitle: string
    routeLabel: string
    path: string
    pageTitle: string
    copiedAt: string
  }
) {
  const lines = [
    `# Conversación exportada de ${context.panelTitle}`,
    '',
    `Copiado: ${formatTranscriptTimestamp(context.copiedAt)} (${context.copiedAt})`,
    `Pantalla: ${context.routeLabel}`,
    `Ruta: ${context.path}`,
    `Título de página: ${context.pageTitle}`,
    `Mensajes: ${messages.length}`,
    '',
    'Pega este transcript en Codex u otra plataforma para revisar el diálogo completo, detectar errores y mantener claro quién dijo qué.',
    '',
    '## Diálogo'
  ]

  messages.forEach((message, index) => {
    const roleLabel = message.role === 'user' ? 'Usuario' : 'Agente AI'
    const timestamp = formatTranscriptTimestamp(message.createdAt)
    const rawContent = getDisplayMessageContent(message).trim()
    const content = rawContent || '[Mensaje vacío]'

    lines.push(
      '',
      `### ${index + 1}. ${roleLabel}${timestamp ? ` - ${timestamp}` : ''}`,
      '',
      content,
      ...formatTranscriptAttachments(message.attachments),
      ...formatTranscriptClarifications(message.clarificationOptions),
      ...formatTranscriptSources(message.sources)
    )
  })

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall back to the selection-based copy path below.
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()

  const copied = document.execCommand('copy')
  textarea.remove()

  if (!copied) {
    throw new Error('No se pudo copiar al portapapeles.')
  }
}

function getAttachmentIcon(kind: AIAgentAttachmentKind) {
  if (kind === 'image') return <ImageIcon size={16} />
  if (kind === 'video') return <VideoIcon size={16} />
  if (kind === 'pdf' || kind === 'text') return <FileText size={16} />
  return <FileIcon size={16} />
}

function getNextOnboardingQuestion(form: AIAgentConfigInput) {
  return onboardingQuestions.find((item) => !String(form[item.field] || '').trim()) || null
}

function normalizeHttpUrl(value: string) {
  const trimmed = value.trim().replace(/[),.;:!?]+$/g, '')
  const candidate = trimmed.startsWith('www.') ? `https://${trimmed}` : trimmed

  try {
    const url = new URL(candidate)
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''
  } catch {
    return ''
  }
}

function isLikelyImageUrl(url: string) {
  try {
    const parsed = new URL(url)
    return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(parsed.pathname)
  } catch {
    return false
  }
}

function isLikelyVideoUrl(url: string) {
  try {
    const parsed = new URL(url)
    return /\.(mp4|webm|mov|m4v|ogg)$/i.test(parsed.pathname)
  } catch {
    return false
  }
}

function isLikelyMediaUrl(url: string) {
  return isLikelyImageUrl(url) || isLikelyVideoUrl(url)
}

function renderMediaUrlPreview(rawUrl: string, label: string, keyPrefix: string) {
  const url = normalizeHttpUrl(rawUrl)
  if (!url) return null
  const title = label.trim() || url

  if (isLikelyImageUrl(url)) {
    return (
      <figure className={styles.mediaPreview} key={keyPrefix}>
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={title} loading="lazy" referrerPolicy="no-referrer" />
        </a>
        <figcaption>{title}</figcaption>
      </figure>
    )
  }

  if (isLikelyVideoUrl(url)) {
    return (
      <figure className={styles.mediaPreview} key={keyPrefix}>
        <video src={url} controls preload="metadata" />
        <figcaption>
          <a href={url} target="_blank" rel="noreferrer">{title}</a>
        </figcaption>
      </figure>
    )
  }

  return null
}

function renderInlineMarkdown(text: string, keyPrefix: string) {
  const parts = text.split(/(!\[[^\]]*]\([^)]+\)|\[[^\]]+]\([^)]+\)|\*\*[^*]+\*\*|https?:\/\/[^\s<>()]+|www\.[^\s<>()]+)/g)

  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={`${keyPrefix}-strong-${index}`} className={styles.inlineStrong}>
          {part.slice(2, -2)}
        </strong>
      )
    }

    const imageMatch = part.match(/^!\[([^\]]*)]\(([^)]+)\)$/)
    if (imageMatch) {
      const url = normalizeHttpUrl(imageMatch[2])
      if (url) {
        return (
          <a key={`${keyPrefix}-image-link-${index}`} className={styles.inlineLink} href={url} target="_blank" rel="noreferrer">
            {imageMatch[1] || 'Imagen'}
          </a>
        )
      }
    }

    const linkMatch = part.match(/^\[([^\]]+)]\(([^)]+)\)$/)
    if (linkMatch) {
      const url = normalizeHttpUrl(linkMatch[2])
      if (url) {
        return (
          <a key={`${keyPrefix}-link-${index}`} className={styles.inlineLink} href={url} target="_blank" rel="noreferrer">
            {linkMatch[1]}
          </a>
        )
      }
    }

    if (/^(https?:\/\/|www\.)/i.test(part)) {
      const url = normalizeHttpUrl(part)
      if (url) {
        return (
          <a key={`${keyPrefix}-url-${index}`} className={styles.inlineLink} href={url} target="_blank" rel="noreferrer">
            {part.replace(/[),.;:!?]+$/g, '')}
          </a>
        )
      }
    }

    return <React.Fragment key={`${keyPrefix}-text-${index}`}>{part}</React.Fragment>
  })
}

function isMarkdownTableLine(line: string) {
  return /^\s*\|.+\|\s*$/.test(line)
}

function isMarkdownTableDivider(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function parseTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function renderMarkdownTable(lines: string[], keyPrefix: string) {
  const rows = lines.filter((line) => !isMarkdownTableDivider(line)).map(parseTableRow)
  const [header = [], ...bodyRows] = rows

  if (!header.length || !bodyRows.length) return null

  return (
    <div className={styles.metricTableWrap} key={keyPrefix}>
      <table className={styles.metricTable}>
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th key={`${keyPrefix}-head-${index}`}>
                {renderInlineMarkdown(cell, `${keyPrefix}-head-${index}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, rowIndex) => (
            <tr key={`${keyPrefix}-row-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${keyPrefix}-cell-${rowIndex}-${cellIndex}`}>
                  {renderInlineMarkdown(cell, `${keyPrefix}-cell-${rowIndex}-${cellIndex}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function parseChartNumber(value: string) {
  const normalized = value.replace(/,/g, '').replace(/\$/g, '')
  const match = normalized.match(/-?\d+(?:\.\d+)?/)

  return match ? Number(match[0]) : Number.NaN
}

function parseVisualChart(lines: string[]): VisualChart | null {
  let type: VisualChartType = 'bar'
  let title = ''
  const items: VisualChartItem[] = []

  lines.forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    const configMatch = trimmed.match(/^(type|title):\s*(.+)$/i)

    if (configMatch) {
      const key = configMatch[1].toLowerCase()
      const value = configMatch[2].trim()

      if (key === 'type' && /^(bar|line)$/i.test(value)) {
        type = value.toLowerCase() as VisualChartType
      }

      if (key === 'title') {
        title = value
      }

      return
    }

    const parts = trimmed.split('|').map((part) => part.trim()).filter(Boolean)
    if (parts.length < 2) return

    const numericValue = parseChartNumber(parts[1])
    if (!Number.isFinite(numericValue)) return

    items.push({
      label: parts[0],
      value: numericValue,
      rawValue: parts[1],
      highlighted: parts.slice(2).some((part) => /^(highlight|destacar|clave)$/i.test(part))
    })
  })

  if (items.length < 2) return null

  return {
    type,
    title,
    items: items.slice(0, 8)
  }
}

function renderVisualChart(chart: VisualChart, keyPrefix: string) {
  const values = chart.items.map((item) => item.value)
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const spread = maxValue - minValue || 1

  if (chart.type === 'line') {
    const width = 320
    const height = 138
    const paddingX = 22
    const paddingY = 18
    const pointGap = chart.items.length > 1 ? (width - paddingX * 2) / (chart.items.length - 1) : 0
    const points = chart.items.map((item, index) => {
      const x = paddingX + pointGap * index
      const y = height - paddingY - ((item.value - minValue) / spread) * (height - paddingY * 2)

      return { ...item, x, y }
    })
    const path = points.map((point) => `${point.x},${point.y}`).join(' ')

    return (
      <div className={styles.visualChart} key={keyPrefix}>
        {chart.title && <div className={styles.visualChartTitle}>{chart.title}</div>}
        <svg className={styles.lineChart} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={chart.title || 'Gráfica lineal'}>
          <polyline className={styles.lineChartPath} points={path} />
          {points.map((point, index) => (
            <g key={`${keyPrefix}-point-${index}`}>
              <circle
                className={point.highlighted ? styles.lineChartPointHighlight : styles.lineChartPoint}
                cx={point.x}
                cy={point.y}
                r={point.highlighted ? 6 : 4}
              />
              {point.highlighted && (
                <text className={styles.lineChartValue} x={point.x} y={Math.max(12, point.y - 12)} textAnchor="middle">
                  {point.rawValue}
                </text>
              )}
            </g>
          ))}
        </svg>
        <div className={styles.chartLabels}>
          {chart.items.map((item, index) => (
            <span className={item.highlighted ? styles.chartLabelHighlight : styles.chartLabel} key={`${keyPrefix}-label-${index}`}>
              {item.label}
            </span>
          ))}
        </div>
      </div>
    )
  }

  const maxAbsValue = Math.max(...chart.items.map((item) => Math.abs(item.value)), 1)

  return (
    <div className={styles.visualChart} key={keyPrefix}>
      {chart.title && <div className={styles.visualChartTitle}>{chart.title}</div>}
      <div className={styles.barChart}>
        {chart.items.map((item, index) => {
          const width = `${Math.max(6, (Math.abs(item.value) / maxAbsValue) * 100)}%`

          return (
            <div className={`${styles.barChartRow} ${item.highlighted ? styles.barChartRowHighlight : ''}`} key={`${keyPrefix}-bar-${index}`}>
              <div className={styles.barChartMeta}>
                <span className={styles.barChartLabel}>{item.label}</span>
                <span className={styles.barChartValue}>{item.rawValue}</span>
              </div>
              <div className={styles.barTrack}>
                <span className={styles.barFill} style={{ width }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function getKeyValueParts(line: string) {
  const match = line.match(/^\s*(?:\*\*)?([^:*|\n]{2,54})(?::\*\*|\*\*:|:)\s+(.+)$/)
  if (!match) return null

  return {
    label: match[1].trim(),
    value: match[2].trim()
  }
}

function isOrderedListLine(line: string) {
  return /^\d+[\.)]\s+/.test(line.trim())
}

function normalizeOrderedListLine(line: string) {
  return line.trim().replace(/^\d+[\.)]\s+/, '')
}

function isSectionTitle(line: string) {
  const trimmed = line.trim()
  const plainTitle = trimmed.replace(/^\*\*/, '').replace(/\*\*$/, '')

  return (
    plainTitle.length <= 72 &&
    !plainTitle.includes(':') &&
    (
      /^🏆/.test(plainTitle) ||
      /^(ranking|resumen|ganadora|ganador|métricas|metricas|detalle|comparativo|periodo|resultado)/i.test(plainTitle)
    )
  )
}

function isInsightLabel(label: string) {
  return /^(conclusión|conclusion|qué significa|que significa|qué significa para el negocio|que significa para el negocio|lectura de negocio|siguiente acción|siguiente accion|acción recomendada|accion recomendada)$/i.test(label.replace(/\*/g, '').trim())
}

function renderMessageContent(content: string) {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const nodes: React.ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()

    if (!trimmed) {
      index += 1
      continue
    }

    const standaloneImage = trimmed.match(/^!\[([^\]]*)]\(([^)]+)\)$/)
    if (standaloneImage) {
      const mediaNode = renderMediaUrlPreview(standaloneImage[2], standaloneImage[1] || 'Imagen adjunta', `media-image-${index}`)
      if (mediaNode) {
        nodes.push(mediaNode)
        index += 1
        continue
      }
    }

    const standaloneLink = trimmed.match(/^(?:\[([^\]]+)]\(([^)]+)\)|(https?:\/\/\S+|www\.\S+))$/)
    if (standaloneLink) {
      const url = standaloneLink[2] || standaloneLink[3] || ''
      const label = standaloneLink[1] || url
      const normalizedUrl = normalizeHttpUrl(url)
      if (normalizedUrl && isLikelyMediaUrl(normalizedUrl)) {
        const mediaNode = renderMediaUrlPreview(normalizedUrl, label, `media-url-${index}`)
        if (mediaNode) {
          nodes.push(mediaNode)
          index += 1
          continue
        }
      }
    }

    if (/^```ristak-chart\s*$/i.test(trimmed)) {
      const chartLines: string[] = []
      index += 1

      while (index < lines.length && lines[index].trim() !== '```') {
        chartLines.push(lines[index])
        index += 1
      }

      if (index < lines.length && lines[index].trim() === '```') {
        index += 1
      }

      const chart = parseVisualChart(chartLines)
      if (chart) {
        nodes.push(renderVisualChart(chart, `chart-${index}`))
      }
      continue
    }

    if (isMarkdownTableLine(line) && lines[index + 1] && isMarkdownTableDivider(lines[index + 1])) {
      const tableLines: string[] = []

      while (index < lines.length && isMarkdownTableLine(lines[index])) {
        tableLines.push(lines[index])
        index += 1
      }

      const tableNode = renderMarkdownTable(tableLines, `table-${index}`)
      if (tableNode) nodes.push(tableNode)
      continue
    }

    if (isSectionTitle(trimmed)) {
      const titleClassName = /^🏆/.test(trimmed) ? styles.winnerTitle : styles.sectionTitle

      nodes.push(
        <div className={titleClassName} key={`section-${index}`}>
          {renderInlineMarkdown(trimmed, `section-${index}`)}
        </div>
      )
      index += 1
      continue
    }

    const insightParts = getKeyValueParts(line)

    if (insightParts && isInsightLabel(insightParts.label)) {
      nodes.push(
        <div className={styles.insightBlock} key={`insight-${index}`}>
          <span className={styles.insightTitle}>{insightParts.label}</span>
          <span className={styles.insightText}>
            {renderInlineMarkdown(insightParts.value, `insight-${index}`)}
          </span>
        </div>
      )
      index += 1
      continue
    }

    if (isOrderedListLine(trimmed)) {
      const items: string[] = []

      while (index < lines.length && isOrderedListLine(lines[index])) {
        items.push(normalizeOrderedListLine(lines[index]))
        index += 1
      }

      nodes.push(
        <ol className={styles.orderedList} key={`ol-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`ol-${index}-${itemIndex}`}>
              {renderInlineMarkdown(item, `ol-${index}-${itemIndex}`)}
            </li>
          ))}
        </ol>
      )
      continue
    }

    if (/^[-•]\s+/.test(trimmed)) {
      const items: string[] = []

      while (index < lines.length && /^[-•]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-•]\s+/, ''))
        index += 1
      }

      nodes.push(
        <ul className={styles.bulletList} key={`ul-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`ul-${index}-${itemIndex}`}>
              {renderInlineMarkdown(item, `ul-${index}-${itemIndex}`)}
            </li>
          ))}
        </ul>
      )
      continue
    }

    const keyValueRows: Array<{ label: string; value: string }> = []
    let keyValueIndex = index

    while (keyValueIndex < lines.length) {
      if (!lines[keyValueIndex].trim() && keyValueRows.length > 0) {
        const nextParts = lines[keyValueIndex + 1] ? getKeyValueParts(lines[keyValueIndex + 1]) : null
        if (nextParts && !isInsightLabel(nextParts.label)) {
          keyValueIndex += 1
          continue
        }
        break
      }

      const parts = getKeyValueParts(lines[keyValueIndex])
      if (!parts || isInsightLabel(parts.label)) break

      keyValueRows.push(parts)
      keyValueIndex += 1
    }

    if (keyValueRows.length >= 2) {
      nodes.push(
        <div className={styles.kvGrid} key={`kv-${index}`}>
          {keyValueRows.map((row, rowIndex) => (
            <div className={styles.kvRow} key={`kv-${index}-${rowIndex}`}>
              <span className={styles.kvKey}>{row.label}</span>
              <span className={styles.kvValue}>{renderInlineMarkdown(row.value, `kv-${index}-${rowIndex}`)}</span>
            </div>
          ))}
        </div>
      )
      index = keyValueIndex
      continue
    }

    if (keyValueRows.length === 1) {
      const row = keyValueRows[0]

      nodes.push(
        <p className={nodes.length === 0 ? styles.contentLead : styles.richParagraph} key={`kv-single-${index}`}>
          <strong className={styles.inlineStrong}>{row.label}:</strong>{' '}
          {renderInlineMarkdown(row.value, `kv-single-${index}`)}
        </p>
      )
      index = keyValueIndex
      continue
    }

    nodes.push(
      <p className={nodes.length === 0 ? styles.contentLead : styles.richParagraph} key={`p-${index}`}>
        {renderInlineMarkdown(trimmed, `p-${index}`)}
      </p>
    )
    index += 1
  }

  return <div className={styles.richContent}>{nodes}</div>
}

function renderAttachmentPreview(
  attachment: AIAgentAttachment | AIAgentAttachmentDraft,
  options: {
    removable?: boolean
    onRemove?: (id: string) => void
  } = {}
) {
  const imageSrc = attachment.kind === 'image'
    ? attachment.dataUrl || attachment.thumbnailDataUrl || (attachment as AIAgentAttachmentDraft).previewUrl
    : attachment.thumbnailDataUrl
  const videoSrc = attachment.kind === 'video' ? (attachment as AIAgentAttachmentDraft).previewUrl || attachment.dataUrl : ''
  const title = `${attachment.name} · ${formatFileSize(attachment.size)}`

  return (
    <div className={`${styles.attachmentCard} ${imageSrc ? styles.attachmentCardVisual : ''}`} key={attachment.id} title={title}>
      {imageSrc ? (
        <img className={styles.attachmentThumb} src={imageSrc} alt={attachment.name} />
      ) : videoSrc ? (
        <video className={styles.attachmentThumb} src={videoSrc} preload="metadata" muted />
      ) : (
        <span className={styles.attachmentIcon}>{getAttachmentIcon(attachment.kind)}</span>
      )}
      <span className={styles.attachmentMeta}>
        <span className={styles.attachmentName}>{attachment.name}</span>
        <span className={styles.attachmentSize}>{formatFileSize(attachment.size)}</span>
      </span>
      {options.removable && (
        <button
          type="button"
          className={styles.attachmentRemove}
          onClick={() => options.onRemove?.(attachment.id)}
          aria-label={`Quitar ${attachment.name}`}
          title="Quitar archivo"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}

function renderAttachmentList(
  attachments: Array<AIAgentAttachment | AIAgentAttachmentDraft>,
  options: {
    removable?: boolean
    onRemove?: (id: string) => void
  } = {}
) {
  if (!attachments.length) return null

  return (
    <div className={styles.attachmentsList}>
      {attachments.map((attachment) => renderAttachmentPreview(attachment, options))}
    </div>
  )
}

export const AIAgentPanel: React.FC<AIAgentPanelProps> = ({ variant = 'floating', onOpenChange }) => {
  const location = useLocation()
  const { showToast } = useNotification()
  const embedded = variant === 'embedded'
  const docked = variant === 'docked'
  const [open, setOpen] = useState(() => embedded || getStoredOpenState())
  const [status, setStatus] = useState<AIAgentConfigStatus>(emptyStatus)
  const [form, setForm] = useState<AIAgentConfigInput>(emptyForm)
  const [messages, setMessages] = useState<AIAgentMessage[]>([])
  const [input, setInput] = useState('')
  const [sitesCreationMode, setSitesCreationMode] = useState<SitesCreationMode | null>(null)
  const [attachments, setAttachments] = useState<AIAgentAttachmentDraft[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [savingConfig, setSavingConfig] = useState(false)
  const [sending, setSending] = useState(false)
  const [unreadReplies, setUnreadReplies] = useState(0)
  const [voiceState, setVoiceState] = useState<VoiceCaptureState>('idle')
  const [voiceBars, setVoiceBars] = useState<number[]>(createInitialVoiceBars)
  const [voiceElapsed, setVoiceElapsed] = useState(0)
  const [voiceTranscript, setVoiceTranscript] = useState('')
  const [voiceError, setVoiceError] = useState('')
  const [copyingChat, setCopyingChat] = useState(false)
  const [chatCopied, setChatCopied] = useState(false)
  const askedOnboardingRef = useRef(false)
  const messagesRef = useRef(messages)
  const activeChatRequestRef = useRef<{ id: number; controller: AbortController } | null>(null)
  const chatRequestSeqRef = useRef(0)
  const previousMessageCountRef = useRef(messages.length)
  const endRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const attachmentsRef = useRef(attachments)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const voiceAnimationFrameRef = useRef<number | null>(null)
  const voiceAudioChunksRef = useRef<Blob[]>([])
  const voiceEndActionRef = useRef<VoiceEndAction | null>(null)
  const voiceHadErrorRef = useRef(false)
  const voiceIgnoreEndRef = useRef(false)
  const lastVoiceWaveUpdateRef = useRef(0)
  const copyFeedbackTimeoutRef = useRef<number | null>(null)

  const nextOnboardingQuestion = useMemo(() => getNextOnboardingQuestion(form), [form])
  const businessContextLoaded = hasBusinessContext(form)
  const voiceIsActive = voiceState !== 'idle'
  const formattedVoiceElapsed = useMemo(() => formatVoiceDuration(voiceElapsed), [voiceElapsed])
  const visible = embedded || open
  const thinkingActions = useMemo(
    () => getThinkingActions(messages, location.pathname, savingConfig),
    [location.pathname, messages, savingConfig]
  )
  const thinkingActionKey = thinkingActions.join('|')
  const [thinkingActionIndex, setThinkingActionIndex] = useState(0)
  const thinkingAction = thinkingActions[thinkingActionIndex % thinkingActions.length] || 'Pensando'

  const focusComposer = () => {
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const emitConfigChange = (nextStatus: AIAgentConfigStatus) => {
    window.dispatchEvent(new CustomEvent('ai-agent-config-changed', {
      detail: nextStatus
    }))
  }

  const setOpenState = useCallback((nextOpen: boolean) => {
    if (embedded) {
      setOpen(true)
      setUnreadReplies(0)
      return
    }

    setOpen(nextOpen)
    if (nextOpen) {
      setUnreadReplies(0)
    }
    saveOpenState(nextOpen)
  }, [embedded])

  const applyStatus = (nextStatus: AIAgentConfigStatus) => {
    setStatus(nextStatus)
    setForm(statusToForm(nextStatus))
  }

  const loadStatus = async () => {
    setLoadingConfig(true)
    try {
      const nextStatus = await aiAgentService.getConfig()
      applyStatus(nextStatus)
    } catch {
      applyStatus(emptyStatus)
    } finally {
      setLoadingConfig(false)
    }
  }

  useEffect(() => {
    clearLegacyStoredMessages()
    loadStatus()

    const handleConfigChange = (event: Event) => {
      const customEvent = event as CustomEvent<AIAgentConfigStatus>
      if (customEvent.detail) {
        applyStatus(customEvent.detail)
      } else {
        loadStatus()
      }
    }

    window.addEventListener('ai-agent-config-changed', handleConfigChange)

    return () => {
      window.removeEventListener('ai-agent-config-changed', handleConfigChange)
    }
  }, [])

  useEffect(() => {
    if (embedded) return

    const handleCloseRequest = () => {
      setOpenState(false)
    }

    const handleOpenRequest = (event: Event) => {
      const detail = (event as CustomEvent<AIAgentOpenRequestDetail>).detail
      setOpenState(true)

      if (!detail?.sitesCreation?.siteKind) {
        focusComposer()
        return
      }

      activeChatRequestRef.current?.controller.abort()
      activeChatRequestRef.current = null
      chatRequestSeqRef.current += 1

      const nextMessage = createMessage(
        'assistant',
        getSitesAIIntro(detail.sitesCreation.siteKind, detail.sitesCreation.siteTitle || '')
      )
      messagesRef.current = [nextMessage]
      attachmentsRef.current.forEach(revokeAttachmentPreview)
      attachmentsRef.current = []
      setSitesCreationMode({
        siteKind: detail.sitesCreation.siteKind,
        editSiteId: detail.sitesCreation.editSiteId,
        metaCapiEnabled: detail.sitesCreation.metaCapiEnabled,
        siteTitle: detail.sitesCreation.siteTitle
      })
      setMessages([nextMessage])
      setInput('')
      setAttachments([])
      setAttachmentError('')
      setSending(false)
      setUnreadReplies(0)
      focusComposer()
    }

    window.addEventListener(AI_AGENT_CLOSE_REQUEST_EVENT, handleCloseRequest)
    window.addEventListener(AI_AGENT_OPEN_REQUEST_EVENT, handleOpenRequest)
    return () => {
      window.removeEventListener(AI_AGENT_CLOSE_REQUEST_EVENT, handleCloseRequest)
      window.removeEventListener(AI_AGENT_OPEN_REQUEST_EVENT, handleOpenRequest)
    }
  }, [embedded, setOpenState])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, sending, savingConfig, visible])

  useEffect(() => {
    if (!sending && !savingConfig) {
      setThinkingActionIndex(0)
      return
    }

    setThinkingActionIndex(0)
    const interval = window.setInterval(() => {
      setThinkingActionIndex((current) => current + 1)
    }, 1450)

    return () => window.clearInterval(interval)
  }, [sending, savingConfig, thinkingActionKey])

  useEffect(() => {
    onOpenChange?.(visible)
  }, [onOpenChange, visible])

  useEffect(() => {
    if (embedded) return

    const launcherVisible = !open
    if (launcherVisible) {
      document.body.dataset.aiAgentLauncher = 'visible'
    } else {
      delete document.body.dataset.aiAgentLauncher
    }

    return () => {
      delete document.body.dataset.aiAgentLauncher
    }
  }, [embedded, open])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, embedded ? 132 : 160)}px`
  }, [embedded, input, nextOnboardingQuestion, status.configured])

  useEffect(() => {
    if (embedded) {
      setUnreadReplies(0)
      previousMessageCountRef.current = messages.length
      return
    }

    if (open) {
      setUnreadReplies(0)
      previousMessageCountRef.current = messages.length
      return
    }

    if (messages.length > previousMessageCountRef.current) {
      const newMessages = messages.slice(previousMessageCountRef.current)
      const newAssistantReplies = newMessages.filter((message) => message.role === 'assistant').length

      if (newAssistantReplies > 0) {
        setUnreadReplies((current) => Math.min(current + newAssistantReplies, 9))
      }
    }

    previousMessageCountRef.current = messages.length
  }, [embedded, messages, open])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => {
    if (sitesCreationMode || loadingConfig || askedOnboardingRef.current || businessContextLoaded || !status.configured) return

    askedOnboardingRef.current = true
    const firstQuestion = getNextOnboardingQuestion(form)
    if (!firstQuestion) return

    setMessages((current) => {
      return [
        ...current,
        createMessage('assistant', 'Ya con OpenAI conectado, te haré unas preguntas del negocio. Tú escríbelo como te salga; yo lo redacto bien y lo guardo en Configuración.'),
        createMessage('assistant', firstQuestion.question)
      ]
    })
  }, [businessContextLoaded, form, loadingConfig, sitesCreationMode, status.configured])

  const getViewContext = (): AIAgentViewContext => ({
    path: location.pathname,
    title: document.title || 'Ristak',
    routeLabel: getRouteLabel(location.pathname),
    visibleText: collectVisibleText()
  })

  const openFilePicker = () => {
    if (savingConfig || voiceIsActive) return
    fileInputRef.current?.click()
  }

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id)
      if (removed) revokeAttachmentPreview(removed)
      return current.filter((attachment) => attachment.id !== id)
    })
  }

  const handleFileSelection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || [])
    event.target.value = ''

    if (!selectedFiles.length) return

    const currentAttachments = attachmentsRef.current
    const availableSlots = Math.max(0, MAX_ATTACHMENTS - currentAttachments.length)
    const files = selectedFiles.slice(0, availableSlots)
    const currentTotalSize = currentAttachments.reduce((sum, attachment) => sum + attachment.size, 0)
    let nextTotalSize = currentTotalSize
    const rejectedMessages: string[] = []

    if (!availableSlots) {
      setAttachmentError(`Máximo ${MAX_ATTACHMENTS} archivos por mensaje.`)
      return
    }

    if (selectedFiles.length > files.length) {
      rejectedMessages.push(`Sólo agregué ${files.length} de ${selectedFiles.length} archivos.`)
    }

    const nextAttachments: AIAgentAttachmentDraft[] = []

    for (const file of files) {
      if (nextTotalSize + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
        rejectedMessages.push(`${file.name} excede el límite total de ${formatFileSize(MAX_ATTACHMENT_TOTAL_BYTES)}.`)
        continue
      }

      try {
        const attachment = await createAttachmentFromFile(file)
        nextAttachments.push(attachment)
        nextTotalSize += file.size
      } catch {
        rejectedMessages.push(`No pude leer ${file.name}.`)
      }
    }

    if (nextAttachments.length) {
      setAttachments((current) => [...current, ...nextAttachments])
      window.requestAnimationFrame(() => textareaRef.current?.focus())
    }

    setAttachmentError(rejectedMessages.join(' '))
  }

  const saveAgentConfig = async (nextConfig: AIAgentConfigInput, apiKey?: string) => {
    const nextStatus = await aiAgentService.saveConfig({
      ...prepareConfigForSave(nextConfig),
      apiKey: apiKey?.trim() || undefined
    })
    applyStatus(nextStatus)
    emitConfigChange(nextStatus)
    return nextStatus
  }

  const saveTokenFromChat = async () => {
    const apiKey = apiKeyInput.trim()

    if (!apiKey) {
      setMessages((current) => [
        ...current,
        createMessage('assistant', 'Pega tu API key de OpenAI para activar el agente.')
      ])
      return
    }

    setSavingConfig(true)
    try {
      const nextStatus = await saveAgentConfig(form, apiKey)
      setApiKeyInput('')
      setMessages((current) => [
        ...current,
        createMessage('assistant', nextStatus.configured ? 'Listo, ya conecté OpenAI. Ahora puedo analizar tus datos y contexto desde este chat.' : 'Guardé la configuración, pero todavía no quedó activo el token.')
      ])
    } catch (error: any) {
      setMessages((current) => [
        ...current,
        createMessage('assistant', `No pude guardar el token. ${error?.message || 'Revisa que sea una API key válida.'}`)
      ])
    } finally {
      setSavingConfig(false)
      textareaRef.current?.focus()
    }
  }

  const saveOnboardingAnswer = async (text: string, userMessage: AIAgentMessage) => {
    const currentQuestion = getNextOnboardingQuestion(form)
    if (!currentQuestion || !status.configured) return false

    setMessages((current) => [...current, userMessage])
    setSending(true)

    try {
      const result = await aiAgentService.saveBusinessContextAnswer(currentQuestion.field, text)
      const nextStatus = result.status
      const nextForm = statusToForm(nextStatus)
      applyStatus(nextStatus)
      emitConfigChange(nextStatus)
      const followingQuestion = getNextOnboardingQuestion(nextForm)

      setMessages((current) => [
        ...current,
        createMessage(
          'assistant',
          followingQuestion
            ? `Listo, lo redacté y lo guardé en Configuración.\n\n${followingQuestion.question}`
            : 'Perfecto, ya redacté y guardé el contexto del negocio. Ahora sí puedo darte recomendaciones con más criterio.'
        )
      ])
    } catch (error: any) {
      setMessages((current) => [
        ...current,
        createMessage('assistant', `No pude guardar esta respuesta. ${error?.message || 'Inténtalo otra vez.'}`)
      ])
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }

    return true
  }

  const sendSitesCreationMessage = async (userMessage: AIAgentMessage) => {
    if (!sitesCreationMode) return false

    activeChatRequestRef.current?.controller.abort()

    const controller = new AbortController()
    const requestId = chatRequestSeqRef.current + 1
    chatRequestSeqRef.current = requestId
    activeChatRequestRef.current = { id: requestId, controller }

    const nextMessages = [...messagesRef.current, userMessage]
    setMessages(nextMessages)
    setSending(true)

    try {
      const requestMessages = prepareSitesCreationMessages(nextMessages)
      const result = sitesCreationMode.editSiteId
        ? await sitesService.editImportedHtmlWithAI(sitesCreationMode.editSiteId, {
            siteKind: sitesCreationMode.siteKind,
            messages: requestMessages
          })
        : await sitesService.createWithAIHtml({
            siteKind: sitesCreationMode.siteKind,
            messages: requestMessages,
            metaCapiEnabled: sitesCreationMode.metaCapiEnabled
          })

      if (activeChatRequestRef.current?.id !== requestId) return true

      setMessages((current) => [
        ...current,
        createMessage('assistant', result.reply || 'Listo, sigo esperando la información para armar el borrador.')
      ])

      if ((result.status === 'created' || result.status === 'updated') && result.site) {
        setSitesCreationMode(null)
        window.dispatchEvent(new CustomEvent(SITES_AI_DRAFT_CREATED_EVENT, {
          detail: result.import
            ? { site: result.site, import: result.import, reviewMapping: true }
            : result.site
        }))
        showToast(
          'success',
          result.status === 'updated' ? 'HTML actualizado' : 'Borrador creado',
          'Ya lo abrí con vista previa y revisión de campos.'
        )
      }
    } catch (error: any) {
      if (error?.name === 'AbortError' || activeChatRequestRef.current?.id !== requestId) return true

      setMessages((current) => [
        ...current,
        createMessage('assistant', `No pude completar la creación con IA. ${error?.message || 'Revisa la configuración de OpenAI e inténtalo otra vez.'}`)
      ])
    } finally {
      if (activeChatRequestRef.current?.id === requestId) {
        activeChatRequestRef.current = null
        setSending(false)
        focusComposer()
      }
    }

    return true
  }

  const sendMessage = async (
    overrideText?: string,
    selectedClarificationOption?: AIAgentMessage['selectedClarificationOption'],
    options: SendMessageOptions = {}
  ) => {
    const messageAttachments = overrideText === undefined ? [...attachmentsRef.current] : []
    const text = (overrideText ?? input).trim()
    const messageText = text || buildAttachmentPrompt(messageAttachments)

    if ((!messageText && !messageAttachments.length) || savingConfig) return

    if (nextOnboardingQuestion && !options.forceChat && messageAttachments.length) {
      setAttachmentError('Primero responde el contexto en texto; los archivos los analizamos después.')
      return
    }

    if (sitesCreationMode && messageAttachments.length) {
      setAttachmentError('Para crear Sites con IA responde en texto. Después puedes editar la pagina generada desde la vista previa.')
      return
    }

    const userMessage = createMessage(
      'user',
      messageText,
      undefined,
      undefined,
      messageAttachments,
      selectedClarificationOption
    )
    setInput('')
    setAttachments([])
    setAttachmentError('')
    focusComposer()

    if (!status.configured) {
      setMessages((current) => [
        ...current,
        userMessage,
        createMessage(
          'assistant',
          needsReconnect
            ? 'OpenAI necesita reconectarse. Pega tu API token arriba y vuelvo a funcionar con voz y chat.'
            : 'Primero conecta tu API key de OpenAI. Después te hago las preguntas del negocio y yo mismo redacto bien tus respuestas para guardarlas en Configuración.'
        )
      ])
      focusComposer()
      return
    }

    if (sitesCreationMode) {
      await sendSitesCreationMessage(userMessage)
      return
    }

    if (nextOnboardingQuestion && !options.forceChat) {
      await saveOnboardingAnswer(messageText, userMessage)
      return
    }

    activeChatRequestRef.current?.controller.abort()

    const controller = new AbortController()
    const requestId = chatRequestSeqRef.current + 1
    chatRequestSeqRef.current = requestId
    activeChatRequestRef.current = { id: requestId, controller }

    const nextMessages = [...messagesRef.current, userMessage]

    setMessages(nextMessages)
    setSending(true)

    try {
      const result = await aiAgentService.sendMessage(prepareMessagesForApi(nextMessages), getViewContext(), {
        signal: controller.signal
      })

      if (activeChatRequestRef.current?.id !== requestId) return

      setMessages((current) => [
        ...current,
        createMessage('assistant', result.reply, result.sources, result.clarificationOptions, undefined, undefined, result.agentMemory, result.trace)
      ])
    } catch (error: any) {
      if (error?.name === 'AbortError' || activeChatRequestRef.current?.id !== requestId) return

      setMessages((current) => [
        ...current,
        createMessage(
          'assistant',
          `No pude responder ahorita. ${error?.message || 'Revisa la configuración del Agente AI.'}`,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          error?.trace
        )
      ])
    } finally {
      if (activeChatRequestRef.current?.id === requestId) {
        activeChatRequestRef.current = null
        setSending(false)
        focusComposer()
      }
    }
  }

  const handleClarificationOptionClick = (assistantMessage: AIAgentMessage, option: AIAgentClarificationOption) => {
    const visibleLabel = option.label.trim() || 'Seleccionado'

    sendMessage(visibleLabel, {
      label: visibleLabel,
      value: option.value,
      ...(option.description ? { description: option.description } : {}),
      ...(assistantMessage.id ? { assistantMessageId: assistantMessage.id } : {})
    })
  }

  const stopVoiceMeter = () => {
    if (voiceAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(voiceAnimationFrameRef.current)
      voiceAnimationFrameRef.current = null
    }

    audioSourceRef.current?.disconnect()
    audioSourceRef.current = null
    analyserRef.current = null

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => undefined)
      audioContextRef.current = null
    }

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaStreamRef.current = null
  }

  const startVoiceMeter = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Tu navegador no permite usar el micrófono desde esta pantalla.')
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    mediaStreamRef.current = stream

    const AudioContextConstructor = getAudioContextConstructor()
    if (!AudioContextConstructor) return stream

    const audioContext = new AudioContextConstructor()
    const analyser = audioContext.createAnalyser()
    const source = audioContext.createMediaStreamSource(stream)

    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.72
    const samples = new Uint8Array(analyser.fftSize)
    source.connect(analyser)

    audioContextRef.current = audioContext
    audioSourceRef.current = source
    analyserRef.current = analyser
    lastVoiceWaveUpdateRef.current = 0

    const drawWave = (timestamp: number) => {
      if (!analyserRef.current) return

      if (timestamp - lastVoiceWaveUpdateRef.current > 55) {
        analyserRef.current.getByteTimeDomainData(samples)
        const nextHeight = getVoiceBarHeight(samples)

        setVoiceBars((current) => [...current.slice(1), nextHeight])
        lastVoiceWaveUpdateRef.current = timestamp
      }

      voiceAnimationFrameRef.current = window.requestAnimationFrame(drawWave)
    }

    voiceAnimationFrameRef.current = window.requestAnimationFrame(drawWave)

    return stream
  }

  const setVoiceErrorMessage = (message: string) => {
    voiceHadErrorRef.current = Boolean(message)
    setVoiceError(message)
  }

  const resetVoiceCapture = () => {
    mediaRecorderRef.current = null
    voiceEndActionRef.current = null
    stopVoiceMeter()
    setVoiceState('idle')
    setVoiceElapsed(0)
    setVoiceTranscript('')
    setVoiceBars(createInitialVoiceBars())
  }

  const completeVoiceCapture = async (audioBlob: Blob, action: VoiceEndAction) => {
    setVoiceTranscript('Transcribiendo audio...')
    stopVoiceMeter()

    if (!audioBlob.size) {
      resetVoiceCapture()
      if (!voiceHadErrorRef.current) {
        setVoiceErrorMessage('No alcancé a grabar audio. Inténtalo otra vez.')
      }
      textareaRef.current?.focus()
      return
    }

    let transcript = ''

    try {
      const result = await aiAgentService.transcribeVoice(audioBlob)
      transcript = result.text.trim()
    } catch (error: any) {
      resetVoiceCapture()
      setVoiceErrorMessage(error?.message || 'No pude transcribir el audio.')
      textareaRef.current?.focus()
      return
    }

    resetVoiceCapture()

    if (!transcript) {
      if (!voiceHadErrorRef.current) {
        setVoiceErrorMessage('No alcancé a transcribir audio. Inténtalo otra vez.')
      }
      textareaRef.current?.focus()
      return
    }

    setVoiceErrorMessage('')

    if (action === 'send') {
      sendMessage(transcript)
      return
    }

    setInput((current) => {
      if (!current.trim()) return transcript
      return `${current}${/\s$/.test(current) ? '' : ' '}${transcript}`
    })

    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const startVoiceRecording = async () => {
    if (voiceIsActive || savingConfig) return

    if (!status.configured) {
      setVoiceErrorMessage(needsReconnect ? 'Reconecta OpenAI para volver a dictar mensajes de voz.' : 'Conecta OpenAI para transcribir mensajes de voz.')
      return
    }

    if (typeof MediaRecorder === 'undefined') {
      setVoiceErrorMessage('Tu navegador no permite grabar audio desde esta pantalla.')
      return
    }

    voiceAudioChunksRef.current = []
    voiceEndActionRef.current = 'draft'
    voiceHadErrorRef.current = false
    voiceIgnoreEndRef.current = false
    setVoiceError('')
    setVoiceTranscript('')
    setVoiceElapsed(0)
    setVoiceBars(createInitialVoiceBars())

    try {
      const stream = await startVoiceMeter()
      const mimeType = getVoiceMimeType()
      const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          voiceAudioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onerror = () => {
        setVoiceErrorMessage('No pude grabar el audio del micrófono.')
      }

      mediaRecorder.onstop = () => {
        if (voiceIgnoreEndRef.current) return

        const audioType = mediaRecorder.mimeType || mimeType || 'audio/webm'
        const audioBlob = new Blob(voiceAudioChunksRef.current, { type: audioType })
        completeVoiceCapture(audioBlob, voiceEndActionRef.current || 'draft')
      }

      mediaRecorderRef.current = mediaRecorder
      setVoiceState('recording')
      setVoiceTranscript('Grabando audio...')
      mediaRecorder.start()
    } catch (error: any) {
      mediaRecorderRef.current = null
      voiceEndActionRef.current = null
      stopVoiceMeter()
      setVoiceState('idle')
      setVoiceErrorMessage(error?.message || 'No pude acceder al micrófono.')
    }
  }

  const finishVoiceRecording = (action: 'draft' | 'send') => {
    if (!voiceIsActive || voiceState === 'finalizing') return

    voiceEndActionRef.current = action
    setVoiceState('finalizing')
    setVoiceTranscript('Preparando transcripción...')

    try {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      } else {
        const audioBlob = new Blob(voiceAudioChunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'audio/webm' })
        completeVoiceCapture(audioBlob, action)
      }
    } catch {
      const audioBlob = new Blob(voiceAudioChunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'audio/webm' })
      completeVoiceCapture(audioBlob, action)
    }
  }

  useEffect(() => {
    if (voiceState !== 'recording') return

    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setVoiceElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 250)

    return () => window.clearInterval(timer)
  }, [voiceState])

  useEffect(() => {
    return () => {
      activeChatRequestRef.current?.controller.abort()
      activeChatRequestRef.current = null
      voiceIgnoreEndRef.current = true
      voiceEndActionRef.current = null
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      mediaRecorderRef.current = null
      stopVoiceMeter()
      if (copyFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(copyFeedbackTimeoutRef.current)
      }
      attachmentsRef.current.forEach(revokeAttachmentPreview)
      messagesRef.current.forEach((message) => message.attachments?.forEach(revokeAttachmentPreview))
    }
  }, [])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendMessage()
    }
  }

  const copyChat = async () => {
    const currentMessages = messagesRef.current
    if (!currentMessages.length || copyingChat) return

    setCopyingChat(true)

    try {
      const transcript = buildChatTranscript(currentMessages, {
        panelTitle,
        routeLabel: getRouteLabel(location.pathname),
        path: location.pathname,
        pageTitle: document.title || 'Ristak',
        copiedAt: new Date().toISOString()
      })

      await copyTextToClipboard(transcript)
      setChatCopied(true)
      showToast('success', 'Chat copiado', 'Listo: quedó en formato de conversación para pegarlo donde quieras.')

      if (copyFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(copyFeedbackTimeoutRef.current)
      }

      copyFeedbackTimeoutRef.current = window.setTimeout(() => {
        setChatCopied(false)
        copyFeedbackTimeoutRef.current = null
      }, 2200)
    } catch {
      showToast('error', 'No se pudo copiar', 'Tu navegador bloqueó el portapapeles. Inténtalo otra vez.')
    } finally {
      setCopyingChat(false)
    }
  }

  const clearChat = () => {
    activeChatRequestRef.current?.controller.abort()
    activeChatRequestRef.current = null
    chatRequestSeqRef.current += 1
    setSending(false)
    askedOnboardingRef.current = businessContextLoaded
    attachmentsRef.current.forEach(revokeAttachmentPreview)
    messagesRef.current.forEach((message) => message.attachments?.forEach(revokeAttachmentPreview))
    messagesRef.current = []
    attachmentsRef.current = []
    previousMessageCountRef.current = 0
    if (copyFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(copyFeedbackTimeoutRef.current)
      copyFeedbackTimeoutRef.current = null
    }
    setMessages([])
    setAttachments([])
    setInput('')
    setUnreadReplies(0)
    setChatCopied(false)
    setCopyingChat(false)
    setAttachmentError('')
    setSitesCreationMode(null)
    focusComposer()
  }

  const floatingButtonClassName = `${styles.floatingButton} ${unreadReplies ? styles.floatingButtonUnread : ''}`
  const closedButtonLabel = unreadReplies
    ? `Abrir agente AI, ${unreadReplies} respuesta nueva`
    : 'Abrir agente AI'
  const rootClassName = embedded ? styles.embeddedRoot : docked ? styles.dockedRoot : styles.floatingRoot
  const windowClassName = embedded
    ? `${styles.window} ${styles.embeddedWindow}`
    : docked
      ? `${styles.window} ${styles.dockedWindow}`
      : styles.window
  const textComposerClassName = attachments.length
    ? `${styles.textComposer} ${styles.textComposerWithAttachments}`
    : styles.textComposer
  const panelTitle = sitesCreationMode ? 'Creador HTML con IA' : embedded ? 'Ristak AI' : 'Agente AI'
  const needsReconnect = Boolean(status.needsReconnect)
  const statusLabel = status.configured
    ? sitesCreationMode
      ? sitesCreationMode.editSiteId ? 'Editando HTML importado' : 'Creando HTML importable'
      : embedded ? 'Listo para ayudarte' : 'Conectado a OpenAI'
    : needsReconnect ? 'Reconecta OpenAI' : 'Configúralo aquí mismo'

  return (
    <div className={rootClassName}>
      {visible && (
        <section className={windowClassName} aria-label={panelTitle}>
          <header className={styles.header}>
            <div className={styles.identity}>
              <div className={styles.avatar}>
                <Bot size={19} />
              </div>
              <div className={styles.titleBlock}>
                <h2 className={styles.title}>{panelTitle}</h2>
                <div className={styles.subtitle}>
                  <span className={status.configured ? styles.statusDot : styles.statusDotMuted} />
                  <span>{statusLabel}</span>
                </div>
              </div>
            </div>

            <div className={styles.headerActions}>
              <button
                type="button"
                className={`${styles.iconButton} ${chatCopied ? styles.iconButtonSuccess : ''}`}
                onClick={copyChat}
                disabled={!messages.length || copyingChat}
                aria-label={chatCopied ? 'Chat copiado' : 'Copiar chat'}
                title={chatCopied ? 'Chat copiado' : 'Copiar chat en formato Codex'}
              >
                {chatCopied ? <Check size={16} /> : <Copy size={16} />}
              </button>
              <button
                type="button"
                className={styles.iconButton}
                onClick={clearChat}
                disabled={!messages.length || savingConfig}
                aria-label="Limpiar chat"
                title="Limpiar chat"
              >
                <Eraser size={16} />
              </button>
              {!embedded && (
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => setOpenState(false)}
                  aria-label="Cerrar chat"
                  title="Cerrar chat"
                >
                  <X size={17} />
                </button>
              )}
            </div>
          </header>

          {!status.configured && (
            <div className={styles.setupCard}>
              <div className={styles.setupTitle}>
                <KeyRound size={16} />
                {needsReconnect ? 'Reconectar OpenAI' : 'Conectar OpenAI'}
              </div>
              {needsReconnect && (
                <p className={styles.setupHint}>
                  El token guardado ya no se puede leer. Pega el token otra vez y queda listo para voz y chat.
                </p>
              )}
              <div className={styles.setupForm}>
                <input
                  className={styles.setupInput}
                  type="password"
                  value={apiKeyInput}
                  placeholder={needsReconnect ? 'Pega tu token para reconectar...' : 'Pega tu API key sk-...'}
                  autoComplete="off"
                  onChange={(event) => setApiKeyInput(event.target.value)}
                  disabled={savingConfig || loadingConfig}
                />
                <button
                  type="button"
                  className={styles.setupButton}
                  onClick={saveTokenFromChat}
                  disabled={savingConfig || loadingConfig || !apiKeyInput.trim()}
                >
                  {savingConfig ? 'Guardando...' : needsReconnect ? 'Reconectar' : 'Guardar'}
                </button>
              </div>
            </div>
          )}

          {status.configured && !businessContextLoaded && !loadingConfig && (
            <div className={styles.contextNotice}>
              <Sparkles size={15} />
              Falta contexto del negocio. Respóndeme estas preguntas y yo lo redacto antes de guardarlo en Configuración.
            </div>
          )}

          <div className={styles.body} data-ai-agent-scrollable="true">
            {messages.length === 0 ? (
              <div className={styles.empty}>
                <p className={styles.emptyText}>
                  Pregúntame por ventas, citas, campañas, contactos o por lo que estás viendo en esta pantalla.
                </p>
                {status.configured && (
                  <div className={styles.suggestions}>
                    {quickActions.map(({ label, description, prompt, Icon }) => (
                      <button
                        key={label}
                        type="button"
                        className={styles.suggestionButton}
                        onClick={() => sendMessage(prompt, undefined, { forceChat: true })}
                        disabled={savingConfig}
                      >
                        <span className={styles.suggestionIcon}>
                          <Icon size={16} />
                        </span>
                        <span className={styles.suggestionCopy}>
                          <span className={styles.suggestionLabel}>{label}</span>
                          <span className={styles.suggestionDescription}>{description}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className={styles.messages}>
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`${styles.message} ${message.role === 'user' ? styles.messageUser : styles.messageAssistant}`}
                  >
                    <span className={styles.messageLabel}>
                      {message.role === 'user' ? 'Tú' : 'Agente'}
                    </span>
                    {Boolean(message.attachments?.length) && renderAttachmentList(message.attachments || [])}
                    <div className={styles.bubble}>{renderMessageContent(getDisplayMessageContent(message))}</div>
                    {message.role === 'assistant' && message.trace?.traceId && (
                      <div
                        className={`${styles.tracePill} ${message.trace.status === 'failed' ? styles.tracePillError : ''}`}
                        title={`Rastro completo: ${message.trace.traceId}`}
                      >
                        <span>{formatTraceStatus(message.trace.status)}</span>
                        <code>{message.trace.traceId.slice(-8)}</code>
                      </div>
                    )}
                    {message.role === 'assistant' && Boolean(message.clarificationOptions?.length) && (
                      <div className={styles.optionButtons} aria-label="Opciones para aclarar la pregunta">
                        {message.clarificationOptions?.map((option, optionIndex) => (
                          <button
                            key={`${message.id}-${optionIndex}-${option.label}`}
                            type="button"
                            className={styles.optionButton}
                            onClick={() => handleClarificationOptionClick(message, option)}
                            disabled={savingConfig}
                          >
                            <span className={styles.optionLabel}>{option.label}</span>
                            {option.description && (
                              <span className={styles.optionDescription}>{option.description}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                    {message.role === 'assistant' && Boolean(message.sources?.length) && (
                      <div className={styles.sources}>
                        <span className={styles.sourcesLabel}>Fuentes</span>
                        {message.sources?.map((source) => (
                          <React.Fragment key={source.url}>
                            <a
                              href={source.url}
                              target="_blank"
                              rel="noreferrer"
                              className={styles.sourceLink}
                            >
                              {source.title || source.url}
                            </a>
                            {isLikelyMediaUrl(normalizeHttpUrl(source.url)) && renderMediaUrlPreview(source.url, source.title || source.url, `${message.id}-${source.url}`)}
                          </React.Fragment>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

                {(sending || savingConfig) && (
                  <div
                    className={styles.thinkingMessage}
                    role="status"
                    aria-live="polite"
                    aria-label={thinkingAction}
                    title={thinkingAction}
                  >
                    <span className={styles.thinkingText}>
                      {thinkingAction}
                    </span>
                  </div>
                )}
                <div ref={endRef} />
              </div>
            )}
          </div>

          <footer className={styles.composer}>
            {voiceIsActive ? (
              <div className={styles.voiceComposer} aria-label="Grabación de voz en curso">
                <div className={styles.voiceWaveArea}>
                  <div className={styles.voiceWaveform} aria-hidden="true">
                    {voiceBars.map((height, index) => (
                      <span
                        key={`voice-bar-${index}`}
                        className={styles.voiceBar}
                        style={{ '--voice-bar-height': `${height}px` } as React.CSSProperties}
                      />
                    ))}
                  </div>
                  <span className={styles.voiceTranscriptPreview} aria-live="polite">
                    {voiceTranscript || (voiceState === 'finalizing' ? 'Terminando transcripción...' : 'Escuchando...')}
                  </span>
                </div>
                <span className={styles.voiceTimer}>{formattedVoiceElapsed}</span>
                <button
                  type="button"
                  className={styles.voicePauseButton}
                  onClick={() => finishVoiceRecording('draft')}
                  disabled={voiceState === 'finalizing'}
                  aria-label="Pausar y pasar texto al mensaje"
                  title="Pausar y editar texto"
                >
                  <Pause size={15} />
                </button>
                <button
                  type="button"
                  className={styles.voiceSendButton}
                  onClick={() => finishVoiceRecording('send')}
                  disabled={voiceState === 'finalizing'}
                  aria-label="Enviar transcripción al agente"
                  title="Enviar transcripción"
                >
                  <SendHorizonal size={17} />
                </button>
              </div>
            ) : (
              <div className={textComposerClassName}>
                {attachments.length > 0 && renderAttachmentList(attachments, {
                  removable: true,
                  onRemove: removeAttachment
                })}
                <button
                  type="button"
                  className={styles.uploadButton}
                  onClick={openFilePicker}
                  disabled={savingConfig}
                  aria-label="Agregar imagen, video o archivo"
                  title="Agregar archivo"
                >
                  <Paperclip size={18} />
                </button>
                <button
                  type="button"
                  className={styles.micButton}
                  onClick={startVoiceRecording}
                  disabled={savingConfig}
                  aria-label="Dictar mensaje por voz"
                  title="Dictar mensaje por voz"
                >
                  <Mic size={17} />
                </button>
                <textarea
                  ref={textareaRef}
                  className={styles.textarea}
                  value={input}
                  placeholder={status.configured && nextOnboardingQuestion ? 'Responde para guardar contexto...' : status.configured ? 'Pregunta algo del negocio...' : needsReconnect ? 'Pega el token arriba para reconectar...' : 'Pega el token arriba o cuéntame del negocio...'}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={savingConfig}
                  rows={1}
                />
                <button
                  type="button"
                  className={styles.sendButton}
                  onClick={() => sendMessage()}
                  disabled={(!input.trim() && !attachments.length) || savingConfig}
                  aria-label="Enviar mensaje"
                  title="Enviar mensaje"
                >
                  <ArrowUp size={20} />
                </button>
                <input
                  ref={fileInputRef}
                  className={styles.fileInput}
                  type="file"
                  multiple
                  accept={FILE_INPUT_ACCEPT}
                  onChange={handleFileSelection}
                  tabIndex={-1}
                />
              </div>
            )}
            {(voiceError || attachmentError) && (
              <div className={styles.voiceError} role="status">
                {voiceError || attachmentError}
              </div>
            )}
          </footer>
        </section>
      )}

      {!embedded && !open && (
        <button
          type="button"
          className={floatingButtonClassName}
          onClick={() => setOpenState(true)}
          aria-label={closedButtonLabel}
          title={closedButtonLabel}
        >
          <>
            <MessageCircle size={18} />
            <span className={styles.floatingButtonLabel}>Chat AI</span>
            {unreadReplies > 0 && (
              <span className={styles.unreadIndicator} aria-hidden="true">
                <span className={styles.unreadDot} />
                <span className={styles.unreadBadge}>{unreadReplies}</span>
              </span>
            )}
          </>
        </button>
      )}
    </div>
  )
}
