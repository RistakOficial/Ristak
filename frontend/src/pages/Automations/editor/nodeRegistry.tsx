import type { LucideIcon } from 'lucide-react'
import { WhatsAppIcon, MessengerIcon, InstagramIcon } from './BrandIcons'
import {
  Banknote,
  Bot,
  Calculator,
  CalendarCheck,
  CalendarClock,
  ClipboardList,
  Clock,
  Facebook,
  Filter,
  Hourglass,
  Instagram,
  ListChecks,
  Megaphone,
  MessageCircle,
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
  Zap
} from 'lucide-react'
import type { CatalogKind } from '@/services/automationCatalogsService'
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
// Canales conversacionales soportados: WhatsApp, Messenger e Instagram
// Direct. No existen SMS ni Email como canales (el email solo es dato CRM).
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
export type NodeConfigComponent = 'conditions' | 'wait' | 'goal' | 'whatsapp' | 'message'

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

export type MessageBlockType = 'text' | 'delay' | 'image' | 'video' | 'audio' | 'file' | 'template'

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
  /** Adjuntos (imagen, video, audio, archivo): URL del recurso.
   *  ADAPTADOR PENDIENTE: cuando exista subida de archivos, reemplazar por
   *  el selector de medios real. */
  url?: string
  caption?: string
  /** Audio: enviar como nota de voz de WhatsApp (ogg/opus). Default true */
  voiceNote?: boolean
  /** Bloque de plantilla de WhatsApp */
  templateId?: string
  templateName?: string
  /** Valores de las variables {{n}} de la plantilla (aceptan {{contact.x}}) */
  templateVariables?: Record<string, string>
  /** Archivo del encabezado (imagen/video/documento) si la plantilla lo pide */
  headerMediaUrl?: string
}

export const MEDIA_BLOCK_TYPES: MessageBlockType[] = ['image', 'video', 'audio', 'file']

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

function validateMessageBlocks(config: Record<string, unknown>): string[] {
  const blocks = asMessageBlocks(config.messageBlocks)
  const errors: string[] = []
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
    ;[...(block.buttons || []), ...(block.quickReplies || [])].forEach((button) => {
      if (!String(button.label || '').trim()) {
        errors.push(`Hay un botón sin nombre en el mensaje ${index + 1}`)
      }
      if (button.action === 'url' && !String(button.url || '').trim()) {
        errors.push(`El botón "${button.label || 'sin nombre'}" necesita URL`)
      }
    })
  })
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
  supportsVariables?: boolean
  supportsEmoji?: boolean
  defaultConfig: () => Record<string, unknown>
  fields: ConfigField[]
  /** Salidas del nodo según su configuración. [] = sin salidas (comentario) */
  outputs: (config: Record<string, unknown>) => NodeOutputHandle[]
  /** Sin conector de entrada (comentarios) */
  noInput?: boolean
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

/** Únicos canales conversacionales de la app (sin SMS ni Email) */
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
const arr = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export const channelLabel = (value: string): string =>
  CHANNEL_OPTIONS_WITH_ANY.find((option) => option.value === value)?.label || value

const DURATION_LABELS: Record<string, [string, string]> = {
  minutes: ['minuto', 'minutos'],
  hours: ['hora', 'horas'],
  days: ['día', 'días'],
  weeks: ['semana', 'semanas']
}

export const durationLabel = (amount: number, unit: string): string => {
  const [singular, plural] = DURATION_LABELS[unit] || DURATION_LABELS.hours
  return `${amount} ${amount === 1 ? singular : plural}`
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

const FORM_FIELDS: VariableSchemaField[] = [
  field('Nombre', 'nombre'),
  field('Teléfono', 'telefono'),
  field('Email', 'email'),
  field('Ciudad', 'ciudad'),
  field('Servicio de interés', 'servicio_de_interes'),
  field('Mensaje', 'mensaje'),
  field('Fecha de envío', 'fecha_de_envio')
]

const TRIGGER_LINK_FIELDS: VariableSchemaField[] = [
  field('ID del enlace', 'id_enlace'),
  field('Nombre del enlace', 'nombre_enlace'),
  field('URL pública', 'url_publica'),
  field('Destino final', 'destino_final'),
  field('Fecha del disparo', 'fecha_disparo')
]

const CONTACT_OUTPUT_FIELDS: VariableSchemaField[] = [
  field('ID del contacto', 'id_contacto'),
  field('Nombre', 'nombre'),
  field('Teléfono', 'telefono'),
  field('Email', 'email'),
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
  field('Email', 'email'),
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
  field('Método de pago', 'metodo_pago'),
  field('Fecha', 'fecha')
]

const WHATSAPP_SEND_FIELDS: VariableSchemaField[] = [
  field('ID del mensaje', 'id_mensaje'),
  field('Estado', 'estado'),
  field('Número destino', 'numero_destino'),
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
      const tag = str(config.tagName) || str(config.tag)
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
    type: 'trigger-customer-replied',
    kind: 'trigger',
    label: 'El Cliente Respondió',
    category: 'trigger-events',
    description: 'Se activa cuando el contacto responde un mensaje',
    icon: MessageCircleReply,
    accent: 'green',
    addButtonLabel: 'Configurar respuesta',
    allowedChannels: [...ALLOWED_CHANNELS, 'any'],
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
      baseLabel: 'Respuesta WhatsApp',
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
    label: 'Webhook entrante',
    category: 'trigger-events',
    description: 'Se activa al recibir una llamada HTTP externa',
    icon: Rss,
    accent: 'green',
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
        text: '{\n  "contacto": {\n    "nombre": "Ana",\n    "telefono": "+52 55 0000 0000",\n    "email": "ana@ejemplo.com"\n  },\n  "datos": { "origen": "mi-sistema" }\n}'
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
    description: 'Se activa cuando cambia un campo del contacto',
    icon: UserCog,
    accent: 'green',
    addButtonLabel: 'Seleccionar campo',
    defaultConfig: () => ({ field: '', fieldName: '' }),
    fields: [
      { key: 'field', label: 'Campo modificado', type: 'catalogSelect', catalog: 'contactFields', required: true }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: str(config.fieldName) || str(config.field)
        ? `Cuando cambie el campo "${str(config.fieldName) || str(config.field)}" de un contacto${triggerFiltersSentence(config.filters)}`
        : undefined,
      empty: 'Selecciona el campo a observar'
    })
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
    variableOutput: (config) => ({
      baseId: 'enlace_disparo',
      baseLabel: str(config.linkName) || str(config.link)
        ? `Clic de disparo - ${str(config.linkName) || str(config.link)}`
        : 'Clic de disparo',
      fields: TRIGGER_LINK_FIELDS
    }),
    summary: (config) => ({
      text: str(config.linkName) || str(config.link)
        ? `Cuando ocurra el clic de disparo "${str(config.linkName) || str(config.link)}"${triggerFiltersSentence(config.filters)}`
        : undefined,
      empty: 'Selecciona el clic de disparo'
    })
  },
  {
    type: 'trigger-scheduler',
    kind: 'trigger',
    label: 'Scheduler',
    category: 'trigger-events',
    description: 'Se ejecuta en una fecha u horario programado',
    icon: Clock,
    accent: 'green',
    addButtonLabel: 'Programar horario',
    defaultConfig: () => ({ datetime: '', recurrence: 'none', weekdays: [] }),
    fields: [
      { key: 'datetime', label: 'Fecha y hora', type: 'datetime', required: true },
      {
        key: 'recurrence',
        label: 'Recurrencia',
        type: 'select',
        showIf: (config) => Boolean(str(config.datetime)),
        options: [
          { value: 'none', label: 'Una sola vez' },
          { value: 'daily', label: 'Cada día' },
          { value: 'weekly', label: 'Cada semana' },
          { value: 'monthly', label: 'Cada mes' }
        ]
      },
      {
        key: 'weekdays',
        label: 'Días permitidos',
        type: 'weekdays',
        showIf: (config) => str(config.recurrence) === 'daily' || str(config.recurrence) === 'weekly'
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    variableOutput: () => ({
      baseId: 'cita',
      baseLabel: 'Cita',
      fields: APPOINTMENT_FIELDS
    }),
    summary: (config) => {
      const recurrences: Record<string, string> = {
        none: 'Una sola vez',
        daily: 'Cada día',
        weekly: 'Cada semana',
        monthly: 'Cada mes'
      }
      const datetime = str(config.datetime)
      return {
        text: datetime
          ? `${str(config.recurrence) === 'none' ? 'El' : recurrences[str(config.recurrence)]} ${datetime.replace('T', ' a las ')}`
          : undefined,
        empty: 'Programa la fecha y hora'
      }
    }
  },
  {
    type: 'trigger-appointment-booked',
    kind: 'trigger',
    label: 'Cita reservada por el cliente',
    category: 'trigger-appointments',
    description: 'Se activa cuando el contacto agenda una cita',
    icon: CalendarCheck,
    accent: 'green',
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
        text: `Cuando el cliente agende una cita${calendar ? ` en "${calendar}"` : ''}${triggerFiltersSentence(config.filters)}`
      }
    }
  },
  {
    type: 'trigger-payment-received',
    kind: 'trigger',
    label: 'Pago recibido',
    category: 'trigger-events',
    description: 'Se activa cuando se registra un pago',
    icon: Receipt,
    accent: 'green',
    addButtonLabel: 'Configurar pago',
    defaultConfig: () => ({ product: '', amountOperator: 'any', amount: '' }),
    fields: [
      { key: 'product', label: 'Producto (opcional)', type: 'catalogSelect', catalog: 'products', advanced: true },
      {
        key: 'amountOperator',
        label: 'Monto',
        type: 'select',
        options: [
          { value: 'any', label: 'Cualquier monto' },
          { value: 'gt', label: 'Mayor que' },
          { value: 'lt', label: 'Menor que' },
          { value: 'eq', label: 'Igual a' }
        ]
      },
      {
        key: 'amount',
        label: 'Cantidad',
        type: 'number',
        placeholder: '0',
        showIf: (config) => str(config.amountOperator) !== 'any' && str(config.amountOperator) !== ''
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => {
      const operator = str(config.amountOperator)
      const amount = config.amount === '' || config.amount === undefined ? '' : Number(config.amount)
      const operatorLabels: Record<string, string> = { gt: 'mayor a', lt: 'menor a', eq: 'igual a' }
      const extra = operator !== 'any' && amount !== '' ? ` ${operatorLabels[operator] || ''} $${amount}` : ''
      return { text: `Cuando se reciba un pago${extra}${triggerFiltersSentence(config.filters)}` }
    }
  },
  {
    type: 'trigger-facebook-comment',
    kind: 'trigger',
    label: 'Facebook - Comentario(s) en una publicación',
    brand: 'Facebook',
    category: 'trigger-fbig',
    description: 'Se activa con comentarios en tus publicaciones de Facebook',
    icon: Facebook,
    accent: 'green',
    addButtonLabel: 'Responder comentario',
    allowedChannels: ['messenger'],
    defaultConfig: () => ({
      post: '',
      keywords: [],
      match: 'contains',
      allowedComments: 'all',
      avoidDuplicates: true,
      publicReplyEnabled: false,
      publicReply: '',
      dmReplyEnabled: false,
      dmReply: ''
    }),
    fields: [
      { key: 'post', label: 'Publicación', type: 'text', placeholder: 'URL o ID de la publicación', required: true },
      { key: 'keywords', label: 'Palabras clave (opcional)', type: 'keywords', placeholder: 'Escribe y presiona Enter', advanced: true },
      {
        key: 'match',
        label: 'Regla de coincidencia',
        type: 'select',
        showIf: (config) => Boolean(str(config.post)),
        options: [
          { value: 'contains', label: 'Contiene' },
          { value: 'exact', label: 'Coincidencia exacta' }
        ]
      },
      {
        key: 'allowedComments',
        label: 'Comentarios permitidos',
        type: 'select',
        showIf: (config) => Boolean(str(config.post)),
        options: [
          { value: 'all', label: 'Todos los comentarios' },
          { value: 'first_only', label: 'Solo el primer comentario de cada persona' }
        ]
      },
      { key: 'avoidDuplicates', label: 'Evitar respuestas duplicadas', type: 'toggle', showIf: (config) => Boolean(str(config.post)) },
      { key: 'publicReplyEnabled', label: 'Responder públicamente al comentario', type: 'toggle', showIf: (config) => Boolean(str(config.post)) },
      {
        key: 'publicReply',
        label: 'Respuesta pública',
        type: 'textarea',
        placeholder: '¡Gracias por comentar! Te escribimos por privado…',
        showVariables: true,
        showIf: (config) => Boolean(str(config.post)) && Boolean(config.publicReplyEnabled)
      },
      { key: 'dmReplyEnabled', label: 'Responder por Messenger', type: 'toggle', showIf: (config) => Boolean(str(config.post)) },
      {
        key: 'dmReply',
        label: 'Mensaje por Messenger',
        type: 'textarea',
        placeholder: 'Hola {{nombre}}, vimos tu comentario…',
        showVariables: true,
        showIf: (config) => Boolean(str(config.post)) && Boolean(config.dmReplyEnabled)
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: str(config.post) ? `Cuando comenten tu publicación de Facebook${triggerFiltersSentence(config.filters)}` : undefined,
      empty: 'Selecciona la publicación'
    })
  },
  {
    type: 'trigger-instagram-comment',
    kind: 'trigger',
    label: 'Instagram - Comentario(s) en una publicación',
    brand: 'Instagram',
    category: 'trigger-fbig',
    description: 'Se activa con comentarios en tus publicaciones o reels',
    icon: Instagram,
    accent: 'green',
    addButtonLabel: 'Responder comentario',
    allowedChannels: ['instagram'],
    defaultConfig: () => ({
      post: '',
      keywords: [],
      match: 'contains',
      allowedComments: 'all',
      publicReplyEnabled: false,
      publicReply: '',
      dmReplyEnabled: false,
      dmReply: ''
    }),
    fields: [
      { key: 'post', label: 'Publicación o reel', type: 'text', placeholder: 'URL o ID de la publicación', required: true },
      { key: 'keywords', label: 'Palabras clave (opcional)', type: 'keywords', placeholder: 'Escribe y presiona Enter', advanced: true },
      {
        key: 'match',
        label: 'Regla de coincidencia',
        type: 'select',
        showIf: (config) => Boolean(str(config.post)),
        options: [
          { value: 'contains', label: 'Contiene' },
          { value: 'exact', label: 'Coincidencia exacta' }
        ]
      },
      {
        key: 'allowedComments',
        label: 'Comentarios permitidos',
        type: 'select',
        showIf: (config) => Boolean(str(config.post)),
        options: [
          { value: 'all', label: 'Todos los comentarios' },
          { value: 'first_only', label: 'Solo el primer comentario de cada persona' }
        ]
      },
      { key: 'publicReplyEnabled', label: 'Responder públicamente al comentario', type: 'toggle', showIf: (config) => Boolean(str(config.post)) },
      {
        key: 'publicReply',
        label: 'Respuesta pública',
        type: 'textarea',
        placeholder: '¡Gracias por comentar!',
        showVariables: true,
        showIf: (config) => Boolean(str(config.post)) && Boolean(config.publicReplyEnabled)
      },
      { key: 'dmReplyEnabled', label: 'Responder por Instagram Direct', type: 'toggle', showIf: (config) => Boolean(str(config.post)) },
      {
        key: 'dmReply',
        label: 'Mensaje por Instagram Direct',
        type: 'textarea',
        placeholder: 'Hola {{nombre}}, vimos tu comentario…',
        showVariables: true,
        showIf: (config) => Boolean(str(config.post)) && Boolean(config.dmReplyEnabled)
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: str(config.post) ? `Cuando comenten tu publicación de Instagram${triggerFiltersSentence(config.filters)}` : undefined,
      empty: 'Selecciona la publicación'
    })
  },
  {
    type: 'trigger-click-to-whatsapp',
    kind: 'trigger',
    label: 'Click to WhatsApp ads',
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
      baseLabel: 'Respuesta WhatsApp',
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
    label: 'Refund',
    category: 'trigger-events',
    description: 'Se activa cuando se procesa un reembolso',
    icon: RotateCcw,
    accent: 'green',
    addButtonLabel: 'Configurar reembolso',
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
    label: 'El usuario hace clic en un anuncio de Facebook',
    brand: 'Facebook Ads',
    category: 'trigger-fbig',
    description: 'Se activa cuando el contacto llega desde un anuncio',
    icon: Megaphone,
    accent: 'green',
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
  description: string
  addButtonLabel: string
  channel: 'whatsapp' | 'messenger' | 'instagram'
  supportsQuickReplies: boolean
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
        errors.push(...validateMessageBlocks(config))
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
      const blocks = asMessageBlocks(config.messageBlocks).filter((block) => block.type === 'text').length
      return {
        text: `${senderLabels[str(config.sender)] || 'Número principal'}${isTemplate ? ' · Plantilla' : blocks > 1 ? ` · ${blocks} mensajes` : ''}`,
        box: isTemplate ? str(config.templateName) || undefined : firstTextBlock(config) || undefined,
        empty: 'Configura el mensaje de WhatsApp'
      }
    }
  },
  channelMessageNode({
    type: 'channel-messenger',
    label: 'Messenger',
    brand: 'Messenger',
    icon: MessengerIcon,
    accent: 'blue',
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
    description: 'Envía DMs por Instagram',
    addButtonLabel: 'Agregar DM',
    channel: 'instagram',
    supportsQuickReplies: true,
    senderKey: 'account',
    senderLabel: 'Cuenta de Instagram (opcional)'
  })
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
      { key: 'firstName', label: 'Nombre', type: 'text', placeholder: '{{nombre}}', showVariables: true },
      { key: 'lastName', label: 'Apellido', type: 'text', placeholder: '{{apellido}}' },
      { key: 'phone', label: 'Teléfono', type: 'text', placeholder: '{{telefono}}', required: true },
      { key: 'email', label: 'Email (dato de contacto, opcional)', type: 'text', placeholder: '{{email}}' },
      { key: 'source', label: 'Fuente (opcional)', type: 'text', placeholder: 'Ej. automatización' },
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
    defaultConfig: () => ({ searchBy: 'phone', customKey: '', notFound: 'continue' }),
    fields: [
      {
        key: 'searchBy',
        label: 'Buscar por',
        type: 'select',
        required: true,
        options: [
          { value: 'phone', label: 'Teléfono' },
          { value: 'email', label: 'Email (dato de contacto)' },
          { value: 'id', label: 'ID del contacto' },
          { value: 'custom', label: 'Campo personalizado' }
        ]
      },
      {
        key: 'customKey',
        label: 'Campo personalizado',
        type: 'catalogSelect',
        catalog: 'customFields',
        showIf: (config) => str(config.searchBy) === 'custom'
      },
      {
        key: 'notFound',
        label: 'Si no existe el contacto',
        type: 'select',
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
      str(config.searchBy) === 'custom' && !str(config.customKey)
        ? ['Selecciona el campo personalizado de búsqueda']
        : [],
    summary: (config) => {
      const labels: Record<string, string> = {
        phone: 'teléfono',
        email: 'email',
        id: 'ID',
        custom: 'campo personalizado'
      }
      return { text: `Busca el contacto por ${labels[str(config.searchBy)] || 'teléfono'}` }
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
    type: 'action-add-contact-tag',
    kind: 'action',
    label: 'Añadir etiqueta de contacto',
    category: 'action-contacts',
    icon: Tags,
    accent: 'blue',
    addButtonLabel: 'Seleccionar etiqueta',
    defaultConfig: () => ({ tag: '' }),
    fields: [
      { key: 'tag', label: 'Etiqueta', type: 'catalogSelect', catalog: 'tags', required: true }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: (str(config.tagName) || str(config.tag)) ? `Añadir la etiqueta "${str(config.tagName) || str(config.tag)}" al contacto` : undefined,
      empty: 'Selecciona la etiqueta'
    })
  },
  {
    type: 'action-remove-contact-tag',
    kind: 'action',
    label: 'Eliminar la etiqueta de contacto',
    category: 'action-contacts',
    icon: Tags,
    accent: 'blue',
    addButtonLabel: 'Seleccionar etiqueta',
    defaultConfig: () => ({ tag: '' }),
    fields: [
      { key: 'tag', label: 'Etiqueta', type: 'catalogSelect', catalog: 'tags', required: true }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: (str(config.tagName) || str(config.tag)) ? `Quitar la etiqueta "${str(config.tagName) || str(config.tag)}" del contacto` : undefined,
      empty: 'Selecciona la etiqueta'
    })
  },
  {
    type: 'action-assign-user',
    kind: 'action',
    label: 'Asignar al usuario',
    category: 'action-contacts',
    icon: UserCheck,
    accent: 'blue',
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
    type: 'action-webhook',
    kind: 'action',
    label: 'Webhook',
    category: 'action-data',
    description: 'Envía datos a un sistema externo',
    icon: Webhook,
    accent: 'teal',
    addButtonLabel: 'Configurar webhook',
    defaultConfig: () => ({
      url: '',
      method: 'POST',
      headers: [],
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
      { key: 'headers', label: 'Headers', type: 'keyValue', advanced: true },
      { key: 'body', label: 'Body (JSON)', type: 'textarea', placeholder: '{\n  "telefono": "{{telefono}}"\n}', showVariables: true },
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
        return { text: `Esperar la respuesta del contacto${channel}${timeoutText}` }
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
        const actionResource = str(config.actionResourceName) || str(config.actionResource)
        const resourceText = str(config.expectedAction) === 'click_link' && actionResource ? ` "${actionResource}"` : ''
        return { text: `Esperar a que ${actions[str(config.expectedAction)] || 'realice una acción'}${resourceText}${timeoutText}` }
      }
      if (mode === 'conditions') {
        const summary = summarizeAdvancedCondition(config.conditions)
        return { text: `Esperar hasta que ${summary || 'se cumpla una condición'}${timeoutText}` }
      }
      return { empty: 'Selecciona el tipo de espera' }
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
          return `${operators[str(config.tagOperator)] || 'Tiene etiqueta'} ${str(config.tagName) || str(config.tag)}`
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
          const linkName = str(config.linkName) || str(config.link)
          return `Clic de disparo${linkName ? ` "${linkName}"` : ''}`
        },
        conversation: () => `Respondió por ${channelLabel(str(config.conversationChannel) || 'any')}`,
        contact: () => 'Cambio en el contacto',
        ads: () => (str(config.adsEvent) === 'ctwa' ? 'Click to WhatsApp ads' : 'Clic en anuncio de Facebook'),
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
    label: 'Comentario',
    category: 'action-extras',
    description: 'Nota interna visible en el canvas',
    icon: StickyNote,
    accent: 'yellow',
    tintedHeader: true,
    addButtonLabel: 'Escribir comentario',
    noInput: true,
    defaultConfig: () => ({ text: '' }),
    fields: [
      { key: 'text', label: 'Nota', type: 'textarea', placeholder: 'Escribe una nota para tu equipo…' }
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
const NO_EXTRA_BRANCH_TYPES = new Set(['logic-condition', 'randomizer', 'logic-wait', 'logic-goal', 'extra-comment'])

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
  return NODE_DEFINITIONS.filter((definition) => definition.kind === kind)
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

  // Canales: nunca permitir SMS/Email u otros canales no soportados
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
