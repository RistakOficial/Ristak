import { WhatsAppIcon, MessengerIcon, InstagramIcon } from './BrandIcons'
import {
  Banknote,
  BellRing,
  Bot,
  Calculator,
  CalendarCheck,
  CalendarClock,
  ClipboardList,
  Clock,
  Droplet,
  Facebook,
  Filter,
  Hourglass,
  Instagram,
  ListChecks,
  Mail,
  Megaphone,
  MessageCircleReply,
  MessageSquareText,
  MousePointerClick,
  PencilLine,
  Receipt,
  RotateCcw,
  Rss,
  Shuffle,
  Sparkles,
  StickyNote,
  Tag,
  Tags,
  Target,
  UserCheck,
  UserCog,
  UserMinus,
  UserPlus,
  UserSearch,
  UserX,
  Webhook,
} from 'lucide-react'
import type { CatalogKind } from '@/services/automationCatalogsService'
import { contactTagsService } from '@/services/contactTagsService'
import { formatDate } from '@/utils/format'
import {
  emptyAdvancedCondition,
  summarizeAdvancedCondition,
  validateAdvancedCondition,
  triggerFiltersSentence,
  validateTriggerFilters
} from './crmFields'

// ---------------------------------------------------------------------------
// Registro central de tipos de nodos del editor de automatizaciones.
// Cada tipo define apariencia, configuración por defecto, formulario
// declarativo (o componente de configuración propio), validación, resumen,
// CTA contextual y salidas (handles).
//
// Canales conversacionales soportados para acciones: WhatsApp, Messenger,
// Instagram Direct y correo saliente.
// ---------------------------------------------------------------------------

export type NodeKind = 'trigger' | 'action'

export type NodeAccent =
  | 'green'
  | 'blue'
  | 'purple'
  | 'coral'
  | 'dark'
  | 'yellow'
  | 'teal'
  | 'pink'
  | 'orange'

export interface NodeOutputHandle {
  id: string
  label?: string
}

export interface ConfigFieldOption {
  value: string
  label: string
}

export type ConfigFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'toggle'
  | 'keywords'
  | 'duration'
  | 'datetime'
  | 'time'
  | 'keyValue'
  | 'customFieldValues'
  | 'percentBranches'
  | 'branches'
  | 'webhookUrl'
  | 'catalogSelect'
  | 'catalogTags'
  | 'postSelect'
  | 'weekdays'
  | 'info'

export interface ConfigField {
  key: string
  label: string
  type: ConfigFieldType
  placeholder?: string
  help?: string
  required?: boolean
  options?: ConfigFieldOption[]
  /** Catálogo CRM para selects dinámicos (etiquetas, calendarios…) */
  catalog?: CatalogKind
  /** Sólo para postSelect: plataforma de las publicaciones (FB/IG) a listar */
  platform?: 'facebook' | 'instagram'
  /** Sólo para catálogos de etiquetas: incluye estados internos calculados */
  includeSystemTags?: boolean
  /** Muestra las variables de contacto disponibles bajo el campo */
  showVariables?: boolean
  /** Texto fijo para campos tipo info */
  text?: string
  /** Visibilidad condicional según la configuración actual */
  showIf?: (config: Record<string, unknown>) => boolean
  /** Campo no esencial: vive detrás de "Opciones avanzadas" */
  advanced?: boolean
}

export interface NodeSummaryData {
  /** Línea descriptiva del estado actual de la configuración */
  text?: string
  /** Contenido destacado en caja (mensaje, prompt, nota) */
  box?: string
  /** Texto a mostrar cuando el nodo aún no está configurado */
  empty?: string
}

/** Configuradores con UI propia (más allá del formulario declarativo) */
export type NodeConfigComponent = 'conditions' | 'wait' | 'drip' | 'goal' | 'whatsapp' | 'message' | 'email' | 'scheduler'

// ---------------------------------------------------------------------------
// Bloques de mensaje tipo ManyChat (varios globos dentro de una cajita)
// ---------------------------------------------------------------------------

export interface MessageButton {
  id: string
  label: string
  /** branch: crea una salida propia del nodo · url: abre un enlace */
  action: 'branch' | 'url'
  url?: string
}

export type MessageBlockType = 'text' | 'delay' | 'image' | 'video' | 'audio' | 'voice' | 'file' | 'template'

export interface MessageBlock {
  id: string
  type: MessageBlockType
  /** Texto compilado con tokens {{contact.x}} (en UI se ven como chips) */
  compiledText?: string
  buttons?: MessageButton[]
  quickReplies?: MessageButton[]
  /** Para bloques de espera interna entre mensajes */
  amount?: number
  unit?: 'seconds' | 'minutes'
  /** Mostrar "escribiendo…" durante el retraso */
  showTyping?: boolean
  /** Adjuntos (imagen, video, audio, nota de voz, archivo): URL del recurso. */
  url?: string
  caption?: string
  /** Compatibilidad con bloques de audio viejos: true los mantiene como voz. */
  voiceNote?: boolean
  /** Bloque de plantilla de WhatsApp */
  templateId?: string
  templateName?: string
  /** Legacy: las plantillas usan sus parámetros guardados en Configuración */
  templateVariables?: Record<string, string>
  /** Legacy: el encabezado se toma de la plantilla guardada */
  headerMediaUrl?: string
}

export const MEDIA_BLOCK_TYPES: MessageBlockType[] = ['image', 'video', 'audio', 'voice', 'file']

export type CommentReplyTarget =
  | 'facebook_public_comment'
  | 'instagram_public_comment'
  | 'messenger_private_message'
  | 'instagram_private_message'

export interface CommentReplyTargetDefinition {
  value: CommentReplyTarget
  label: string
  summary: string
  empty: string
  eventPlatform: 'facebook' | 'instagram'
  delivery: 'public' | 'private'
  apiChannel: 'messenger' | 'instagram'
  allowedBlockTypes: MessageBlockType[]
}

export const COMMENT_REPLY_TARGETS: CommentReplyTargetDefinition[] = [
  {
    value: 'facebook_public_comment',
    label: 'Responder comentario público en Facebook',
    summary: 'Respuesta pública en Facebook',
    empty: 'Agrega la respuesta pública de Facebook',
    eventPlatform: 'facebook',
    delivery: 'public',
    apiChannel: 'messenger',
    allowedBlockTypes: ['text', 'image']
  },
  {
    value: 'instagram_public_comment',
    label: 'Responder comentario público en Instagram',
    summary: 'Respuesta pública en Instagram',
    empty: 'Agrega el texto del comentario de Instagram',
    eventPlatform: 'instagram',
    delivery: 'public',
    apiChannel: 'instagram',
    allowedBlockTypes: ['text']
  },
  {
    value: 'messenger_private_message',
    label: 'Enviar mensaje privado por Messenger',
    summary: 'Mensaje privado por Messenger',
    empty: 'Agrega el mensaje privado de Messenger',
    eventPlatform: 'facebook',
    delivery: 'private',
    apiChannel: 'messenger',
    allowedBlockTypes: ['text']
  },
  {
    value: 'instagram_private_message',
    label: 'Enviar mensaje privado por Instagram DM',
    summary: 'Mensaje privado por Instagram DM',
    empty: 'Agrega el mensaje privado de Instagram',
    eventPlatform: 'instagram',
    delivery: 'private',
    apiChannel: 'instagram',
    allowedBlockTypes: ['text']
  }
]

export const COMMENT_REPLY_TARGET_OPTIONS: ConfigFieldOption[] = COMMENT_REPLY_TARGETS.map((target) => ({
  value: target.value,
  label: target.label
}))

const COMMENT_REPLY_TARGET_BY_VALUE = new Map(COMMENT_REPLY_TARGETS.map((target) => [target.value, target]))

export function getCommentReplyTargetDefinition(value: unknown): CommentReplyTargetDefinition | null {
  return COMMENT_REPLY_TARGET_BY_VALUE.get(str(value) as CommentReplyTarget) || null
}

export function getCommentReplyAllowedBlockTypes(config: Record<string, unknown>): MessageBlockType[] {
  return getCommentReplyTargetDefinition(config.commentReplyTarget)?.allowedBlockTypes || []
}

export function sanitizeCommentReplyMessageBlocks(config: Record<string, unknown>): MessageBlock[] {
  const allowed = new Set(getCommentReplyAllowedBlockTypes(config))
  return asMessageBlocks(config.messageBlocks)
    .filter((block) => allowed.size === 0 || allowed.has(block.type))
    .map((block) => ({ ...block, buttons: [], quickReplies: [] }))
}

/** Máximo de salidas/ramas por nodo (incluye botones y quick replies) */
export const MAX_BRANCHES = 10
export const MAX_BUTTONS_PER_MESSAGE = 3

export const asMessageBlocks = (value: unknown): MessageBlock[] =>
  Array.isArray(value) ? (value as MessageBlock[]) : []

/** Salidas que generan los botones/quick replies con acción de rama */
export function messageBlockHandles(config: Record<string, unknown>): NodeOutputHandle[] {
  const handles: NodeOutputHandle[] = []
  asMessageBlocks(config.messageBlocks).forEach((block) => {
    ;[...(block.buttons || []), ...(block.quickReplies || [])].forEach((button) => {
      if (button.action === 'branch' && button.id) {
        handles.push({ id: `btn_${button.id}`, label: button.label || 'Botón' })
      }
    })
  })
  return handles
}

/** Ramas adicionales creadas por el usuario desde la cajita ("+ Agregar rama") */
export function extraBranchHandles(config: Record<string, unknown>): NodeOutputHandle[] {
  const branches = Array.isArray(config.extraBranches)
    ? (config.extraBranches as Array<{ id?: unknown; label?: unknown }>)
    : []
  return branches.map((branch, index) => ({
    id: typeof branch.id === 'string' && branch.id ? branch.id : `extra-${index + 1}`,
    label: typeof branch.label === 'string' && branch.label ? branch.label : `Rama ${index + 1}`
  }))
}

/** Combina salidas base + botones + ramas extra, con tope de 10 */
export function withBranches(
  base: NodeOutputHandle[],
  config: Record<string, unknown>,
  { includeMessageButtons = false }: { includeMessageButtons?: boolean } = {}
): NodeOutputHandle[] {
  const all = [
    ...base,
    ...(includeMessageButtons ? messageBlockHandles(config) : []),
    ...extraBranchHandles(config)
  ]
  return all.slice(0, MAX_BRANCHES)
}

function firstTextBlock(config: Record<string, unknown>): string {
  const block = asMessageBlocks(config.messageBlocks).find(
    (candidate) => candidate.type === 'text' && (candidate.compiledText || '').trim()
  )
  return block?.compiledText || ''
}

function validateMessageBlocks(
  config: Record<string, unknown>,
  options: { strictWhatsAppButtons?: boolean } = {}
): string[] {
  const blocks = asMessageBlocks(config.messageBlocks)
  const errors: string[] = []
  const strictWhatsAppButtons = options.strictWhatsAppButtons === true
  const hasContent = blocks.some(
    (block) =>
      (block.type === 'text' && (block.compiledText || '').trim()) ||
      (MEDIA_BLOCK_TYPES.includes(block.type) && (block.url || '').trim())
  )
  if (!hasContent) {
    errors.push('Agrega al menos un mensaje con contenido')
  }
  blocks.forEach((block, index) => {
    if (block.type === 'delay' && (Number(block.amount) || 0) <= 0) {
      errors.push(`La espera interna del bloque ${index + 1} debe ser mayor a cero`)
    }
    if (MEDIA_BLOCK_TYPES.includes(block.type) && !(block.url || '').trim()) {
      errors.push(`El adjunto del bloque ${index + 1} necesita una URL`)
    }
    const buttons = [...(block.buttons || []), ...(block.quickReplies || [])]
    const urlButtons = buttons.filter((button) => button.action === 'url')
    const branchButtons = buttons.filter((button) => button.action !== 'url')
    if (strictWhatsAppButtons && urlButtons.length > 1) {
      errors.push(`WhatsApp permite un solo botón de URL en el mensaje ${index + 1}`)
    }
    if (strictWhatsAppButtons && urlButtons.length > 0 && branchButtons.length > 0) {
      errors.push(`No mezcles botón de URL con salidas en el mensaje ${index + 1}`)
    }
    buttons.forEach((button) => {
      if (!String(button.label || '').trim()) {
        errors.push(`Hay un botón sin nombre en el mensaje ${index + 1}`)
      }
      if (strictWhatsAppButtons && String(button.label || '').trim().length > 20) {
        errors.push(`El botón "${button.label || 'sin nombre'}" debe tener máximo 20 caracteres`)
      }
      if (button.action === 'url' && !String(button.url || '').trim()) {
        errors.push(`El botón "${button.label || 'sin nombre'}" necesita URL`)
      }
    })
  })
  return errors
}

function validateCommentReply(config: Record<string, unknown>): string[] {
  const errors = validateMessageBlocks(config)
  const target = getCommentReplyTargetDefinition(config.commentReplyTarget)
  if (!target) {
    errors.push('Elige exactamente cómo responder el comentario')
    return errors
  }

  const allowedTypes = new Set(target.allowedBlockTypes)
  const contentBlocks = asMessageBlocks(config.messageBlocks).filter((block) => {
    if (block.type === 'text') return Boolean(str(block.compiledText).trim())
    if (MEDIA_BLOCK_TYPES.includes(block.type)) return Boolean(str(block.url).trim())
    return false
  })
  asMessageBlocks(config.messageBlocks).forEach((block, index) => {
    const buttons = [...(block.buttons || []), ...(block.quickReplies || [])]
    if (buttons.length > 0) {
      errors.push(`La respuesta a comentario no puede usar botones en el bloque ${index + 1}`)
    }
    if (!allowedTypes.has(block.type)) {
      if (target.delivery === 'private' && MEDIA_BLOCK_TYPES.includes(block.type)) {
        errors.push('La respuesta privada inicial a un comentario solo admite texto; después de que la persona responda usa un paso normal de Messenger o Instagram para enviar multimedia')
      } else if (target.value === 'instagram_public_comment' && MEDIA_BLOCK_TYPES.includes(block.type)) {
        errors.push('Instagram no permite adjuntos en respuestas públicas a comentarios; usa solo texto')
      } else if (target.value === 'facebook_public_comment' && MEDIA_BLOCK_TYPES.includes(block.type)) {
        errors.push('Facebook solo permite imagen como adjunto en una respuesta pública a comentario')
      } else if (block.type === 'delay') {
        errors.push('Las respuestas a comentarios no usan retrasos internos; controla el tiempo con un paso Esperar antes')
      } else {
        errors.push(`El bloque ${index + 1} no se puede enviar con "${target.label}"`)
      }
    }
  })

  if (target.delivery === 'private' && contentBlocks.length > 1) {
    errors.push('Meta solo permite un mensaje privado inicial por comentario; deja un solo bloque con contenido')
  }
  return errors
}

export interface NodeDefinition {
  type: string
  kind: NodeKind
  label: string
  /** Texto pequeño sobre el título de la cajita (ej. "Facebook") */
  brand?: string
  category: string
  description?: string
  icon: React.ComponentType<{ size?: number | string; color?: string }>
  accent: NodeAccent
  /** Encabezado con banda de color (lógica, IA, extras) o plano (contenido) */
  tintedHeader?: boolean
  /** CTA contextual dentro de la cajita (ej. "+ Agregar mensaje") */
  addButtonLabel?: string
  /** Canales permitidos cuando el nodo usa canal conversacional */
  allowedChannels?: string[]
  /** Configurador con componente propio */
  configComponent?: NodeConfigComponent
  /** Permite agregar ramas extra desde la cajita ("+ Agregar rama") */
  supportsMultipleBranches?: boolean
  maxBranches?: number
  /** Nodo de mensaje con varios globos (texto, espera, botones) */
  supportsMessageBlocks?: boolean
  /** Quick replies disponibles (Messenger / Instagram Direct) */
  supportsQuickReplies?: boolean
  /** Botones dentro de globos de texto */
  supportsMessageButtons?: boolean
  /** Tipos de bloques disponibles para el editor de mensajes */
  messageBlockTypes?: (config: Record<string, unknown>) => MessageBlockType[]
  supportsVariables?: boolean
  supportsEmoji?: boolean
  defaultConfig: () => Record<string, unknown>
  fields: ConfigField[]
  /** Salidas del nodo según su configuración. [] = sin salidas (comentario) */
  outputs: (config: Record<string, unknown>) => NodeOutputHandle[]
  /** Sin conector de entrada (comentarios) */
  noInput?: boolean
  /** Disponible para flujos existentes, pero no aparece al agregar pasos nuevos */
  hiddenFromPicker?: boolean
  /** Permiso de producto necesario para crear este nodo nuevo */
  requiredFeature?: string
  /** Validación específica además de los campos requeridos */
  validate?: (config: Record<string, unknown>) => string[]
  /** Datos que este bloque puede exponer como variables para pasos posteriores */
  variableOutput?: (config: Record<string, unknown>) => NodeVariableOutput | null
  summary: (config: Record<string, unknown>) => NodeSummaryData
}

export type VariableValueType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'unknown'

export interface VariableSchemaField {
  label: string
  path: string
  type?: VariableValueType
  children?: VariableSchemaField[]
}

export interface NodeVariableOutput {
  baseId: string
  baseLabel: string
  fields?: VariableSchemaField[]
  sampleResponse?: unknown
  requiresSample?: boolean
  unavailableReason?: string
  fixedTokenRoot?: string
}

export interface NodeCategory {
  id: string
  label: string
  kind: NodeKind
}

/** Tipo reservado de la tarjeta inicial "Cuando..." (no vive en el registro) */
export const START_NODE_TYPE = 'start'

export const CONTACT_VARIABLES = [
  '{{nombre}}',
  '{{apellido}}',
  '{{email}}',
  '{{telefono}}',
  '{{etiquetas}}',
  '{{respuesta_ia}}'
]

/** Canales conversacionales disponibles para acciones de chat (sin SMS ni correo) */
export const ALLOWED_CHANNELS = ['whatsapp', 'messenger', 'instagram'] as const

export const CHANNEL_OPTIONS: ConfigFieldOption[] = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'messenger', label: 'Messenger' },
  { value: 'instagram', label: 'Instagram Direct' }
]

export const CHANNEL_OPTIONS_WITH_ANY: ConfigFieldOption[] = [
  { value: 'any', label: 'Cualquier canal disponible' },
  ...CHANNEL_OPTIONS
]

export const NODE_CATEGORIES: NodeCategory[] = [
  { id: 'trigger-contacts', label: 'Contactos', kind: 'trigger' },
  { id: 'trigger-events', label: 'Eventos', kind: 'trigger' },
  { id: 'trigger-appointments', label: 'Citas', kind: 'trigger' },
  { id: 'trigger-fbig', label: 'Facebook/Instagram', kind: 'trigger' },
  { id: 'action-content', label: 'Contenido / Canales', kind: 'action' },
  { id: 'action-contacts', label: 'Contactos', kind: 'action' },
  { id: 'action-logic', label: 'Interno / Lógico', kind: 'action' },
  { id: 'action-data', label: 'Enviar datos', kind: 'action' },
  { id: 'action-ai', label: 'IA', kind: 'action' },
  { id: 'action-extras', label: 'Extras', kind: 'action' }
]

const SINGLE_OUTPUT: NodeOutputHandle[] = [{ id: 'out', label: 'Siguiente paso' }]

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const triggerLinkLabel = (value: unknown): string => str(value)
const tagDisplayName = (config: Record<string, unknown>, key = 'tag'): string => {
  const savedName = str(config[`${key}Name`]).trim()
  if (savedName) return savedName
  return contactTagsService.getDisplayName(str(config[key]))
}
const arr = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const webhookBodyMode = (config: Record<string, unknown>): 'fields' | 'json' => {
  const mode = str(config.bodyMode)
  if (mode === 'fields' || mode === 'json') return mode
  const bodyFields = arr<{ key?: unknown; name?: unknown }>(config.bodyFields)
  if (bodyFields.some((row) => str(row.key || row.name).trim())) return 'fields'
  return str(config.body).trim() ? 'json' : 'fields'
}

const webhookHeadersMode = (config: Record<string, unknown>): 'fields' | 'json' => {
  const mode = str(config.headersMode)
  if (mode === 'fields' || mode === 'json') return mode
  return str(config.headersJson).trim() ? 'json' : 'fields'
}

const isSimpleJsonObject = (value: string): boolean => {
  try {
    const parsed = JSON.parse(value)
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
  } catch {
    return false
  }
}

export const channelLabel = (value: string): string =>
  CHANNEL_OPTIONS_WITH_ANY.find((option) => option.value === value)?.label || value

const DURATION_LABELS: Record<string, [string, string]> = {
  seconds: ['segundo', 'segundos'],
  minutes: ['minuto', 'minutos'],
  hours: ['hora', 'horas'],
  days: ['día', 'días'],
  weeks: ['semana', 'semanas']
}

const DRIP_INTERVAL_UNITS = new Set(['minutes', 'hours', 'days'])

export const durationLabel = (amount: number, unit: string): string => {
  const [singular, plural] = DURATION_LABELS[unit] || DURATION_LABELS.hours
  return `${amount} ${amount === 1 ? singular : plural}`
}

const SCHEDULE_RECURRENCE_LABELS: Record<string, string> = {
  none: 'Una vez',
  daily: 'Cada día',
  weekly: 'Cada semana',
  monthly: 'Cada mes'
}

function formatScheduleDatetime(value: string): string {
  const [date = '', time = ''] = value.split('T')
  if (!date) return ''
  const dateLabel = formatDate(date, { includeYear: true, padDay: false, fallback: date })
  return `${dateLabel}${time ? ` a las ${time}` : ''}`
}

const field = (
  label: string,
  path: string,
  type: VariableValueType = 'string',
  children?: VariableSchemaField[]
): VariableSchemaField => ({ label, path, type, ...(children ? { children } : {}) })

const hasSampleResponse = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0
  return Boolean(value && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length > 0)
}

function parseJsonSample(value: unknown): unknown | null {
  if (!value) return null
  if (typeof value === 'object') return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const WHATSAPP_REPLY_FIELDS: VariableSchemaField[] = [
  field('Cuerpo', 'cuerpo'),
  field('Número del contacto', 'numero_contacto'),
  field('Nombre del contacto', 'nombre_contacto'),
  field('Fecha del mensaje', 'fecha_mensaje'),
  field('ID del mensaje', 'id_mensaje'),
  field('Archivo adjunto', 'archivo_adjunto', 'object', [
    field('Tipo', 'tipo'),
    field('URL', 'url'),
    field('Nombre', 'nombre'),
    field('Tamaño', 'tamaño', 'number')
  ])
]

// Variable del comentario FB/IG: se puede mapear en las acciones (ej. responder
// citando el texto del comentario, o mandarlo por webhook).
const COMMENT_FIELDS: VariableSchemaField[] = [
  field('Texto del comentario', 'texto'),
  field('Autor', 'autor'),
  field('ID del comentario', 'id_comentario'),
  field('ID de la publicación', 'id_publicacion'),
  field('Enlace de la publicación', 'permalink'),
  field('Plataforma', 'plataforma')
]

const FORM_FIELDS: VariableSchemaField[] = [
  field('ID del formulario', 'id_formulario'),
  field('Nombre del formulario', 'nombre_formulario'),
  field('Nombre', 'nombre'),
  field('Teléfono', 'telefono'),
  field('Correo', 'email'),
  field('Estado', 'estado'),
  field('Descalificado', 'descalificado', 'boolean'),
  field('ID del envío', 'id_envio'),
  field('Fecha de envío', 'fecha_de_envio'),
  field('Resumen de respuestas', 'resumen_respuestas'),
  field('Respuestas', 'respuestas', 'object'),
  field('Respuestas por ID', 'respuestas_por_id', 'object')
]

const MESSAGE_TRIGGER_FIELDS: ConfigField[] = []

const TRIGGER_LINK_FIELDS: VariableSchemaField[] = [
  field('ID del enlace', 'id_enlace'),
  field('Nombre del enlace', 'nombre_enlace'),
  field('URL pública', 'url_publica'),
  field('Destino final', 'destino_final'),
  field('Fecha del disparo', 'fecha_disparo')
]

const SCHEDULE_FIELDS: VariableSchemaField[] = [
  field('Fecha programada', 'fecha_programada'),
  field('Zona horaria', 'zona_horaria'),
  field('Recurrencia', 'recurrencia')
]

const CONTACT_OUTPUT_FIELDS: VariableSchemaField[] = [
  field('ID del contacto', 'id_contacto'),
  field('Nombre', 'nombre'),
  field('Teléfono', 'telefono'),
  field('Correo', 'email'),
  field('Etiquetas', 'etiquetas', 'array'),
  field('Campos personalizados', 'campos_personalizados', 'object', [
    field('Interés', 'interes'),
    field('Presupuesto', 'presupuesto'),
    field('Última cita', 'ultima_cita')
  ])
]

const CONTACT_UPDATED_FIELDS: VariableSchemaField[] = [
  field('ID del contacto', 'id_contacto'),
  field('Nombre', 'nombre'),
  field('Teléfono', 'telefono'),
  field('Correo', 'email'),
  field('ID del número de WhatsApp preferido', 'id_numero_whatsapp_preferido'),
  field('Estado de actualización', 'estado_actualizacion')
]

const APPOINTMENT_FIELDS: VariableSchemaField[] = [
  field('ID de la cita', 'id_cita'),
  field('Nombre del contacto', 'nombre_contacto'),
  field('Fecha', 'fecha'),
  field('Hora', 'hora'),
  field('Servicio', 'servicio'),
  field('Estado', 'estado'),
  field('Calendario', 'calendario'),
  field('Notas', 'notas')
]

const PAYMENT_FIELDS: VariableSchemaField[] = [
  field('ID del pago', 'id_pago'),
  field('Monto', 'monto', 'number'),
  field('Moneda', 'moneda'),
  field('Estado', 'estado'),
  field('Producto', 'producto'),
  field('Proveedor', 'proveedor'),
  field('Método de pago', 'metodo_pago'),
  field('Recibo / factura', 'recibo'),
  field('Número de factura', 'numero_factura'),
  field('Fecha', 'fecha')
]

const PAYMENT_ACTION_OPTIONS: ConfigFieldOption[] = [
  { value: 'any', label: 'Todos' },
  { value: 'successful', label: 'Pago exitoso' },
  { value: 'failed', label: 'Error de pago' },
  { value: 'refunded', label: 'Reembolso' },
  { value: 'pending', label: 'Pago pendiente o incompleto' }
]

const PAYMENT_ACTION_SUMMARIES: Record<string, string> = {
  any: 'cualquier tipo de pago',
  successful: 'un pago exitoso',
  failed: 'un error de pago',
  refunded: 'un reembolso',
  pending: 'un pago pendiente o incompleto'
}

const WHATSAPP_SEND_FIELDS: VariableSchemaField[] = [
  field('ID del mensaje', 'id_mensaje'),
  field('Estado', 'estado'),
  field('Número destino', 'numero_destino'),
  field('Fecha de envío', 'fecha_envio')
]

const EMAIL_SEND_FIELDS: VariableSchemaField[] = [
  field('ID del mensaje', 'id_mensaje'),
  field('Estado', 'estado'),
  field('Correo destino', 'correo_destino'),
  field('Asunto', 'asunto'),
  field('Fecha de envío', 'fecha_envio')
]

const httpResponseOutput = (config: Record<string, unknown>): NodeVariableOutput => {
  const sampleResponse = parseJsonSample(config.sampleResponseJson)
  return sampleResponse
    ? { baseId: 'http_request', baseLabel: 'HTTP Request', sampleResponse }
    : {
        baseId: 'http_request',
        baseLabel: 'HTTP Request',
        fields: [
          field('Status', 'status'),
          field('Código de estado', 'status_code', 'number'),
          field('Respuesta', 'respuesta')
        ]
      }
}

const aiOutput = (config: Record<string, unknown>): NodeVariableOutput => {
  const sampleResponse = parseJsonSample(config.sampleResponseJson)
  return sampleResponse
    ? { baseId: 'chatgpt', baseLabel: 'ChatGPT', sampleResponse }
    : { baseId: 'chatgpt', baseLabel: 'ChatGPT', fields: [field('Respuesta', 'respuesta')] }
}

function messageTriggerDefinition({
  type,
  label,
  description,
  icon,
  accent,
  brand,
  summaryBase
}: {
  type: string
  label: string
  description: string
  icon: React.ComponentType<{ size?: number | string; color?: string }>
  accent: NodeAccent
  brand?: string
  summaryBase: string
}): NodeDefinition {
  return {
    type,
    kind: 'trigger',
    label,
    brand,
    category: 'trigger-events',
    description,
    icon,
    accent,
    addButtonLabel: 'Añadir filtro',
    defaultConfig: () => ({ filters: [] }),
    fields: MESSAGE_TRIGGER_FIELDS,
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'respuesta_whatsapp',
      baseLabel: 'Respuesta del contacto',
      fields: WHATSAPP_REPLY_FIELDS,
      fixedTokenRoot: 'respuesta_whatsapp'
    }),
    summary: (config) => {
      const keywords = arr<string>(config.keywords)
      return {
        text: `${summaryBase}${keywords.length > 0 ? ` con "${keywords.join('" o "')}"` : ''}${triggerFiltersSentence(config.filters)}`
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Disparadores
// ---------------------------------------------------------------------------

const TRIGGERS: NodeDefinition[] = [
  {
    type: 'trigger-contact-tag',
    kind: 'trigger',
    label: 'Etiqueta de contacto',
    category: 'trigger-contacts',
    description: 'Se activa cuando una etiqueta cambia en un contacto',
    icon: Tag,
    accent: 'green',
    addButtonLabel: 'Seleccionar etiqueta',
    defaultConfig: () => ({ tag: '', operator: '' }),
    fields: [
      { key: 'tag', label: 'Etiqueta', type: 'catalogSelect', catalog: 'tags', required: true },
      {
        key: 'operator',
        label: 'Cuando una etiqueta es:',
        type: 'select',
        required: true,
        showIf: (config) => Boolean(str(config.tag)),
        options: [
          { value: 'added', label: 'Añadida' },
          { value: 'removed', label: 'Eliminada' }
        ]
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => {
      const verbs: Record<string, string> = {
        added: 'reciba la etiqueta',
        removed: 'pierda la etiqueta',
        contains: 'tenga la etiqueta'
      }
      const tag = tagDisplayName(config)
      return {
        text: tag && str(config.operator)
          ? `Cuando un contacto ${verbs[str(config.operator)] || 'reciba la etiqueta'} "${tag}"${triggerFiltersSentence(config.filters)}`
          : tag
            ? `Selecciona si la etiqueta "${tag}" fue añadida o eliminada`
            : undefined,
        empty: 'Selecciona la etiqueta'
      }
    }
  },
  {
    type: 'trigger-form-submitted',
    kind: 'trigger',
    label: 'Formulario enviado',
    category: 'trigger-events',
    description: 'Se activa cuando alguien envía un formulario',
    icon: ClipboardList,
    accent: 'green',
    requiredFeature: 'forms',
    addButtonLabel: 'Seleccionar formulario',
    defaultConfig: () => ({ form: '', formName: '' }),
    fields: [
      { key: 'form', label: 'Formulario', type: 'catalogSelect', catalog: 'forms', required: true }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: (config) => ({
      baseId: 'formulario',
      baseLabel: str(config.formName) || str(config.form)
        ? `Formulario - ${str(config.formName) || str(config.form)}`
        : 'Formulario',
      fields: FORM_FIELDS
    }),
    summary: (config) => ({
      text: str(config.formName) || str(config.form)
        ? `Cuando alguien envíe el formulario "${str(config.formName) || str(config.form)}"${triggerFiltersSentence(config.filters)}`
        : undefined,
      empty: 'Selecciona el formulario'
    })
  },
  {
    ...messageTriggerDefinition({
      type: 'trigger-whatsapp-message',
      label: 'Mensaje de WhatsApp',
      brand: 'WhatsApp',
      description: 'Se activa cuando llega un mensaje de WhatsApp',
      icon: WhatsAppIcon,
      accent: 'green',
      summaryBase: 'Cuando haya mensaje de WhatsApp'
    }),
    requiredFeature: 'whatsapp',
    allowedChannels: ['whatsapp']
  },
  {
    ...messageTriggerDefinition({
      type: 'trigger-instagram-message',
      label: 'Instagram DM',
      brand: 'Instagram',
      description: 'Se activa cuando llega un DM de Instagram',
      icon: InstagramIcon,
      accent: 'pink',
      summaryBase: 'Cuando haya Instagram DM'
    }),
    requiredFeature: 'campaigns',
    allowedChannels: ['instagram']
  },
  {
    ...messageTriggerDefinition({
      type: 'trigger-messenger-message',
      label: 'Mensaje de Messenger',
      brand: 'Messenger',
      description: 'Se activa cuando llega un mensaje de Messenger',
      icon: MessengerIcon,
      accent: 'blue',
      summaryBase: 'Cuando haya mensaje de Messenger'
    }),
    requiredFeature: 'campaigns',
    allowedChannels: ['messenger']
  },
  {
    ...messageTriggerDefinition({
      type: 'trigger-email-message',
      label: 'Correo electrónico',
      description: 'Se activa cuando llega un correo electrónico',
      icon: Mail,
      accent: 'purple',
    summaryBase: 'Cuando haya correo electrónico'
    }),
    requiredFeature: 'email',
    allowedChannels: ['email']
  },
  {
    type: 'trigger-customer-replied',
    kind: 'trigger',
    label: 'Contacto respondió',
    category: 'trigger-events',
    description: 'Se activa cuando el contacto responde un mensaje',
    icon: MessageCircleReply,
    accent: 'green',
    addButtonLabel: 'Configurar respuesta',
    allowedChannels: [...ALLOWED_CHANNELS, 'any'],
    hiddenFromPicker: true,
    defaultConfig: () => ({ channel: 'any', keywords: [], match: 'contains' }),
    fields: [
      { key: 'channel', label: 'Canal', type: 'select', required: true, options: CHANNEL_OPTIONS_WITH_ANY },
      { key: 'keywords', label: 'Palabras clave (opcional)', type: 'keywords', placeholder: 'Escribe y presiona Enter', advanced: true },
      {
        key: 'match',
        label: 'Coincidencia',
        type: 'select',
        advanced: true,
        options: [
          { value: 'contains', label: 'Contiene' },
          { value: 'exact', label: 'Coincidencia exacta' },
          { value: 'starts_with', label: 'Empieza con' }
        ]
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'respuesta_whatsapp',
      baseLabel: 'Respuesta del contacto',
      fields: WHATSAPP_REPLY_FIELDS,
      fixedTokenRoot: 'respuesta_whatsapp'
    }),
    summary: (config) => {
      const keywords = arr<string>(config.keywords)
      const channel = channelLabel(str(config.channel) || 'any')
      const via = str(config.channel) === 'any' ? '' : ` por ${channel}`
      return {
        text: `Cuando el contacto responda${via}${keywords.length > 0 ? ` con "${keywords.join('" o "')}"` : ''}${triggerFiltersSentence(config.filters)}`
      }
    }
  },
  {
    type: 'trigger-incoming-webhook',
    kind: 'trigger',
    label: 'Datos recibidos de otra app',
    category: 'trigger-events',
    description: 'Se activa cuando otra app manda datos a esta URL',
    icon: Rss,
    accent: 'green',
    requiredFeature: 'developers',
    addButtonLabel: 'Configurar webhook',
    defaultConfig: () => ({ endpointId: '', method: 'POST', sampleStatus: 'none' }),
    fields: [
      { key: 'endpointId', label: 'URL del webhook', type: 'webhookUrl' },
      {
        key: 'method',
        label: 'Método',
        type: 'select',
        options: [
          { value: 'POST', label: 'POST' },
          { value: 'GET', label: 'GET' }
        ]
      },
      {
        key: 'samplePayload',
        label: 'Ejemplo de payload',
        type: 'info',
        text: '{\n  "contacto": {\n    "nombre": "Ana",\n    "telefono": "+52 55 0000 0000",\n    "correo": "ana@ejemplo.com"\n  },\n  "datos": { "origen": "mi-sistema" }\n}'
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    validate: (config) =>
      hasSampleResponse(config.sampleResponse)
        ? []
        : ['Prueba el webhook antes de continuar: todavía no hay datos para mapear'],
    variableOutput: (config) => ({
      baseId: 'webhook',
      baseLabel: 'Webhook',
      sampleResponse: config.sampleResponse,
      requiresSample: true,
      unavailableReason: hasSampleResponse(config.sampleResponse)
        ? undefined
        : 'Sin datos de prueba: prueba el webhook para mapear variables'
    }),
    summary: (config) => ({
      text: str(config.endpointId)
        ? hasSampleResponse(config.sampleResponse)
          ? `Datos recibidos correctamente · ${str(config.method) || 'POST'}${triggerFiltersSentence(config.filters)}`
          : `Sin datos de prueba · ${str(config.method) || 'POST'}${triggerFiltersSentence(config.filters)}`
        : undefined,
      empty: 'Genera la URL del webhook'
    })
  },
  {
    type: 'trigger-appointment-status',
    kind: 'trigger',
    label: 'Estado de la cita',
    category: 'trigger-appointments',
    description: 'Se activa cuando una cita cambia de estado',
    icon: CalendarClock,
    accent: 'green',
    requiredFeature: 'appointments',
    addButtonLabel: 'Configurar cita',
    defaultConfig: () => ({ status: '', calendar: '', calendarName: '' }),
    fields: [
      {
        key: 'status',
        label: 'Cuando la cita esté',
        type: 'select',
        required: true,
        options: [
          { value: 'booked', label: 'Agendada' },
          { value: 'confirmed', label: 'Confirmada' },
          { value: 'cancelled', label: 'Cancelada' },
          { value: 'rescheduled', label: 'Reprogramada' },
          { value: 'completed', label: 'Completada' },
          { value: 'no_show', label: 'No asistió' }
        ]
      },
      { key: 'calendar', label: 'Calendario (opcional)', type: 'catalogSelect', catalog: 'calendars', advanced: true }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'cita',
      baseLabel: 'Cita',
      fields: APPOINTMENT_FIELDS
    }),
    summary: (config) => {
      const statuses: Record<string, string> = {
        booked: 'Agendada',
        confirmed: 'Confirmada',
        cancelled: 'Cancelada',
        rescheduled: 'Reprogramada',
        completed: 'Completada',
        no_show: 'No asistió'
      }
      const calendar = str(config.calendarName) || str(config.calendar)
      const status = str(config.status)
      return {
        text: status
          ? `Cuando una cita sea ${(statuses[status] || status).toLowerCase()}${calendar ? ` en "${calendar}"` : ''}${triggerFiltersSentence(config.filters)}`
          : undefined,
        empty: 'Selecciona el estado de la cita'
      }
    }
  },
  {
    type: 'trigger-contact-updated',
    kind: 'trigger',
    label: 'Contacto modificado',
    category: 'trigger-contacts',
    description: 'Se activa cuando cambie cualquier detalle del contacto en el CRM',
    icon: UserCog,
    accent: 'green',
    addButtonLabel: 'Configurar filtros',
    defaultConfig: () => ({ filters: [] }),
    fields: [],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => {
      const legacyField = str(config.fieldName) || str(config.field)
      return {
        text: legacyField
          ? `Cuando cambie "${legacyField}" del contacto${triggerFiltersSentence(config.filters)}`
          : `Cuando cambie cualquier detalle del contacto${triggerFiltersSentence(config.filters)}`
      }
    }
  },
  {
    type: 'trigger-contact-created',
    kind: 'trigger',
    label: 'Contacto creado',
    category: 'trigger-contacts',
    description: 'Se activa cuando se crea un contacto nuevo',
    icon: UserPlus,
    accent: 'green',
    addButtonLabel: 'Configurar disparador',
    defaultConfig: () => ({ source: '' }),
    fields: [
      { key: 'source', label: 'Fuente (opcional)', type: 'text', placeholder: 'Cualquier fuente', advanced: true }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: `Cuando se cree un contacto nuevo${str(config.source) ? ` desde "${str(config.source)}"` : ''}${triggerFiltersSentence(config.filters)}`
    })
  },
  {
    type: 'trigger-activation-link',
    kind: 'trigger',
    label: 'Clic de disparo',
    category: 'trigger-events',
    description: 'Se activa cuando alguien abre una URL pública de disparo',
    icon: MousePointerClick,
    accent: 'green',
    addButtonLabel: 'Seleccionar clic',
    defaultConfig: () => ({ link: '', linkName: '' }),
    fields: [
      { key: 'link', label: 'Clic de disparo', type: 'catalogSelect', catalog: 'links', required: true }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: (config) => {
      const linkName = triggerLinkLabel(config.linkName)
      return {
        baseId: 'enlace_disparo',
        baseLabel: linkName ? `Clic de disparo - ${linkName}` : 'Clic de disparo',
        fields: TRIGGER_LINK_FIELDS
      }
    },
    summary: (config) => {
      const linkName = triggerLinkLabel(config.linkName)
      const hasSelectedLink = Boolean(linkName || str(config.link))
      return {
        text: hasSelectedLink
          ? `Cuando ocurra el clic de disparo${linkName ? ` "${linkName}"` : ' seleccionado'}${triggerFiltersSentence(config.filters)}`
          : undefined,
        empty: 'Selecciona el clic de disparo'
      }
    }
  },
  {
    type: 'trigger-scheduler',
    kind: 'trigger',
    label: 'Fecha programada',
    category: 'trigger-events',
    description: 'Inicia el flujo una vez o de forma recurrente',
    icon: Clock,
    accent: 'green',
    addButtonLabel: 'Programar fecha',
    defaultConfig: () => ({ scheduleMode: 'once', datetime: '', recurrence: 'none', weekdays: [] }),
    configComponent: 'scheduler',
    fields: [],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'programacion',
      baseLabel: 'Fecha programada',
      fields: SCHEDULE_FIELDS
    }),
    validate: (config) => (str(config.datetime) ? [] : ['Elige la fecha y la hora del disparador programado']),
    summary: (config) => {
      const datetime = str(config.datetime)
      const recurrence = str(config.recurrence) || 'none'
      return {
        text: datetime
          ? `${SCHEDULE_RECURRENCE_LABELS[recurrence] || 'Programado'} · ${formatScheduleDatetime(datetime)}`
          : undefined,
        empty: 'Elige cuándo se dispara'
      }
    }
  },
  {
    type: 'trigger-appointment-booked',
    kind: 'trigger',
    label: 'Contacto agendó una cita',
    category: 'trigger-appointments',
    description: 'Se activa cuando el contacto agenda una cita',
    icon: CalendarCheck,
    accent: 'green',
    requiredFeature: 'appointments',
    addButtonLabel: 'Configurar cita',
    defaultConfig: () => ({ calendar: '', calendarName: '', appointmentType: '', assignedUser: '' }),
    fields: [
      { key: 'calendar', label: 'Calendario (opcional)', type: 'catalogSelect', catalog: 'calendars', advanced: true },
      { key: 'appointmentType', label: 'Tipo de cita (opcional)', type: 'text', placeholder: 'Ej. demo, consulta…', advanced: true },
      { key: 'assignedUser', label: 'Usuario asignado (opcional)', type: 'catalogSelect', catalog: 'users', advanced: true }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'pago',
      baseLabel: 'Pago',
      fields: PAYMENT_FIELDS
    }),
    summary: (config) => {
      const calendar = str(config.calendarName) || str(config.calendar)
      return {
        text: `Cuando el contacto agende una cita${calendar ? ` en "${calendar}"` : ''}${triggerFiltersSentence(config.filters)}`
      }
    }
  },
  {
    type: 'trigger-payment-received',
    kind: 'trigger',
    label: 'Pagos',
    category: 'trigger-events',
    description: 'Se activa por pagos exitosos, errores, reembolsos o pagos incompletos',
    icon: Receipt,
    accent: 'green',
    requiredFeature: 'payments',
    addButtonLabel: 'Configurar pago',
    defaultConfig: () => ({ paymentAction: 'any' }),
    fields: [
      {
        key: 'paymentAction',
        label: 'Qué pasó con el pago',
        type: 'select',
        required: true,
        options: PAYMENT_ACTION_OPTIONS
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'pago',
      baseLabel: 'Pago',
      fields: PAYMENT_FIELDS
    }),
    summary: (config) => {
      const action = str(config.paymentAction) || 'any'
      return {
        text: `Cuando ocurra ${PAYMENT_ACTION_SUMMARIES[action] || 'un evento de pago'}${triggerFiltersSentence(config.filters)}`,
        empty: 'Elige qué acción del pago inicia la automatización'
      }
    }
  },
  {
    type: 'trigger-facebook-comment',
    kind: 'trigger',
    label: 'Comentario en Facebook',
    brand: 'Facebook',
    category: 'trigger-fbig',
    description: 'Se activa con comentarios en tus publicaciones de Facebook',
    icon: Facebook,
    accent: 'blue',
    requiredFeature: 'campaigns',
    addButtonLabel: 'Responder comentario',
    allowedChannels: ['messenger'],
    defaultConfig: () => ({
      post: '',
      allowedComments: 'all'
    }),
    fields: [
      { key: 'post', label: 'Publicación', type: 'postSelect', platform: 'facebook', help: 'Elige una publicación o deja "Todas" para disparar con cualquier comentario.' },
      {
        key: 'allowedComments',
        label: '¿Con qué comentarios dispara?',
        type: 'select',
        help: 'Si una misma persona deja varios comentarios en tu publicación: "Con todos" arranca la automatización cada vez que comenta; "Solo el primero" arranca una sola vez con esa persona e ignora sus comentarios siguientes en ese post.',
        options: [
          { value: 'all', label: 'Con todos los comentarios' },
          { value: 'first_only', label: 'Solo con el primer comentario de cada persona' }
        ]
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'comentario',
      baseLabel: 'Comentario',
      fields: COMMENT_FIELDS,
      fixedTokenRoot: 'comentario'
    }),
    summary: (config) => ({
      text: str(config.post)
        ? `Cuando comenten esa publicación de Facebook${triggerFiltersSentence(config.filters)}`
        : `Cuando comenten cualquier publicación de Facebook${triggerFiltersSentence(config.filters)}`
    })
  },
  {
    type: 'trigger-instagram-comment',
    kind: 'trigger',
    label: 'Comentario en Instagram',
    brand: 'Instagram',
    category: 'trigger-fbig',
    description: 'Se activa con comentarios en tus publicaciones o reels',
    icon: Instagram,
    accent: 'pink',
    requiredFeature: 'campaigns',
    addButtonLabel: 'Responder comentario',
    allowedChannels: ['instagram'],
    defaultConfig: () => ({
      post: '',
      allowedComments: 'all'
    }),
    fields: [
      { key: 'post', label: 'Publicación o reel', type: 'postSelect', platform: 'instagram', help: 'Elige una publicación o reel, o deja "Todas" para disparar con cualquier comentario.' },
      {
        key: 'allowedComments',
        label: '¿Con qué comentarios dispara?',
        type: 'select',
        help: 'Si una misma persona deja varios comentarios en tu publicación: "Con todos" arranca la automatización cada vez que comenta; "Solo el primero" arranca una sola vez con esa persona e ignora sus comentarios siguientes en ese post.',
        options: [
          { value: 'all', label: 'Con todos los comentarios' },
          { value: 'first_only', label: 'Solo con el primer comentario de cada persona' }
        ]
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'comentario',
      baseLabel: 'Comentario',
      fields: COMMENT_FIELDS,
      fixedTokenRoot: 'comentario'
    }),
    summary: (config) => ({
      text: str(config.post)
        ? `Cuando comenten esa publicación de Instagram${triggerFiltersSentence(config.filters)}`
        : `Cuando comenten cualquier publicación de Instagram${triggerFiltersSentence(config.filters)}`
    })
  },
  {
    type: 'trigger-click-to-whatsapp',
    kind: 'trigger',
    label: 'Mensaje desde anuncio de WhatsApp',
    brand: 'WhatsApp',
    category: 'trigger-fbig',
    description: 'Se activa cuando llega un mensaje desde un anuncio de WhatsApp',
    icon: MessageSquareText,
    accent: 'green',
    addButtonLabel: 'Configurar anuncio',
    allowedChannels: ['whatsapp'],
    defaultConfig: () => ({ campaign: '', source: '' }),
    fields: [
      { key: 'campaign', label: 'Campaña o anuncio (opcional)', type: 'catalogSelect', catalog: 'campaigns', advanced: true },
      { key: 'source', label: 'Fuente (opcional)', type: 'text', placeholder: 'Ej. ctwa', advanced: true }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'respuesta_whatsapp',
      baseLabel: 'Respuesta del contacto',
      fields: WHATSAPP_REPLY_FIELDS,
      fixedTokenRoot: 'respuesta_whatsapp'
    }),
    summary: (config) => ({
      text: `Cuando llegue un mensaje desde un anuncio de WhatsApp${triggerFiltersSentence(config.filters)}`
    })
  },
  {
    type: 'trigger-refund',
    kind: 'trigger',
    label: 'Reembolso',
    category: 'trigger-events',
    description: 'Se activa cuando se procesa un reembolso',
    icon: RotateCcw,
    accent: 'green',
    requiredFeature: 'payments',
    addButtonLabel: 'Configurar reembolso',
    hiddenFromPicker: true,
    defaultConfig: () => ({ product: '', amount: '' }),
    fields: [
      { key: 'product', label: 'Producto (opcional)', type: 'catalogSelect', catalog: 'products', advanced: true },
      { key: 'amount', label: 'Monto mínimo (opcional)', type: 'number', placeholder: '0' }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'pago',
      baseLabel: 'Pago',
      fields: PAYMENT_FIELDS
    }),
    summary: (config) => ({
      text: `Cuando se procese un reembolso${triggerFiltersSentence(config.filters)}`
    })
  },
  {
    type: 'trigger-facebook-ad-click',
    kind: 'trigger',
    label: 'Clic en anuncio de Facebook',
    brand: 'Facebook Ads',
    category: 'trigger-fbig',
    description: 'Se activa cuando el contacto llega desde un anuncio',
    icon: Megaphone,
    accent: 'green',
    requiredFeature: 'campaigns',
    addButtonLabel: 'Configurar anuncio',
    defaultConfig: () => ({ campaign: '', adsetId: '', adId: '' }),
    fields: [
      { key: 'campaign', label: 'Campaña (opcional)', type: 'catalogSelect', catalog: 'campaigns', advanced: true },
      { key: 'adsetId', label: 'Conjunto de anuncios (opcional)', type: 'catalogSelect', catalog: 'adsets', advanced: true },
      { key: 'adId', label: 'Anuncio (opcional)', type: 'catalogSelect', catalog: 'adIds', advanced: true }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: `Cuando alguien llegue desde un anuncio de Facebook${str(config.adId) ? ` ("${str(config.adId)}")` : ''}${triggerFiltersSentence(config.filters)}`
    })
  }
]

// ---------------------------------------------------------------------------
// Contenido / Canales (WhatsApp, Messenger, Instagram Direct, Facebook)
// ---------------------------------------------------------------------------

interface ChannelNodeOptions {
  type: string
  label: string
  brand: string
  icon: React.ComponentType<{ size?: number | string; color?: string }>
  accent: NodeAccent
  requiredFeature?: string
  description: string
  addButtonLabel: string
  channel: 'whatsapp' | 'messenger' | 'instagram'
  supportsQuickReplies: boolean
  messageBlockTypes?: MessageBlockType[]
  senderKey?: 'page' | 'account'
  senderLabel?: string
}

/** Fabrica los nodos de mensaje con bloques (Messenger, Instagram, Facebook) */
function channelMessageNode({
  type,
  label,
  brand,
  icon,
  accent,
  description,
  addButtonLabel,
  channel,
  supportsQuickReplies,
  messageBlockTypes,
  senderKey,
  senderLabel
}: ChannelNodeOptions): NodeDefinition {
  return {
    type,
    kind: 'action',
    label,
    brand,
    category: 'action-content',
    description,
    icon,
    accent,
    addButtonLabel,
    allowedChannels: [channel],
    configComponent: 'message',
    supportsMessageBlocks: true,
    ...(messageBlockTypes ? { messageBlockTypes: () => messageBlockTypes } : {}),
    supportsQuickReplies,
    supportsMultipleBranches: true,
    maxBranches: MAX_BRANCHES,
    supportsVariables: true,
    supportsEmoji: true,
    defaultConfig: () => ({
      messageBlocks: [],
      extraBranches: [],
      ...(senderKey ? { [senderKey]: '' } : {})
    }),
    fields: senderKey
      ? [{ key: senderKey, label: senderLabel || 'Remitente (opcional)', type: 'text', placeholder: 'Cuenta conectada por defecto' }]
      : [],
    outputs: (config) => withBranches(SINGLE_OUTPUT, config, { includeMessageButtons: true }),
    validate: validateMessageBlocks,
    summary: (config) => {
      const blocks = asMessageBlocks(config.messageBlocks)
      const textBlocks = blocks.filter((block) => block.type === 'text').length
      return {
        text: textBlocks > 1 ? `${textBlocks} mensajes en secuencia` : undefined,
        box: firstTextBlock(config) || undefined,
        empty: 'Agrega el primer mensaje'
      }
    }
  }
}

const CHANNEL_NODES: NodeDefinition[] = [
	  {
	    type: 'channel-whatsapp',
    kind: 'action',
    label: 'WhatsApp',
    brand: 'WhatsApp',
    category: 'action-content',
    description: 'Envía mensajes de WhatsApp',
    icon: WhatsAppIcon,
    accent: 'teal',
    requiredFeature: 'whatsapp',
    addButtonLabel: 'Agregar mensaje',
    allowedChannels: ['whatsapp'],
    configComponent: 'whatsapp',
    supportsMessageBlocks: true,
    supportsQuickReplies: false,
    supportsMultipleBranches: true,
    maxBranches: MAX_BRANCHES,
    supportsVariables: true,
    supportsEmoji: true,
    defaultConfig: () => ({
      // Por defecto responde por el mismo número donde escribió el contacto
      sender: 'last-channel',
      senderNumberId: '',
      senderNumberLabel: '',
      messageType: 'text',
      sendViaQr: false,
      transport: 'api',
      messageBlocks: [],
      extraBranches: [],
      templateId: '',
      templateName: ''
    }),
    fields: [],
    outputs: (config) => withBranches(SINGLE_OUTPUT, config, { includeMessageButtons: true }),
    variableOutput: () => ({
      baseId: 'enviar_whatsapp',
      baseLabel: 'Enviar WhatsApp',
      fields: WHATSAPP_SEND_FIELDS
    }),
    validate: (config) => {
      const errors: string[] = []
      if (str(config.messageType) === 'template') {
        const blocks = Array.isArray(config.messageBlocks) ? (config.messageBlocks as MessageBlock[]) : []
        const hasTemplateBlock = blocks.some((block) => block.type === 'template' && str(block.templateId))
        if (!str(config.templateId) && !hasTemplateBlock) errors.push('Selecciona al menos una plantilla de WhatsApp')
      } else {
        errors.push(...validateMessageBlocks(config, { strictWhatsAppButtons: true }))
      }
      if (str(config.sender) === 'specific' && !str(config.senderNumberId)) {
        errors.push('Selecciona el número de WhatsApp remitente')
      }
      return errors
    },
    summary: (config) => {
      const senderLabels: Record<string, string> = {
        'last-channel': 'Responde donde te escribió',
        default: 'Número principal',
        specific: str(config.senderNumberLabel) || 'Número elegido'
      }
      const isTemplate = str(config.messageType) === 'template'
      const messageBlocks = asMessageBlocks(config.messageBlocks)
      const blocks = messageBlocks.filter((block) => block.type === 'text').length
      const firstTemplate = messageBlocks.find((block) => block.type === 'template')
      const templateLabel = str(config.templateName) || str(firstTemplate?.templateName) || str(firstTemplate?.templateId)
      const countLabel = !isTemplate && blocks > 1 ? ` · ${blocks} mensajes` : ''
      const methodLabel = isTemplate ? ' · Plantilla · canal activo' : ' · Canal activo'
      return {
        text: `${senderLabels[str(config.sender)] || 'Número principal'}${countLabel}${methodLabel}`,
        box: isTemplate ? templateLabel || undefined : firstTextBlock(config) || undefined,
        empty: 'Configura el mensaje de WhatsApp'
	      }
	    }
	  },
	  {
	    type: 'channel-email',
	    kind: 'action',
	    label: 'Correo',
	    brand: 'Correo',
	    category: 'action-content',
	    description: 'Envía un correo al contacto',
	    icon: Mail,
	    accent: 'purple',
	    requiredFeature: 'email',
	    addButtonLabel: 'Agregar correo',
	    allowedChannels: ['email'],
	    configComponent: 'email',
	    supportsVariables: true,
	    defaultConfig: () => ({
	      toEmail: '{{contact.email}}',
	      subject: '',
	      body: '',
	      bodyHtml: '',
	      includeSignature: true
	    }),
	    fields: [],
	    outputs: () => SINGLE_OUTPUT,
	    variableOutput: () => ({
	      baseId: 'enviar_correo',
	      baseLabel: 'Enviar correo',
	      fields: EMAIL_SEND_FIELDS
	    }),
	    validate: (config) => {
	      const errors: string[] = []
	      if (!str(config.toEmail)) errors.push('Define el correo destino')
	      if (!str(config.subject).trim()) errors.push('Escribe el asunto del correo')
	      if (!str(config.body).trim() && !str(config.bodyHtml).trim()) errors.push('Escribe el mensaje del correo')
	      return errors
	    },
	    summary: (config) => ({
	      text: str(config.toEmail) && str(config.toEmail) !== '{{contact.email}}'
	        ? `Para ${str(config.toEmail)}`
	        : 'Al correo del contacto',
	      box: str(config.subject) || str(config.body) || str(config.bodyHtml).replace(/<[^>]+>/g, ' ').trim() || undefined,
	      empty: 'Configura asunto y mensaje'
	    })
	  },
	  channelMessageNode({
	    type: 'channel-messenger',
    label: 'Messenger',
    brand: 'Messenger',
    icon: MessengerIcon,
    accent: 'blue',
    requiredFeature: 'campaigns',
    description: 'Envía mensajes por Messenger',
    addButtonLabel: 'Agregar mensaje',
    channel: 'messenger',
    supportsQuickReplies: true,
    senderKey: 'page',
    senderLabel: 'Página remitente (opcional)'
  }),
  channelMessageNode({
    type: 'channel-instagram',
    label: 'Instagram Direct',
    brand: 'Instagram',
    icon: InstagramIcon,
    accent: 'pink',
    requiredFeature: 'campaigns',
    description: 'Envía DMs por Instagram',
    addButtonLabel: 'Agregar DM',
    channel: 'instagram',
    supportsQuickReplies: true,
    messageBlockTypes: ['text', 'image', 'video', 'audio', 'voice', 'delay'],
    senderKey: 'account',
    senderLabel: 'Cuenta de Instagram (opcional)'
  }),
  {
    // Responder un comentario a mitad de un flujo. La acción es explícita por
    // plataforma para no mezclar comentarios públicos con private replies.
    type: 'channel-comment-public-reply',
    kind: 'action',
    label: 'Responder comentario',
    brand: 'Facebook / Instagram',
    category: 'action-content',
    description: 'Elige si respondes público en Facebook/Instagram o privado por Messenger/Instagram DM.',
    icon: MessageCircleReply,
    accent: 'green',
    requiredFeature: 'campaigns',
    addButtonLabel: 'Responder comentario',
    allowedChannels: ['messenger', 'instagram'],
    configComponent: 'message',
    supportsMessageBlocks: true,
    supportsQuickReplies: false,
    supportsMessageButtons: false,
    supportsMultipleBranches: false,
    supportsVariables: true,
    supportsEmoji: true,
    messageBlockTypes: getCommentReplyAllowedBlockTypes,
    defaultConfig: () => ({ commentReplyTarget: '', replyType: '', messageBlocks: [] }),
    fields: [
      {
        key: 'commentReplyTarget',
        label: 'Acción de comentario',
        type: 'select',
        required: true,
        help: 'Debe coincidir con el disparador: Facebook usa Facebook público o Messenger; Instagram usa Instagram público o Instagram DM.',
        options: COMMENT_REPLY_TARGET_OPTIONS
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    validate: validateCommentReply,
    summary: (config) => {
      const target = getCommentReplyTargetDefinition(config.commentReplyTarget)
      return {
        text: target?.summary,
        box: firstTextBlock(config) || undefined,
        empty: target?.empty || 'Elige cómo responder'
      }
    }
  },
  {
    type: 'channel-comment-dm-reply',
    kind: 'action',
    label: 'Responder comentario',
    brand: 'Facebook / Instagram',
    category: 'action-content',
    description: 'Mensaje privado al comentarista. Se conserva para automatizaciones antiguas.',
    icon: MessageSquareText,
    accent: 'blue',
    requiredFeature: 'campaigns',
    addButtonLabel: 'Agregar mensaje',
    hiddenFromPicker: true,
    allowedChannels: ['messenger', 'instagram'],
    configComponent: 'message',
    supportsMessageBlocks: true,
    supportsQuickReplies: false,
    supportsMessageButtons: false,
    supportsMultipleBranches: false,
    supportsVariables: true,
    supportsEmoji: true,
    messageBlockTypes: getCommentReplyAllowedBlockTypes,
    defaultConfig: () => ({ commentReplyTarget: '', replyType: 'private', messageBlocks: [] }),
    fields: [],
    outputs: () => SINGLE_OUTPUT,
    validate: validateMessageBlocks,
    summary: (config) => ({ box: firstTextBlock(config) || undefined, empty: 'Agrega el mensaje privado' })
  }
]

// ---------------------------------------------------------------------------
// Acciones de contacto
// ---------------------------------------------------------------------------

const CONTACT_ACTIONS: NodeDefinition[] = [
  {
    type: 'action-create-contact',
    kind: 'action',
    label: 'Crear contacto',
    category: 'action-contacts',
    icon: UserPlus,
    accent: 'blue',
    addButtonLabel: 'Agregar campos',
    defaultConfig: () => ({
      firstName: '',
      lastName: '',
      phone: '',
      email: '',
      source: '',
      tags: [],
      assignedUser: '',
      customFields: []
    }),
    fields: [
      { key: 'firstName', label: 'Nombre', type: 'text', placeholder: '{{contact.first_name}}', showVariables: true },
      { key: 'lastName', label: 'Apellido', type: 'text', placeholder: '{{contact.last_name}}', showVariables: true },
      { key: 'phone', label: 'Teléfono', type: 'text', placeholder: '{{contact.phone}}', required: true, showVariables: true },
      { key: 'email', label: 'Correo (dato de contacto, opcional)', type: 'text', placeholder: '{{contact.email}}', showVariables: true },
      { key: 'source', label: 'Fuente (opcional)', type: 'text', placeholder: '{{automation.name}}', showVariables: true },
      { key: 'tags', label: 'Etiquetas iniciales', type: 'catalogTags', catalog: 'tags' },
      { key: 'assignedUser', label: 'Usuario asignado (opcional)', type: 'catalogSelect', catalog: 'users', advanced: true },
      { key: 'customFields', label: 'Campos personalizados', type: 'customFieldValues' }
    ],
    outputs: () => SINGLE_OUTPUT,
    validate: (config) => arr<Record<string, unknown>>(config.customFields).flatMap((row, index) => {
      const fieldKey = str(row.key)
      const value = str(row.value)
      if (!fieldKey && !value) return []
      if (!fieldKey) return [`Campo personalizado ${index + 1}: elige el campo`]
      if (!value) return [`Campo personalizado ${index + 1}: captura el valor`]
      return []
    }),
    variableOutput: () => ({
      baseId: 'contacto',
      baseLabel: 'Contacto creado',
      fields: CONTACT_OUTPUT_FIELDS
    }),
    summary: (config) => {
      const parts = [str(config.firstName), str(config.phone)].filter(Boolean)
      return {
        text: parts.length > 0 ? `Crea: ${parts.join(' · ')}` : undefined,
        empty: 'Define los datos del contacto'
      }
    }
  },
  {
    type: 'action-find-contact',
    kind: 'action',
    label: 'Encontrar contacto',
    category: 'action-contacts',
    icon: UserSearch,
    accent: 'blue',
    addButtonLabel: 'Configurar búsqueda',
    defaultConfig: () => ({ searchBy: '', lookupValue: '', notFound: 'continue' }),
    fields: [
      {
        key: 'searchBy',
        label: 'Buscar por',
        type: 'select',
        required: true,
        options: [
          { value: 'phone', label: 'Teléfono' },
          { value: 'email', label: 'Correo (dato de contacto)' },
          { value: 'id', label: 'ID del contacto' }
        ]
      },
      {
        key: 'lookupValue',
        label: 'Valor a buscar',
        type: 'text',
        placeholder: '{{contact.phone}}',
        required: true,
        showVariables: true,
        showIf: (config) => Boolean(str(config.searchBy))
      },
      {
        key: 'notFound',
        label: 'Si no existe el contacto',
        type: 'select',
        showIf: (config) => Boolean(str(config.searchBy)) && Boolean(str(config.lookupValue)),
        options: [
          { value: 'continue', label: 'Continuar normalmente' },
          { value: 'create', label: 'Crear el contacto' },
          { value: 'branch', label: 'Continuar por la rama "No encontrado"' },
          { value: 'stop', label: 'Detener la automatización' }
        ]
      }
    ],
    outputs: (config) => {
      const outputs: NodeOutputHandle[] = [{ id: 'out', label: 'Encontrado' }]
      if (str(config.notFound) === 'branch') {
        outputs.push({ id: 'notfound', label: 'No encontrado' })
      }
      return outputs
    },
    variableOutput: () => ({
      baseId: 'contacto',
      baseLabel: 'Contacto encontrado',
      fields: CONTACT_OUTPUT_FIELDS
    }),
    validate: (config) =>
      str(config.searchBy) && !str(config.lookupValue).trim()
        ? ['Indica de dónde sale el dato para buscar el contacto']
        : [],
    summary: (config) => {
      const labels: Record<string, string> = {
        phone: 'teléfono',
        email: 'email',
        id: 'ID'
      }
      const searchBy = str(config.searchBy)
      const value = str(config.lookupValue)
      return {
        text: searchBy ? `Busca por ${labels[searchBy] || 'teléfono'}${value ? `: ${value}` : ''}` : undefined,
        empty: 'Elige cómo encontrar el contacto'
      }
    }
  },
  {
    type: 'action-update-contact-field',
    kind: 'action',
    label: 'Actualizar el campo de contacto',
    category: 'action-contacts',
    icon: PencilLine,
    accent: 'blue',
    addButtonLabel: 'Seleccionar campo',
    defaultConfig: () => ({ field: '', fieldName: '', operation: '', value: '' }),
    fields: [
      { key: 'field', label: 'Campo', type: 'catalogSelect', catalog: 'contactFields', required: true },
      {
        key: 'operation',
        label: 'Qué hacer con ese campo',
        type: 'select',
        required: true,
        showIf: (config) => Boolean(str(config.field)),
        options: [
          { value: 'replace', label: 'Reemplazar valor' },
          { value: 'append', label: 'Agregar al valor actual' },
          { value: 'increment', label: 'Incrementar (numérico)' },
          { value: 'clear', label: 'Limpiar campo' }
        ]
      },
      {
        key: 'value',
        label: 'Valor',
        type: 'text',
        placeholder: 'Nuevo valor…',
        showVariables: true,
        showIf: (config) => Boolean(str(config.field)) && Boolean(str(config.operation)) && str(config.operation) !== 'clear'
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'contacto_actualizado',
      baseLabel: 'Contacto actualizado',
      fields: CONTACT_UPDATED_FIELDS
    }),
    validate: (config) =>
      str(config.operation) !== 'clear' && !str(config.value).trim() && str(config.field)
        ? ['Captura el valor para el campo']
        : [],
    summary: (config) => {
      const field = str(config.fieldName) || str(config.field)
      const operations: Record<string, string> = {
        replace: '→',
        append: '+=',
        increment: '+',
        clear: '(limpiar)'
      }
      return {
        text: field
          ? `${field} ${operations[str(config.operation)] || '→'} ${str(config.operation) === 'clear' ? '' : str(config.value) || '(vacío)'}`
          : undefined,
        empty: 'Elige el campo a actualizar'
      }
    }
  },
  {
    type: 'action-change-whatsapp-number',
    kind: 'action',
    label: 'Cambiar número de WhatsApp',
    category: 'action-contacts',
    icon: Shuffle,
    accent: 'blue',
    addButtonLabel: 'Seleccionar número',
    defaultConfig: () => ({ phoneNumberId: '', phoneNumberIdName: '', reason: '' }),
    fields: [
      {
        key: 'phoneNumberId',
        label: 'Nuevo número de WhatsApp',
        type: 'catalogSelect',
        catalog: 'whatsappNumbers',
        required: true
      },
      {
        key: 'reason',
        label: 'Motivo interno (opcional)',
        type: 'text',
        placeholder: 'Cambio desde automatización',
        showVariables: true,
        advanced: true
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'contacto_actualizado',
      baseLabel: 'Contacto actualizado',
      fields: CONTACT_UPDATED_FIELDS
    }),
    validate: (config) => !str(config.phoneNumberId) ? ['Selecciona el número de WhatsApp'] : [],
    summary: (config) => {
      const name = str(config.phoneNumberIdName) || str(config.phoneNumberId)
      return {
        text: name ? `Cambiar WhatsApp del contacto a ${name}` : undefined,
        empty: 'Selecciona el número de WhatsApp'
      }
    }
  },
  {
    type: 'action-contact-tag',
    kind: 'action',
    label: 'Añadir / eliminar etiqueta',
    category: 'action-contacts',
    icon: Tags,
    accent: 'blue',
    addButtonLabel: 'Configurar etiqueta',
    defaultConfig: () => ({ tagAction: '', tag: '' }),
    fields: [
      {
        key: 'tagAction',
        label: 'Qué quieres hacer',
        type: 'select',
        required: true,
        options: [
          { value: 'add', label: 'Añadir etiqueta' },
          { value: 'remove', label: 'Eliminar etiqueta' }
        ]
      },
      {
        key: 'tag',
        label: 'Etiqueta',
        type: 'catalogSelect',
        catalog: 'tags',
        required: true,
        showIf: (config) => Boolean(str(config.tagAction))
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => {
      const name = tagDisplayName(config)
      const action = str(config.tagAction) === 'remove' ? 'Eliminar' : 'Añadir'
      return {
        text: name && str(config.tagAction) ? `${action} etiqueta: ${name}` : undefined,
        empty: 'Elige si vas a añadir o eliminar una etiqueta'
      }
    }
  },
  {
    type: 'action-add-contact-tag',
    kind: 'action',
    label: 'Añadir etiqueta de contacto',
    category: 'action-contacts',
    icon: Tags,
    accent: 'blue',
    hiddenFromPicker: true,
    addButtonLabel: 'Seleccionar etiqueta',
    defaultConfig: () => ({ tag: '' }),
    fields: [
      { key: 'tag', label: 'Etiqueta', type: 'catalogSelect', catalog: 'tags', required: true }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => {
      const name = tagDisplayName(config)
      return {
        text: name ? `Añadir la etiqueta "${name}" al contacto` : undefined,
        empty: 'Selecciona la etiqueta'
      }
    }
  },
  {
    type: 'action-remove-contact-tag',
    kind: 'action',
    label: 'Eliminar la etiqueta de contacto',
    category: 'action-contacts',
    icon: Tags,
    accent: 'blue',
    hiddenFromPicker: true,
    addButtonLabel: 'Seleccionar etiqueta',
    defaultConfig: () => ({ tag: '' }),
    fields: [
      { key: 'tag', label: 'Etiqueta', type: 'catalogSelect', catalog: 'tags', required: true }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => {
      const name = tagDisplayName(config)
      return {
        text: name ? `Quitar la etiqueta "${name}" del contacto` : undefined,
        empty: 'Selecciona la etiqueta'
      }
    }
  },
  {
    type: 'action-contact-user',
    kind: 'action',
    label: 'Añadir / eliminar usuario asignado',
    category: 'action-contacts',
    icon: UserCheck,
    accent: 'blue',
    addButtonLabel: 'Configurar usuario',
    defaultConfig: () => ({ userAction: '', user: '' }),
    fields: [
      {
        key: 'userAction',
        label: 'Qué quieres hacer',
        type: 'select',
        required: true,
        options: [
          { value: 'assign', label: 'Añadir usuario asignado' },
          { value: 'unassign', label: 'Eliminar usuario asignado' }
        ]
      },
      {
        key: 'user',
        label: 'Usuario',
        type: 'catalogSelect',
        catalog: 'users',
        required: true,
        showIf: (config) => str(config.userAction) === 'assign'
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => {
      if (str(config.userAction) === 'unassign') return { text: 'Eliminar usuario asignado del contacto' }
      const user = str(config.userName) || str(config.user)
      return {
        text: user && str(config.userAction) ? `Asignar a ${user}` : undefined,
        empty: 'Elige si vas a añadir o eliminar un usuario'
      }
    }
  },
  {
    type: 'action-assign-user',
    kind: 'action',
    label: 'Asignar al usuario',
    category: 'action-contacts',
    icon: UserCheck,
    accent: 'blue',
    hiddenFromPicker: true,
    addButtonLabel: 'Seleccionar usuario',
    defaultConfig: () => ({ strategy: 'specific', user: '' }),
    fields: [
      {
        key: 'strategy',
        label: 'Estrategia',
        type: 'select',
        options: [
          { value: 'specific', label: 'Usuario específico' },
          { value: 'round_robin', label: 'Repartir en orden (round robin)' },
          { value: 'current_owner', label: 'Mantener dueño actual' }
        ]
      },
      {
        key: 'user',
        label: 'Usuario',
        type: 'catalogSelect',
        catalog: 'users',
        showIf: (config) => str(config.strategy) === 'specific'
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    validate: (config) =>
      str(config.strategy) === 'specific' && !str(config.user) ? ['Selecciona el usuario'] : [],
    summary: (config) => {
      if (str(config.strategy) === 'round_robin') return { text: 'Reparte contactos en orden' }
      if (str(config.strategy) === 'current_owner') return { text: 'Mantiene el dueño actual' }
      return {
        text: str(config.user) ? `Asigna a ${str(config.user)}` : undefined,
        empty: 'Selecciona el usuario'
      }
    }
  },
  {
    type: 'action-unassign-user',
    kind: 'action',
    label: 'Eliminar usuario asignado',
    category: 'action-contacts',
    icon: UserMinus,
    accent: 'blue',
    hiddenFromPicker: true,
    addButtonLabel: 'Configurar acción',
    defaultConfig: () => ({ leaveUnowned: true }),
    fields: [
      { key: 'leaveUnowned', label: 'Dejar el contacto sin propietario', type: 'toggle' },
      {
        key: 'note',
        label: 'Nota',
        type: 'info',
        text: 'Al ejecutarse, el contacto deja de tener usuario asignado.'
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: () => ({ text: 'Quita el usuario asignado del contacto' })
  },
  {
    type: 'action-delete-contact',
    kind: 'action',
    label: 'Eliminar contacto',
    category: 'action-contacts',
    icon: UserX,
    accent: 'blue',
    addButtonLabel: 'Configurar acción',
    defaultConfig: () => ({ mode: 'archive', confirmed: false }),
    fields: [
      {
        key: 'mode',
        label: 'Acción',
        type: 'select',
        options: [
          { value: 'archive', label: 'Archivar contacto (recomendado)' },
          { value: 'delete', label: 'Eliminar definitivamente' }
        ]
      },
      { key: 'confirmed', label: 'Entiendo que esta acción afecta al contacto', type: 'toggle', required: true },
      {
        key: 'warning',
        label: 'Atención',
        type: 'info',
        text: 'Eliminar definitivamente borra el contacto y su historial cuando la automatización se ejecuta. Esta acción no se puede deshacer.'
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    validate: (config) => (config.confirmed ? [] : ['Confirma que entiendes el efecto de esta acción']),
    summary: (config) => ({
      text: str(config.mode) === 'delete' ? 'Elimina el contacto definitivamente' : 'Archiva el contacto'
    })
  }
]

// ---------------------------------------------------------------------------
// Datos / Lógica / IA / Extras
// ---------------------------------------------------------------------------

const OTHER_ACTIONS: NodeDefinition[] = [
  {
    type: 'action-system-notification',
    kind: 'action',
    label: 'Notificaciones',
    category: 'action-logic',
    description: 'Manda avisos por campanita, push móvil o correo interno',
    icon: BellRing,
    accent: 'orange',
    tintedHeader: true,
    addButtonLabel: 'Configurar notificación',
    supportsVariables: true,
    defaultConfig: () => ({
      recipientMode: 'all',
      user: '',
      deliverToBell: true,
      deliverToPush: true,
      deliverToEmail: false,
      contactId: '',
      pushTitle: '',
      pushBody: '',
      clickAction: 'phone_chat',
      customUrl: ''
    }),
    fields: [
      {
        key: 'recipientMode',
        label: 'Quién recibe la notificación',
        type: 'select',
        required: true,
        options: [
          { value: 'all', label: 'Todos los usuarios' },
          { value: 'assigned_user', label: 'Usuario asignado del contacto' },
          { value: 'specific_user', label: 'Usuario específico' }
        ]
      },
      {
        key: 'user',
        label: 'Usuario',
        type: 'catalogSelect',
        catalog: 'users',
        required: true,
        showIf: (config) => str(config.recipientMode) === 'specific_user'
      },
      {
        key: 'deliverToBell',
        label: 'Mostrar en la campanita del CRM',
        type: 'toggle'
      },
      {
        key: 'deliverToPush',
        label: 'Enviar push a la aplicación móvil',
        type: 'toggle'
      },
      {
        key: 'deliverToEmail',
        label: 'Enviar correo interno al usuario',
        type: 'toggle'
      },
      {
        key: 'pushTitle',
        label: 'Título',
        type: 'text',
        placeholder: 'Nuevo aviso de Ristak',
        required: true,
        showVariables: true
      },
      {
        key: 'pushBody',
        label: 'Mensaje',
        type: 'textarea',
        placeholder: 'Describe qué necesita revisar la persona…',
        required: true,
        showVariables: true
      },
      {
        key: 'clickAction',
        label: 'Al tocar la notificación',
        type: 'select',
        options: [
          { value: 'phone_chat', label: 'Abrir chat en el celular' },
          { value: 'phone_contacts', label: 'Abrir contactos en el celular' },
          { value: 'desktop_contacts', label: 'Abrir contacto en escritorio' },
          { value: 'desktop_chat', label: 'Abrir chat en escritorio' },
          { value: 'custom_url', label: 'Abrir ruta interna personalizada' }
        ]
      },
      {
        key: 'contactId',
        label: 'Contacto de referencia (opcional)',
        type: 'text',
        placeholder: '{{contact.id}}',
        showVariables: true,
        advanced: true
      },
      {
        key: 'customUrl',
        label: 'Ruta interna',
        type: 'text',
        placeholder: '/movil',
        showVariables: true,
        showIf: (config) => str(config.clickAction) === 'custom_url'
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    validate: (config) => {
      const errors: string[] = []
      if (str(config.recipientMode) === 'specific_user' && !str(config.user)) {
        errors.push('Selecciona el usuario que recibirá la notificación')
      }
      const hasModernDeliveryConfig = ['deliverToBell', 'deliverToPush', 'deliverToEmail']
        .some((key) => Object.prototype.hasOwnProperty.call(config, key))
      const deliverToBell = hasModernDeliveryConfig ? Boolean(config.deliverToBell) : true
      const deliverToPush = hasModernDeliveryConfig ? Boolean(config.deliverToPush) : true
      const deliverToEmail = hasModernDeliveryConfig ? Boolean(config.deliverToEmail) : false
      if (!deliverToBell && !deliverToPush && !deliverToEmail) {
        errors.push('Selecciona al menos un canal de entrega')
      }
      if (str(config.clickAction) === 'custom_url' && !str(config.customUrl).trim()) {
        errors.push('Captura la ruta interna que se abrirá al tocar la notificación')
      }
      return errors
    },
    summary: (config) => {
      const recipients: Record<string, string> = {
        all: 'Todos',
        assigned_user: 'Usuario asignado',
        specific_user: str(config.userName) || 'Usuario específico'
      }
      const actions: Record<string, string> = {
        phone_chat: 'abre chat del celular',
        phone_contacts: 'abre contactos del celular',
        desktop_contacts: 'abre contacto en escritorio',
        desktop_chat: 'abre chat en escritorio',
        custom_url: str(config.customUrl) || 'ruta interna'
      }
      const hasModernDeliveryConfig = ['deliverToBell', 'deliverToPush', 'deliverToEmail']
        .some((key) => Object.prototype.hasOwnProperty.call(config, key))
      const channelLabels = [
        (hasModernDeliveryConfig ? Boolean(config.deliverToBell) : true) ? 'campanita' : '',
        (hasModernDeliveryConfig ? Boolean(config.deliverToPush) : true) ? 'push' : '',
        (hasModernDeliveryConfig ? Boolean(config.deliverToEmail) : false) ? 'correo' : ''
      ].filter(Boolean)
      return {
        text: `${recipients[str(config.recipientMode)] || 'Todos'} · ${channelLabels.join(' + ') || 'sin canal'} · ${actions[str(config.clickAction)] || 'abre chat del celular'}`,
        box: str(config.pushTitle) || str(config.pushBody) || undefined,
        empty: 'Configura destinatario, título y cuerpo'
      }
    }
  },
  {
    type: 'action-webhook',
    kind: 'action',
    label: 'Webhook',
    category: 'action-data',
    description: 'Envía datos a un sistema externo',
    icon: Webhook,
    accent: 'teal',
    requiredFeature: 'developers',
    addButtonLabel: 'Configurar webhook',
    defaultConfig: () => ({
      url: '',
      method: 'POST',
      headersMode: 'fields',
      headers: [],
      headersJson: '',
      bodyMode: 'fields',
      bodyFields: [],
      body: '',
      timeout: 15,
      onError: 'continue',
      sampleResponseJson: ''
    }),
    fields: [
      { key: 'url', label: 'URL', type: 'text', placeholder: 'https://…', required: true },
      {
        key: 'method',
        label: 'Método',
        type: 'select',
        options: [
          { value: 'POST', label: 'POST' },
          { value: 'GET', label: 'GET' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' },
          { value: 'DELETE', label: 'DELETE' }
        ]
      },
      {
        key: 'headersMode',
        label: 'Headers',
        type: 'select',
        options: [
          { value: 'fields', label: 'Campos' },
          { value: 'json', label: 'JSON' }
        ],
        help: 'Usa campos si no quieres escribir JSON. Cambia a JSON solo si el API lo pide.'
      },
      {
        key: 'headers',
        label: 'Headers',
        type: 'keyValue',
        help: 'Van antes del body. Ejemplo: Authorization, Content-Type o X-API-Key.',
        showIf: (config) => webhookHeadersMode(config) === 'fields'
      },
      {
        key: 'headersJson',
        label: 'Headers (JSON)',
        type: 'textarea',
        placeholder: '{\n  "Authorization": "Bearer {{token}}"\n}',
        showVariables: true,
        showIf: (config) => webhookHeadersMode(config) === 'json'
      },
      {
        key: 'bodyMode',
        label: 'Body',
        type: 'select',
        options: [
          { value: 'fields', label: 'Campos' },
          { value: 'json', label: 'JSON' }
        ],
        help: 'Usa campos si no quieres escribir JSON. Usa JSON cuando el API necesite una estructura avanzada.'
      },
      {
        key: 'bodyFields',
        label: 'Campos del body',
        type: 'keyValue',
        help: 'Cada fila se enviará como una propiedad del JSON.',
        showIf: (config) => webhookBodyMode(config) === 'fields'
      },
      {
        key: 'body',
        label: 'Body (JSON)',
        type: 'textarea',
        placeholder: '{\n  "telefono": "{{telefono}}"\n}',
        showVariables: true,
        showIf: (config) => webhookBodyMode(config) === 'json'
      },
      {
        key: 'sampleResponseJson',
        label: 'Muestra de respuesta (opcional)',
        type: 'textarea',
        placeholder: '{\n  "status": "success",\n  "lead_id": "abc123"\n}',
        help: 'Pega una respuesta real para que sus campos aparezcan como variables.',
        advanced: true
      },
      { key: 'timeout', label: 'Timeout (segundos)', type: 'number', placeholder: '15', advanced: true },
      {
        key: 'onError',
        label: 'Si el webhook falla',
        type: 'select',
        options: [
          { value: 'continue', label: 'Continuar normalmente' },
          { value: 'stop', label: 'Detener la automatización' },
          { value: 'branch', label: 'Continuar por la rama "Error"' }
        ]
      }
    ],
    validate: (config) => {
      const rawHeadersJson = str(config.headersJson).trim()
      if (webhookHeadersMode(config) === 'json' && rawHeadersJson && !isSimpleJsonObject(rawHeadersJson)) {
        return ['Los headers JSON deben ser un objeto simple.']
      }
      return []
    },
    outputs: (config) => {
      const outputs: NodeOutputHandle[] = [{ id: 'out', label: 'Siguiente paso' }]
      if (str(config.onError) === 'branch') outputs.push({ id: 'error', label: 'Error' })
      return outputs
    },
    variableOutput: httpResponseOutput,
    summary: (config) => ({
      text: str(config.url) ? `${str(config.method) || 'POST'} ${str(config.url)}` : undefined,
      empty: 'Configura la URL del webhook'
    })
  },
  {
    type: 'logic-condition',
    kind: 'action',
    label: 'Condición',
    category: 'action-logic',
    description: 'Divide el flujo con grupos de reglas del CRM',
    icon: Filter,
    accent: 'purple',
    tintedHeader: true,
    addButtonLabel: 'Agregar regla',
    configComponent: 'conditions',
    supportsVariables: true,
    maxBranches: MAX_BRANCHES,
    defaultConfig: () => ({ ...emptyAdvancedCondition() }),
    fields: [],
    outputs: (config) => {
      const branches = Array.isArray(config.branches)
        ? (config.branches as Array<{ id?: unknown; name?: unknown }>)
        : []
      if (branches.length <= 1) {
        return [
          { id: 'yes', label: 'Sí' },
          { id: 'no', label: 'No' }
        ]
      }
      // Multi-rama: una salida por rama + "Ninguna" cuando nada coincide
      return [
        ...branches.slice(0, MAX_BRANCHES - 1).map((branch, index) => ({
          id: str(branch.id) || `branch-${index + 1}`,
          label: str(branch.name) || `Rama ${index + 1}`
        })),
        { id: 'none', label: 'Ninguna' }
      ]
    },
    validate: (config) => validateAdvancedCondition(config),
    summary: (config) => ({
      text: summarizeAdvancedCondition(config) || undefined,
      empty: 'Define las reglas de la condición'
    })
  },
  {
    type: 'logic-wait',
    kind: 'action',
    label: 'Esperar',
    category: 'action-logic',
    description: 'Mantiene al contacto hasta que pase el tiempo, responda o se cumpla una condición',
    icon: Hourglass,
    accent: 'coral',
    tintedHeader: true,
    addButtonLabel: 'Configurar espera',
    configComponent: 'wait',
    allowedChannels: [...ALLOWED_CHANNELS, 'any'],
    defaultConfig: () => ({
      name: 'Esperar',
      mode: '',
      // periodo establecido
      amount: 1,
      unit: 'days',
      // fecha específica (la zona horaria viene de la configuración del flujo)
      untilDate: '',
      // cita
      calendar: '',
      calendarName: '',
      appointmentStatus: '',
      appointmentOffset: 'before',
      offsetAmount: 1,
      offsetUnit: 'hours',
      // respuesta
      replyChannel: 'any',
      replySourceNodeId: '',
      replySourceName: '',
      keywords: [],
      match: 'contains',
      // acción
      expectedAction: 'click_link',
      actionResource: '',
      actionResourceName: '',
      actionChannel: 'any',
      // condiciones
      conditions: emptyAdvancedCondition(),
      evaluation: 'continuous',
      // timeout compartido (respuesta/acción/condiciones)
      timeoutEnabled: false,
      timeoutAmount: 2,
      timeoutUnit: 'days',
      // ventana horaria (usa la zona horaria global del flujo)
      windowEnabled: false,
      windowDays: [],
      windowStart: '09:00',
      windowEnd: '18:00',
      outsideWindow: 'next-window'
    }),
    fields: [],
    outputs: (config) => {
      const mode = str(config.mode)
      const timeout = Boolean(config.timeoutEnabled)
      if (mode === 'reply') {
        return timeout
          ? [
              { id: 'out', label: 'Respondió' },
              { id: 'timeout', label: 'No respondió' }
            ]
          : [{ id: 'out', label: 'Respondió' }]
      }
      if (mode === 'action') {
        return timeout
          ? [
              { id: 'out', label: 'Realizó la acción' },
              { id: 'timeout', label: 'No realizó la acción' }
            ]
          : [{ id: 'out', label: 'Realizó la acción' }]
      }
      if (mode === 'conditions') {
        return timeout
          ? [
              { id: 'out', label: 'Condición cumplida' },
              { id: 'timeout', label: 'No se cumplió' }
            ]
          : [{ id: 'out', label: 'Condición cumplida' }]
      }
      return SINGLE_OUTPUT
    },
    validate: (config) => {
      const errors: string[] = []
      const mode = str(config.mode)
      if (!mode) return ['Selecciona el tipo de espera']
      const allowedModes = new Set(['duration', 'datetime', 'appointment', 'reply', 'action', 'conditions'])
      if (!allowedModes.has(mode)) return ['Selecciona un tipo de espera disponible']

      if (mode === 'duration' && (Number(config.amount) || 0) <= 0) {
        errors.push('La duración debe ser mayor a cero')
      }
      if (mode === 'datetime' && !str(config.untilDate)) {
        errors.push('Selecciona la fecha y hora de espera')
      }
      if (mode === 'appointment') {
        if ((Number(config.offsetAmount) || 0) <= 0 && str(config.appointmentOffset) !== 'at') {
          errors.push('Define cuánto tiempo antes o después de la cita')
        }
      }
      if (mode === 'reply') {
        const channel = str(config.replyChannel)
        if (!['any', ...ALLOWED_CHANNELS].includes(channel)) {
          errors.push('Canal de respuesta inválido: usa WhatsApp, Messenger o Instagram Direct')
        }
      }
      if (mode === 'action' && !str(config.expectedAction)) {
        errors.push('Selecciona la acción esperada')
      }
      if (mode === 'action' && (str(config.expectedAction) || 'click_link') === 'click_link' && !str(config.actionResource)) {
        errors.push('Selecciona el clic de disparo')
      }
      if (mode === 'action' && str(config.expectedAction) === 'reply_message' && !str(config.actionResource)) {
        errors.push('Selecciona el mensaje enviado que debe responder el contacto')
      }
      if (mode === 'conditions') {
        errors.push(...validateAdvancedCondition(config.conditions).map((error) => `Condición: ${error}`))
      }
      if (config.timeoutEnabled && (Number(config.timeoutAmount) || 0) <= 0) {
        errors.push('El tiempo máximo de espera debe ser mayor a cero')
      }
      if (config.windowEnabled) {
        if (!str(config.windowStart) || !str(config.windowEnd)) {
          errors.push('Define el horario de la ventana de continuación')
        }
        if (arr(config.windowDays).length === 0) {
          errors.push('Selecciona los días permitidos de la ventana')
        }
      }
      return errors
    },
    summary: (config) => {
      const mode = str(config.mode)
      if (mode && !['duration', 'datetime', 'appointment', 'reply', 'action', 'conditions'].includes(mode)) {
        return { empty: 'Selecciona un tipo de espera disponible' }
      }
      const timeoutText = config.timeoutEnabled
        ? ` hasta ${durationLabel(Number(config.timeoutAmount) || 0, str(config.timeoutUnit) || 'days')}`
        : ''
      if (mode === 'duration') {
        return { text: `Esperar ${durationLabel(Number(config.amount) || 0, str(config.unit) || 'hours')}` }
      }
      if (mode === 'datetime') {
        const until = str(config.untilDate)
        return { text: until ? `Esperar hasta el ${until.replace('T', ' a las ')}` : undefined, empty: 'Configura la espera' }
      }
      if (mode === 'appointment') {
        const offsets: Record<string, string> = { before: 'antes de', after: 'después de', at: 'al inicio de' }
        const offset = str(config.appointmentOffset) || 'before'
        const amount = offset === 'at' ? '' : `${durationLabel(Number(config.offsetAmount) || 0, str(config.offsetUnit) || 'hours')} `
        return { text: `Esperar hasta ${amount}${offsets[offset]} la cita` }
      }
      if (mode === 'reply') {
        const channel = str(config.replyChannel) === 'any' ? '' : ` por ${channelLabel(str(config.replyChannel))}`
        const sourceName = triggerLinkLabel(config.replySourceName)
        return {
          text: sourceName
            ? `Esperar respuesta a "${sourceName}"${channel}${timeoutText}`
            : `Esperar la respuesta del contacto${channel}${timeoutText}`
        }
      }
      if (mode === 'action') {
        const actions: Record<string, string> = {
          click_link: 'reciba un clic de disparo',
          submit_form: 'envíe un formulario',
          purchase: 'realice un pago',
          book_appointment: 'agende una cita',
          reply_message: 'responda un mensaje',
          custom_event: 'dispare un evento personalizado'
        }
        const expectedAction = str(config.expectedAction)
        const actionResourceName = triggerLinkLabel(config.actionResourceName)
        const hasActionResource = Boolean(actionResourceName || str(config.actionResource))
        const actionText =
          expectedAction === 'click_link'
            ? `reciba ${actionResourceName ? `el clic de disparo "${actionResourceName}"` : hasActionResource ? 'el clic de disparo seleccionado' : 'un clic de disparo'}`
            : expectedAction === 'reply_message'
              ? `responda ${actionResourceName ? `el mensaje "${actionResourceName}"` : hasActionResource ? 'el mensaje seleccionado' : 'un mensaje enviado'}`
              : actions[expectedAction] || 'realice una acción'
        return { text: `Esperar a que ${actionText}${timeoutText}` }
      }
      if (mode === 'conditions') {
        const summary = summarizeAdvancedCondition(config.conditions)
        return { text: `Esperar hasta que ${summary || 'se cumpla una condición'}${timeoutText}` }
      }
      return { empty: 'Selecciona el tipo de espera' }
    }
  },
  {
    type: 'logic-drip',
    kind: 'action',
    label: 'Goteo',
    category: 'action-logic',
    description: 'Pasa contactos al siguiente paso por lotes, a intervalos regulares',
    icon: Droplet,
    accent: 'purple',
    tintedHeader: true,
    addButtonLabel: 'Configurar goteo',
    configComponent: 'drip',
    defaultConfig: () => ({
      batchSize: 100,
      intervalAmount: 1,
      intervalUnit: 'minutes'
    }),
    fields: [],
    outputs: () => SINGLE_OUTPUT,
    validate: (config) => {
      const errors: string[] = []
      const batchSize = Math.floor(Number(config.batchSize) || 0)
      const intervalAmount = Number(config.intervalAmount) || 0
      const intervalUnit = str(config.intervalUnit) || 'minutes'
      if (batchSize <= 0) errors.push('El tamaño del lote debe ser mayor a cero')
      if (intervalAmount <= 0) errors.push('El intervalo de goteo debe ser mayor a cero')
      if (!DRIP_INTERVAL_UNITS.has(intervalUnit)) errors.push('El intervalo debe estar en minutos, horas o días')
      return errors
    },
    summary: (config) => {
      const batchSize = Math.floor(Number(config.batchSize) || 0)
      const intervalAmount = Number(config.intervalAmount) || 0
      const intervalUnit = str(config.intervalUnit) || 'minutes'
      if (batchSize <= 0 || intervalAmount <= 0 || !DRIP_INTERVAL_UNITS.has(intervalUnit)) {
        return { empty: 'Configura el tamaño del lote y el intervalo' }
      }
      return {
        text: `Pasan ${batchSize} contacto${batchSize === 1 ? '' : 's'} por lote cada ${durationLabel(intervalAmount, intervalUnit)}`
      }
    }
  },
  {
    type: 'logic-goal',
    kind: 'action',
    label: 'Evento objetivo',
    category: 'action-logic',
    description: 'Meta que completa o saca al contacto de la automatización',
    icon: Target,
    accent: 'purple',
    tintedHeader: true,
    addButtonLabel: 'Agregar evento objetivo',
    configComponent: 'goal',
    allowedChannels: [...ALLOWED_CHANNELS],
    defaultConfig: () => ({
      name: '',
      goalType: '',
      // etiqueta
      tagOperator: 'has',
      tag: '',
      // pago
      paymentEvent: 'received',
      amountOperator: 'any',
      amount: '',
      currency: '',
      product: '',
      provider: '',
      // cita
      appointmentStatus: 'booked',
      calendar: '',
      calendarName: '',
      appointmentType: '',
      // formulario
      form: '',
      formName: '',
      formFieldKey: '',
      formFieldValue: '',
      // link
      linkEvent: 'clicked',
      link: '',
      linkName: '',
      // conversación
      conversationEvent: 'replied',
      conversationChannel: 'any',
      keyword: '',
      // contacto
      contactEvent: 'created',
      contactField: '',
      contactFieldValue: '',
      // ads
      adsEvent: 'fb_click',
      campaign: '',
      // evento personalizado
      customEventName: '',
      payloadContains: '',
      // condición avanzada (grupos Y/O combinables)
      advancedCondition: emptyAdvancedCondition(),
      // evaluación y comportamiento
      evaluate: 'during-automation',
      onMet: 'end-automation',
      onNotMet: 'continue',
      windowMode: 'none',
      windowAmount: 7,
      windowUnit: 'days',
      windowUntil: ''
    }),
    fields: [],
    outputs: (config) => {
      const outputs: NodeOutputHandle[] = []
      if (str(config.onMet) === 'continue') {
        outputs.push({ id: 'out', label: 'Objetivo cumplido' })
      }
      if (str(config.onNotMet) === 'timeout-branch') {
        outputs.push({ id: 'notmet', label: 'No cumplido' })
      }
      return outputs
    },
    validate: (config) => {
      const errors: string[] = []
      const goalType = str(config.goalType)
      if (!goalType) {
        errors.push('Selecciona el tipo de objetivo')
        return errors
      }
      if (goalType === 'tag' && !str(config.tag)) errors.push('Selecciona la etiqueta del objetivo')
      if (goalType === 'payment') {
        if (str(config.amountOperator) !== 'any' && !String(config.amount ?? '').trim()) {
          errors.push('Captura el monto del pago')
        }
      }
      if (goalType === 'form' && !str(config.form) && !str(config.formName)) {
        errors.push('Selecciona el formulario del objetivo')
      }
      if (goalType === 'conversation') {
        const channel = str(config.conversationChannel)
        if (!['any', ...ALLOWED_CHANNELS].includes(channel)) {
          errors.push('Canal inválido: usa WhatsApp, Messenger o Instagram Direct')
        }
      }
      if (goalType === 'custom' && !str(config.customEventName).trim()) {
        errors.push('Indica el nombre del evento personalizado')
      }
      if (goalType === 'advanced') {
        errors.push(...validateAdvancedCondition(config.advancedCondition).map((error) => `Condición: ${error}`))
      }
      if (str(config.windowMode) === 'duration' && (Number(config.windowAmount) || 0) <= 0) {
        errors.push('La ventana de tiempo debe ser mayor a cero')
      }
      if (str(config.windowMode) === 'until' && !str(config.windowUntil)) {
        errors.push('Selecciona la fecha límite del objetivo')
      }
      return errors
    },
    summary: (config) => {
      const goalType = str(config.goalType)
      const summaries: Record<string, () => string> = {
        tag: () => {
          const operators: Record<string, string> = {
            has: 'Tiene etiqueta',
            received: 'Recibe etiqueta',
            lost: 'Pierde etiqueta',
            not_has: 'No tiene etiqueta'
          }
          return `${operators[str(config.tagOperator)] || 'Tiene etiqueta'} ${tagDisplayName(config)}`
        },
        payment: () => (str(config.paymentEvent) === 'refund' ? 'Reembolso procesado' : str(config.paymentEvent) === 'failed' ? 'Pago fallido' : 'Pago recibido'),
        appointment: () => {
          const statuses: Record<string, string> = {
            booked: 'Cita agendada',
            confirmed: 'Cita confirmada',
            cancelled: 'Cita cancelada',
            rescheduled: 'Cita reprogramada',
            completed: 'Cita completada',
            no_show: 'Cita no asistida'
          }
          const calendar = str(config.calendarName) || str(config.calendar)
          return `${statuses[str(config.appointmentStatus)] || 'Cita agendada'}${calendar ? ` en ${calendar}` : ''}`
        },
        form: () => `Formulario ${str(config.formName) || str(config.form) || ''} enviado`,
        link: () => {
          const linkName = triggerLinkLabel(config.linkName)
          if (linkName) return `Clic de disparo "${linkName}"`
          return str(config.link) ? 'Clic de disparo seleccionado' : 'Clic de disparo'
        },
        conversation: () => `Respondió por ${channelLabel(str(config.conversationChannel) || 'any')}`,
        contact: () => 'Cambio en el contacto',
        ads: () => (str(config.adsEvent) === 'ctwa' ? 'Mensaje desde anuncio de WhatsApp' : 'Clic en anuncio de Facebook'),
        custom: () => `Evento "${str(config.customEventName)}"`,
        advanced: () => summarizeAdvancedCondition(config.advancedCondition) || 'Condición avanzada'
      }
      const detail = summaries[goalType]?.()
      return {
        text: detail ? `Objetivo: ${detail}` : undefined,
        empty: 'Configura la meta de este objetivo'
      }
    }
  },
  {
    type: 'randomizer',
    kind: 'action',
    label: 'Aleatorizador',
    category: 'action-logic',
    description: 'Divide el tráfico al azar entre ramas',
    icon: Shuffle,
    accent: 'purple',
    tintedHeader: true,
    addButtonLabel: 'Configurar porcentajes',
    defaultConfig: () => ({
      branches: [
        { id: 'a', label: 'A', percent: 50 },
        { id: 'b', label: 'B', percent: 50 }
      ]
    }),
    fields: [
      { key: 'branches', label: 'Ramas y porcentajes', type: 'percentBranches', required: true }
    ],
    outputs: (config) =>
      arr<{ id?: unknown; label?: unknown; percent?: unknown }>(config.branches).map((branch, index) => ({
        id: str(branch.id) || `branch-${index + 1}`,
        label: `${str(branch.label) || String.fromCharCode(65 + index)} · ${Number(branch.percent) || 0}%`
      })),
    validate: (config) => {
      const branches = arr<{ percent?: unknown }>(config.branches)
      const total = branches.reduce((sum, branch) => sum + (Number(branch.percent) || 0), 0)
      if (branches.length < 2) return ['Agrega al menos dos ramas']
      if (total !== 100) return [`Los porcentajes deben sumar 100% (ahora suman ${total}%)`]
      return []
    },
    summary: (config) => ({ text: `${arr(config.branches).length} ramas al azar` })
  },
  {
    type: 'logic-actions-group',
    kind: 'action',
    label: 'Acciones',
    category: 'action-logic',
    description: 'Agrupa varias acciones internas',
    icon: ListChecks,
    accent: 'orange',
    tintedHeader: true,
    addButtonLabel: 'Describir acciones',
    defaultConfig: () => ({ notes: '' }),
    fields: [
      { key: 'notes', label: 'Acciones a ejecutar', type: 'textarea', placeholder: 'Describe las acciones, una por línea' }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      box: str(config.notes) || undefined,
      empty: 'Describe las acciones'
    })
  },
  {
    type: 'ai-step',
    kind: 'action',
    label: 'AI Step',
    category: 'action-ai',
    description: 'Permite que la IA gestione las conversaciones por ti',
    icon: Sparkles,
    accent: 'dark',
    requiredFeature: 'ai_agent',
    hiddenFromPicker: true,
    tintedHeader: true,
    addButtonLabel: 'Configurar IA',
    allowedChannels: [...ALLOWED_CHANNELS, 'any'],
    defaultConfig: () => ({
      systemPrompt: '',
      userPrompt: '',
      channel: 'any',
      useFor: 'message',
      saveAs: 'respuesta_ia',
      sampleResponseJson: ''
    }),
    fields: [
      { key: 'systemPrompt', label: 'Prompt del sistema', type: 'textarea', placeholder: 'Eres un asistente que…', required: true },
      { key: 'userPrompt', label: 'Prompt del usuario', type: 'textarea', placeholder: 'Responde al contacto sobre…', showVariables: true },
      { key: 'channel', label: 'Canal permitido', type: 'select', options: CHANNEL_OPTIONS_WITH_ANY },
      {
        key: 'useFor',
        label: 'Usar la respuesta para',
        type: 'select',
        options: [
          { value: 'message', label: 'Generar el mensaje a enviar' },
          { value: 'decide', label: 'Decidir el siguiente paso' },
          { value: 'classify', label: 'Clasificar la intención' }
        ]
      },
      { key: 'saveAs', label: 'Guardar respuesta en variable', type: 'text', placeholder: 'respuesta_ia', advanced: true },
      {
        key: 'sampleResponseJson',
        label: 'Muestra JSON de respuesta (opcional)',
        type: 'textarea',
        placeholder: '{\n  "intencion": "reagendar",\n  "sentimiento": "neutral"\n}',
        help: 'Si la IA devuelve JSON, pega una muestra para mapear subcampos.',
        advanced: true
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: aiOutput,
    summary: (config) => ({
      box: str(config.systemPrompt) || undefined,
      empty: 'Escribe el prompt de la IA'
    })
  },
  {
    type: 'ai-gpt-openai',
    kind: 'action',
    label: 'GPT impulsado por OpenAI',
    brand: 'OpenAI',
    category: 'action-ai',
    description: 'Genera contenido con un modelo GPT',
    icon: Bot,
    accent: 'dark',
    requiredFeature: 'ai_agent',
    tintedHeader: true,
    addButtonLabel: 'Configurar GPT',
    allowedChannels: [...ALLOWED_CHANNELS, 'any'],
    defaultConfig: () => ({
      model: 'gpt-4o-mini',
      systemPrompt: '',
      userPrompt: '',
      channel: 'any',
      useFor: 'message',
      saveAs: 'respuesta_ia',
      sampleResponseJson: ''
    }),
    fields: [
      { key: 'model', label: 'Modelo', type: 'text', placeholder: 'gpt-4o-mini', advanced: true },
      { key: 'systemPrompt', label: 'Prompt del sistema', type: 'textarea', placeholder: 'Eres un asistente que…', required: true },
      { key: 'userPrompt', label: 'Prompt del usuario', type: 'textarea', placeholder: 'Genera una respuesta para…', showVariables: true },
      { key: 'channel', label: 'Canal permitido', type: 'select', options: CHANNEL_OPTIONS_WITH_ANY },
      {
        key: 'useFor',
        label: 'Usar la respuesta para',
        type: 'select',
        options: [
          { value: 'message', label: 'Generar el mensaje a enviar' },
          { value: 'decide', label: 'Decidir el siguiente paso' },
          { value: 'classify', label: 'Clasificar la intención' }
        ]
      },
      { key: 'saveAs', label: 'Guardar respuesta en variable', type: 'text', placeholder: 'respuesta_ia', advanced: true },
      {
        key: 'sampleResponseJson',
        label: 'Muestra JSON de respuesta (opcional)',
        type: 'textarea',
        placeholder: '{\n  "intencion": "reagendar",\n  "datos": { "fecha_sugerida": "2026-06-20" }\n}',
        help: 'Si el modelo devuelve JSON, pega una muestra para mapear subcampos.',
        advanced: true
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: aiOutput,
    summary: (config) => ({
      box: str(config.systemPrompt) || undefined,
      empty: 'Escribe el prompt del modelo'
    })
  },
  {
    type: 'data-calculator',
    kind: 'action',
    label: 'Calculadora',
    category: 'action-data',
    description: 'Calcula un resultado numérico para usarlo después',
    icon: Calculator,
    accent: 'teal',
    addButtonLabel: 'Configurar cálculo',
    defaultConfig: () => ({ operation: 'add', initialValue: '', operand: '' }),
    fields: [
      { key: 'initialValue', label: 'Valor inicial', type: 'text', placeholder: '0', showVariables: true, required: true },
      {
        key: 'operation',
        label: 'Operación',
        type: 'select',
        options: [
          { value: 'add', label: 'Sumar' },
          { value: 'subtract', label: 'Restar' },
          { value: 'multiply', label: 'Multiplicar' },
          { value: 'divide', label: 'Dividir' },
          { value: 'percent', label: 'Porcentaje' }
        ]
      },
      { key: 'operand', label: 'Valor de operación', type: 'text', placeholder: '0', showVariables: true, required: true }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'calculadora',
      baseLabel: 'Calculadora',
      fields: [
        field('Resultado', 'resultado', 'number'),
        field('Operación', 'operacion'),
        field('Valor inicial', 'valor_inicial', 'number'),
        field('Valor final', 'valor_final', 'number')
      ]
    }),
    summary: (config) => {
      const operationLabels: Record<string, string> = {
        add: 'suma',
        subtract: 'resta',
        multiply: 'multiplica',
        divide: 'divide',
        percent: 'calcula porcentaje'
      }
      return {
        text: str(config.initialValue) || str(config.operand)
          ? `${operationLabels[str(config.operation)] || 'calcula'} · ${str(config.initialValue) || '0'} · ${str(config.operand) || '0'}`
          : undefined,
        empty: 'Configura la operación'
      }
    }
  },
  {
    type: 'data-format-number',
    kind: 'action',
    label: 'Formateador de número',
    category: 'action-data',
    description: 'Convierte números a moneda, porcentajes o decimales legibles',
    icon: Banknote,
    accent: 'teal',
    addButtonLabel: 'Configurar formato',
    defaultConfig: () => ({ value: '', format: 'currency', currency: 'MXN', decimals: 2 }),
    fields: [
      { key: 'value', label: 'Número original', type: 'text', placeholder: '{{payment.amount}}', showVariables: true, required: true },
      {
        key: 'format',
        label: 'Formato',
        type: 'select',
        options: [
          { value: 'currency', label: 'Moneda' },
          { value: 'decimal', label: 'Decimales' },
          { value: 'percent', label: 'Porcentaje' },
          { value: 'thousands', label: 'Separadores de miles' },
          { value: 'round', label: 'Redondear' }
        ]
      },
      { key: 'currency', label: 'Moneda', type: 'text', placeholder: 'MXN', showIf: (config) => str(config.format) === 'currency' },
      { key: 'decimals', label: 'Decimales', type: 'number', placeholder: '2' }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'formateador_numero',
      baseLabel: 'Formateador de número',
      fields: [
        field('Número original', 'numero_original', 'number'),
        field('Número formateado', 'numero_formateado')
      ]
    }),
    summary: (config) => ({
      text: str(config.value) ? `Formatea ${str(config.value)} · ${str(config.format) || 'moneda'}` : undefined,
      empty: 'Define el número a formatear'
    })
  },
  {
    type: 'data-format-date',
    kind: 'action',
    label: 'Formateador de fecha',
    category: 'action-data',
    description: 'Convierte fechas técnicas en fechas legibles',
    icon: CalendarClock,
    accent: 'teal',
    addButtonLabel: 'Configurar fecha',
    defaultConfig: () => ({ value: '', outputFormat: 'long', timezone: '' }),
    fields: [
      { key: 'value', label: 'Fecha original', type: 'text', placeholder: '{{appointment.date}}', showVariables: true, required: true },
      {
        key: 'outputFormat',
        label: 'Formato',
        type: 'select',
        options: [
          { value: 'long', label: 'Fecha larga' },
          { value: 'short', label: 'Fecha corta' },
          { value: 'date_time', label: 'Fecha y hora' },
          { value: 'time', label: 'Solo hora' }
        ]
      },
      { key: 'timezone', label: 'Zona horaria (opcional)', type: 'text', placeholder: 'America/Mexico_City' }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'formateador_fecha',
      baseLabel: 'Formateador de fecha',
      fields: [
        field('Fecha original', 'fecha_original'),
        field('Fecha formateada', 'fecha_formateada'),
        field('Día', 'dia', 'number'),
        field('Mes', 'mes'),
        field('Año', 'año', 'number'),
        field('Hora', 'hora')
      ]
    }),
    summary: (config) => ({
      text: str(config.value) ? `Formatea ${str(config.value)} · ${str(config.outputFormat) || 'fecha larga'}` : undefined,
      empty: 'Define la fecha a formatear'
    })
  },
  {
    type: 'data-format-text',
    kind: 'action',
    label: 'Formateador de texto',
    category: 'action-data',
    description: 'Limpia, capitaliza o extrae partes de un texto',
    icon: PencilLine,
    accent: 'teal',
    addButtonLabel: 'Configurar texto',
    defaultConfig: () => ({ value: '', transform: 'capitalize' }),
    fields: [
      { key: 'value', label: 'Texto original', type: 'text', placeholder: '{{respuesta_whatsapp.cuerpo}}', showVariables: true, required: true },
      {
        key: 'transform',
        label: 'Transformación',
        type: 'select',
        options: [
          { value: 'uppercase', label: 'Mayúsculas' },
          { value: 'lowercase', label: 'Minúsculas' },
          { value: 'capitalize', label: 'Capitalizar' },
          { value: 'trim', label: 'Limpiar espacios' },
          { value: 'extract', label: 'Extraer texto' }
        ]
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'formateador_texto',
      baseLabel: 'Formateador de texto',
      fields: [
        field('Texto original', 'texto_original'),
        field('Texto formateado', 'texto_formateado')
      ]
    }),
    summary: (config) => ({
      text: str(config.value) ? `Transforma texto · ${str(config.transform) || 'capitalizar'}` : undefined,
      empty: 'Define el texto a transformar'
    })
  },
  {
    type: 'action-appointment-upsert',
    kind: 'action',
    label: 'Crear / actualizar cita',
    category: 'action-data',
    description: 'Genera o modifica una cita y expone sus datos',
    icon: CalendarCheck,
    accent: 'teal',
    addButtonLabel: 'Configurar cita',
    defaultConfig: () => ({ mode: 'create', calendar: '', calendarName: '', date: '', time: '', service: '' }),
    fields: [
      {
        key: 'mode',
        label: 'Acción',
        type: 'select',
        options: [
          { value: 'create', label: 'Crear cita' },
          { value: 'read', label: 'Consultar cita' },
          { value: 'update', label: 'Actualizar cita' }
        ]
      },
      { key: 'calendar', label: 'Calendario', type: 'catalogSelect', catalog: 'calendars' },
      { key: 'date', label: 'Fecha', type: 'text', placeholder: '{{formateador_fecha_1.fecha_original}}', showVariables: true },
      { key: 'time', label: 'Hora', type: 'text', placeholder: '15:00', showVariables: true },
      { key: 'service', label: 'Servicio', type: 'text', placeholder: 'Consulta', showVariables: true }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: (config) => ({
      baseId: str(config.mode) === 'create' ? 'crear_cita' : 'cita',
      baseLabel: str(config.mode) === 'create' ? 'Crear cita' : 'Cita',
      fields: APPOINTMENT_FIELDS
    }),
    summary: (config) => {
      const modes: Record<string, string> = { create: 'Crear', read: 'Consultar', update: 'Actualizar' }
      return {
        text: `${modes[str(config.mode)] || 'Crear'} cita${str(config.date) ? ` · ${str(config.date)}` : ''}${str(config.time) ? ` ${str(config.time)}` : ''}`,
        empty: 'Configura la cita'
      }
    }
  },
  {
    type: 'extra-comment',
    kind: 'action',
    label: 'Post-it',
    category: 'action-extras',
    description: 'Nota interna visible en el canvas',
    icon: StickyNote,
    accent: 'yellow',
    tintedHeader: true,
    addButtonLabel: 'Escribir nota',
    noInput: true,
    defaultConfig: () => ({ text: '', color: 'yellow' }),
    fields: [
      { key: 'text', label: 'Nota', type: 'textarea', placeholder: 'Escribe una nota para tu equipo…' },
      {
        key: 'color',
        label: 'Color',
        type: 'select',
        options: [
          { value: 'yellow', label: 'Amarillo' },
          { value: 'pink', label: 'Rosa' },
          { value: 'blue', label: 'Azul' },
          { value: 'green', label: 'Verde' }
        ]
      }
    ],
    outputs: () => [],
    summary: (config) => ({
      box: str(config.text) || undefined,
      empty: 'Haz doble clic para escribir la nota'
    })
  }
]

// ---------------------------------------------------------------------------
// API del registro
// ---------------------------------------------------------------------------

// Nodos cuyas salidas son semánticas y no admiten ramas extra del usuario
const NO_EXTRA_BRANCH_TYPES = new Set(['logic-condition', 'randomizer', 'logic-wait', 'logic-drip', 'logic-goal', 'extra-comment'])

/**
 * Cualquier nodo de acción puede tener hasta 10 ramas: al ensamblar el
 * registro envolvemos sus salidas para incluir las ramas extra del usuario
 * (config.extraBranches). Los nodos de mensaje ya las incluyen junto con
 * las salidas de sus botones.
 */
function withMultiBranchSupport(definition: NodeDefinition): NodeDefinition {
  if (definition.kind !== 'action' || NO_EXTRA_BRANCH_TYPES.has(definition.type)) return definition
  if (definition.supportsMessageBlocks) return definition
  const baseOutputs = definition.outputs
  return {
    ...definition,
    supportsMultipleBranches: true,
    maxBranches: MAX_BRANCHES,
    outputs: (config) => withBranches(baseOutputs(config), config)
  }
}

export const NODE_DEFINITIONS: NodeDefinition[] = [
  ...TRIGGERS,
  ...CHANNEL_NODES,
  ...CONTACT_ACTIONS,
  ...OTHER_ACTIONS
].map(withMultiBranchSupport)

const definitionsByType = new Map(NODE_DEFINITIONS.map((definition) => [definition.type, definition]))

export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return definitionsByType.get(type)
}

export function getDefinitionsByKind(kind: NodeKind): NodeDefinition[] {
  return NODE_DEFINITIONS.filter((definition) => definition.kind === kind && !definition.hiddenFromPicker)
}

export function getCategoriesForKind(kind: NodeKind): NodeCategory[] {
  return NODE_CATEGORIES.filter((category) => category.kind === kind)
}

/** Errores de configuración de un nodo: requeridos genéricos + validación propia */
export function validateNodeConfig(definition: NodeDefinition, config: Record<string, unknown>): string[] {
  const errors: string[] = []

  definition.fields.forEach((field) => {
    if (!field.required) return
    if (field.showIf && !field.showIf(config)) return
    const value = config[field.key]
    const isEmpty =
      value === undefined ||
      value === null ||
      value === false ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0)
    if (isEmpty) {
      errors.push(`Completa el campo "${field.label}"`)
    }
  })

  if (definition.validate) {
    errors.push(...definition.validate(config))
  }

  // Filtros avanzados de los disparadores
  if (definition.kind === 'trigger') {
    errors.push(...validateTriggerFilters(obj(config).filters))
  }

  // Límite de ramas por nodo (salidas base + botones + ramas extra)
  const rawBranchCount =
    1 + messageBlockHandles(config).length + extraBranchHandles(config).length
  if (rawBranchCount > (definition.maxBranches || MAX_BRANCHES)) {
    errors.push(`Máximo ${definition.maxBranches || MAX_BRANCHES} ramas por paso`)
  }

  // Canales: nunca permitir SMS/correo u otros canales no soportados
  const channelKeys = ['channel', 'replyChannel', 'conversationChannel', 'actionChannel']
  channelKeys.forEach((key) => {
    const value = str(obj(config)[key])
    if (value && !['any', ...ALLOWED_CHANNELS].includes(value)) {
      errors.push(`El canal "${value}" no está disponible: usa WhatsApp, Messenger o Instagram Direct`)
    }
  })

  return errors
}

/** ¿El nodo ya tiene su configuración completa? (para el CTA contextual) */
export function isNodeConfigured(definition: NodeDefinition, config: Record<string, unknown>): boolean {
  return validateNodeConfig(definition, config).length === 0
}
