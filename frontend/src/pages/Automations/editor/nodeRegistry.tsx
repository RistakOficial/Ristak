import type { LucideIcon } from 'lucide-react'
import {
  Banknote,
  Bot,
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
  Split,
  StickyNote,
  Tag,
  Tags,
  Target,
  Timer,
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
import { summarizeCondition, validateConditionRules, emptyConditionConfig } from './crmFields'

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
export type NodeConfigComponent = 'conditions' | 'wait' | 'goal' | 'whatsapp'

export interface NodeDefinition {
  type: string
  kind: NodeKind
  label: string
  /** Texto pequeño sobre el título de la cajita (ej. "Facebook") */
  brand?: string
  category: string
  description?: string
  icon: LucideIcon
  accent: NodeAccent
  /** Encabezado con banda de color (lógica, IA, extras) o plano (contenido) */
  tintedHeader?: boolean
  /** CTA contextual dentro de la cajita (ej. "+ Agregar mensaje") */
  addButtonLabel?: string
  /** Canales permitidos cuando el nodo usa canal conversacional */
  allowedChannels?: string[]
  /** Configurador con componente propio */
  configComponent?: NodeConfigComponent
  defaultConfig: () => Record<string, unknown>
  fields: ConfigField[]
  /** Salidas del nodo según su configuración. [] = sin salidas (comentario) */
  outputs: (config: Record<string, unknown>) => NodeOutputHandle[]
  /** Sin conector de entrada (comentarios) */
  noInput?: boolean
  /** Validación específica además de los campos requeridos */
  validate?: (config: Record<string, unknown>) => string[]
  summary: (config: Record<string, unknown>) => NodeSummaryData
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
    defaultConfig: () => ({ tag: '', operator: 'added' }),
    fields: [
      { key: 'tag', label: 'Etiqueta', type: 'catalogSelect', catalog: 'tags', required: true },
      {
        key: 'operator',
        label: 'Operador',
        type: 'select',
        required: true,
        options: [
          { value: 'added', label: 'Añadida' },
          { value: 'removed', label: 'Eliminada' },
          { value: 'contains', label: 'Contiene' }
        ]
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => {
      const operators: Record<string, string> = { added: 'añadida', removed: 'eliminada', contains: 'contiene' }
      const tag = str(config.tag)
      return {
        text: tag ? `Etiqueta "${tag}" ${operators[str(config.operator)] || 'añadida'}` : undefined,
        empty: 'Selecciona la etiqueta que dispara el flujo'
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
    defaultConfig: () => ({ form: '', formName: '', conditions: '' }),
    fields: [
      { key: 'form', label: 'Formulario', type: 'catalogSelect', catalog: 'forms', required: true },
      { key: 'conditions', label: 'Condiciones (opcional)', type: 'textarea', placeholder: 'Ej. campo "interés" = demo' }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: str(config.formName) || str(config.form) ? `Formulario: ${str(config.formName) || str(config.form)}` : undefined,
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
      { key: 'keywords', label: 'Palabras clave (opcional)', type: 'keywords', placeholder: 'Escribe y presiona Enter' },
      {
        key: 'match',
        label: 'Coincidencia',
        type: 'select',
        options: [
          { value: 'contains', label: 'Contiene' },
          { value: 'exact', label: 'Coincidencia exacta' },
          { value: 'starts_with', label: 'Empieza con' }
        ]
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => {
      const keywords = arr<string>(config.keywords)
      const channel = channelLabel(str(config.channel) || 'any')
      return {
        text: keywords.length > 0 ? `${channel} · "${keywords.join('", "')}"` : `Cualquier respuesta · ${channel}`
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
    defaultConfig: () => ({ endpointId: '', method: 'POST' }),
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
    summary: (config) => ({
      text: str(config.endpointId) ? `Esperando llamadas ${str(config.method) || 'POST'}` : undefined,
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
    defaultConfig: () => ({ status: 'confirmed', calendar: '', calendarName: '' }),
    fields: [
      {
        key: 'status',
        label: 'Estado',
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
      { key: 'calendar', label: 'Calendario (opcional)', type: 'catalogSelect', catalog: 'calendars' }
    ],
    outputs: () => SINGLE_OUTPUT,
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
      return { text: `Cita ${statuses[str(config.status)] || 'Confirmada'}${calendar ? ` · ${calendar}` : ''}` }
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
    defaultConfig: () => ({ field: '', fieldName: '', condition: '' }),
    fields: [
      { key: 'field', label: 'Campo modificado', type: 'catalogSelect', catalog: 'contactFields', required: true },
      { key: 'condition', label: 'Condición (opcional)', type: 'text', placeholder: 'Ej. etapa = cliente' }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: str(config.fieldName) || str(config.field) ? `Cuando cambia "${str(config.fieldName) || str(config.field)}"` : undefined,
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
      { key: 'source', label: 'Fuente (opcional)', type: 'text', placeholder: 'Cualquier fuente' }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: str(config.source) ? `Fuente: ${str(config.source)}` : 'Cualquier contacto nuevo'
    })
  },
  {
    type: 'trigger-activation-link',
    kind: 'trigger',
    label: 'Se ha hecho clic en el enlace de activación',
    category: 'trigger-events',
    description: 'Se activa cuando el contacto abre tu enlace',
    icon: MousePointerClick,
    accent: 'green',
    addButtonLabel: 'Seleccionar enlace',
    defaultConfig: () => ({ link: '' }),
    fields: [
      { key: 'link', label: 'Enlace o identificador', type: 'text', placeholder: 'Ej. enlace-promo', required: true }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: str(config.link) ? `Enlace: ${str(config.link)}` : undefined,
      empty: 'Define el enlace a rastrear'
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
    defaultConfig: () => ({ datetime: '', recurrence: 'none', timezone: '', weekdays: [] }),
    fields: [
      { key: 'datetime', label: 'Fecha y hora', type: 'datetime', required: true },
      {
        key: 'recurrence',
        label: 'Recurrencia',
        type: 'select',
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
      },
      { key: 'timezone', label: 'Zona horaria (opcional)', type: 'text', placeholder: 'Ej. America/Mexico_City' }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => {
      const recurrences: Record<string, string> = {
        none: 'Una sola vez',
        daily: 'Cada día',
        weekly: 'Cada semana',
        monthly: 'Cada mes'
      }
      const datetime = str(config.datetime)
      return {
        text: datetime ? `${recurrences[str(config.recurrence)] || 'Una sola vez'} · ${datetime.replace('T', ' ')}` : undefined,
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
      { key: 'calendar', label: 'Calendario (opcional)', type: 'catalogSelect', catalog: 'calendars' },
      { key: 'appointmentType', label: 'Tipo de cita (opcional)', type: 'text', placeholder: 'Ej. demo, consulta…' },
      { key: 'assignedUser', label: 'Usuario asignado (opcional)', type: 'catalogSelect', catalog: 'users' }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => {
      const calendar = str(config.calendarName) || str(config.calendar)
      return { text: calendar ? `Calendario: ${calendar}` : 'Cualquier calendario' }
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
    defaultConfig: () => ({ provider: '', product: '', amountOperator: 'any', amount: '', currency: '', status: '' }),
    fields: [
      { key: 'provider', label: 'Proveedor (opcional)', type: 'text', placeholder: 'Ej. Stripe' },
      { key: 'product', label: 'Producto (opcional)', type: 'catalogSelect', catalog: 'products' },
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
      },
      { key: 'currency', label: 'Moneda (opcional)', type: 'text', placeholder: 'MXN' },
      { key: 'status', label: 'Estado (opcional)', type: 'text', placeholder: 'Ej. pagado' }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => {
      const operator = str(config.amountOperator)
      const amount = config.amount === '' || config.amount === undefined ? '' : Number(config.amount)
      const operatorLabels: Record<string, string> = { gt: 'mayor a', lt: 'menor a', eq: 'igual a' }
      const parts = [
        str(config.provider) ? `Pagos de ${str(config.provider)}` : 'Cualquier pago recibido',
        operator !== 'any' && amount !== '' ? `${operatorLabels[operator] || ''} $${amount}` : ''
      ].filter(Boolean)
      return { text: parts.join(' · ') }
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
      { key: 'keywords', label: 'Palabras clave (opcional)', type: 'keywords', placeholder: 'Escribe y presiona Enter' },
      {
        key: 'match',
        label: 'Regla de coincidencia',
        type: 'select',
        options: [
          { value: 'contains', label: 'Contiene' },
          { value: 'exact', label: 'Coincidencia exacta' }
        ]
      },
      {
        key: 'allowedComments',
        label: 'Comentarios permitidos',
        type: 'select',
        options: [
          { value: 'all', label: 'Todos los comentarios' },
          { value: 'first_only', label: 'Solo el primer comentario de cada persona' }
        ]
      },
      { key: 'avoidDuplicates', label: 'Evitar respuestas duplicadas', type: 'toggle' },
      { key: 'publicReplyEnabled', label: 'Responder públicamente al comentario', type: 'toggle' },
      {
        key: 'publicReply',
        label: 'Respuesta pública',
        type: 'textarea',
        placeholder: '¡Gracias por comentar! Te escribimos por privado…',
        showVariables: true,
        showIf: (config) => Boolean(config.publicReplyEnabled)
      },
      { key: 'dmReplyEnabled', label: 'Responder por Messenger', type: 'toggle' },
      {
        key: 'dmReply',
        label: 'Mensaje por Messenger',
        type: 'textarea',
        placeholder: 'Hola {{nombre}}, vimos tu comentario…',
        showVariables: true,
        showIf: (config) => Boolean(config.dmReplyEnabled)
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: str(config.post) ? `Comentarios en ${str(config.post)}` : undefined,
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
      { key: 'keywords', label: 'Palabras clave (opcional)', type: 'keywords', placeholder: 'Escribe y presiona Enter' },
      {
        key: 'match',
        label: 'Regla de coincidencia',
        type: 'select',
        options: [
          { value: 'contains', label: 'Contiene' },
          { value: 'exact', label: 'Coincidencia exacta' }
        ]
      },
      {
        key: 'allowedComments',
        label: 'Comentarios permitidos',
        type: 'select',
        options: [
          { value: 'all', label: 'Todos los comentarios' },
          { value: 'first_only', label: 'Solo el primer comentario de cada persona' }
        ]
      },
      { key: 'publicReplyEnabled', label: 'Responder públicamente al comentario', type: 'toggle' },
      {
        key: 'publicReply',
        label: 'Respuesta pública',
        type: 'textarea',
        placeholder: '¡Gracias por comentar!',
        showVariables: true,
        showIf: (config) => Boolean(config.publicReplyEnabled)
      },
      { key: 'dmReplyEnabled', label: 'Responder por Instagram Direct', type: 'toggle' },
      {
        key: 'dmReply',
        label: 'Mensaje por Instagram Direct',
        type: 'textarea',
        placeholder: 'Hola {{nombre}}, vimos tu comentario…',
        showVariables: true,
        showIf: (config) => Boolean(config.dmReplyEnabled)
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: str(config.post) ? `Comentarios en ${str(config.post)}` : undefined,
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
      { key: 'campaign', label: 'Campaña o anuncio (opcional)', type: 'catalogSelect', catalog: 'campaigns' },
      { key: 'source', label: 'Fuente (opcional)', type: 'text', placeholder: 'Ej. ctwa' }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: str(config.campaign) && str(config.campaign) !== 'any' ? `Anuncio: ${str(config.campaign)}` : 'Cualquier anuncio de WhatsApp'
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
    defaultConfig: () => ({ provider: '', product: '', amount: '', currency: '', reason: '' }),
    fields: [
      { key: 'provider', label: 'Proveedor (opcional)', type: 'text', placeholder: 'Ej. Stripe' },
      { key: 'product', label: 'Producto (opcional)', type: 'catalogSelect', catalog: 'products' },
      { key: 'amount', label: 'Monto mínimo (opcional)', type: 'number', placeholder: '0' },
      { key: 'currency', label: 'Moneda (opcional)', type: 'text', placeholder: 'MXN' },
      { key: 'reason', label: 'Motivo (opcional)', type: 'text', placeholder: 'Cualquier motivo' }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: str(config.provider) ? `Reembolsos de ${str(config.provider)}` : 'Cualquier reembolso'
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
      { key: 'campaign', label: 'Campaña (opcional)', type: 'catalogSelect', catalog: 'campaigns' },
      { key: 'adsetId', label: 'Conjunto de anuncios (opcional)', type: 'text', placeholder: 'Cualquier conjunto' },
      { key: 'adId', label: 'Anuncio (opcional)', type: 'text', placeholder: 'Ej. Facebook Ads #1' }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      text: str(config.adId) || (str(config.campaign) && str(config.campaign) !== 'any')
        ? `Anuncio: ${str(config.adId) || str(config.campaign)}`
        : 'Cualquier anuncio de Facebook'
    })
  }
]

// ---------------------------------------------------------------------------
// Contenido / Canales (WhatsApp, Messenger, Instagram Direct, Facebook)
// ---------------------------------------------------------------------------

const CHANNEL_NODES: NodeDefinition[] = [
  {
    type: 'channel-whatsapp',
    kind: 'action',
    label: 'WhatsApp',
    brand: 'WhatsApp',
    category: 'action-content',
    description: 'Envía un mensaje de WhatsApp',
    icon: MessageSquareText,
    accent: 'teal',
    addButtonLabel: 'Agregar mensaje',
    allowedChannels: ['whatsapp'],
    configComponent: 'whatsapp',
    defaultConfig: () => ({
      sender: 'default',
      senderNumberId: '',
      senderNumberLabel: '',
      messageType: 'text',
      message: '',
      templateId: '',
      templateName: '',
      templateLanguage: '',
      templateVariables: [],
      saveAs: ''
    }),
    fields: [],
    outputs: () => SINGLE_OUTPUT,
    validate: (config) => {
      const errors: string[] = []
      if (str(config.messageType) === 'template') {
        if (!str(config.templateId)) errors.push('Selecciona la plantilla de WhatsApp')
      } else if (!str(config.message).trim()) {
        errors.push('Escribe el mensaje de WhatsApp')
      }
      if (str(config.sender) === 'specific' && !str(config.senderNumberId)) {
        errors.push('Selecciona el número de WhatsApp remitente')
      }
      return errors
    },
    summary: (config) => {
      const senderLabels: Record<string, string> = {
        'last-channel': 'Último número que usó el contacto',
        default: 'Número principal',
        specific: str(config.senderNumberLabel) || 'Número seleccionado'
      }
      const isTemplate = str(config.messageType) === 'template'
      return {
        text: `${senderLabels[str(config.sender)] || 'Número principal'}${isTemplate ? ' · Plantilla' : ''}`,
        box: isTemplate ? str(config.templateName) || undefined : str(config.message) || undefined,
        empty: 'Configura el mensaje de WhatsApp'
      }
    }
  },
  {
    type: 'channel-messenger',
    kind: 'action',
    label: 'Messenger',
    brand: 'Facebook',
    category: 'action-content',
    description: 'Envía un mensaje por Messenger',
    icon: MessageCircle,
    accent: 'blue',
    addButtonLabel: 'Agregar mensaje',
    allowedChannels: ['messenger'],
    defaultConfig: () => ({ message: '', page: '' }),
    fields: [
      {
        key: 'message',
        label: 'Texto del mensaje',
        type: 'textarea',
        placeholder: 'Escribe el mensaje…',
        required: true,
        showVariables: true
      },
      { key: 'page', label: 'Página remitente (opcional)', type: 'text', placeholder: 'Página conectada por defecto' }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      box: str(config.message) || undefined,
      empty: 'Escribe el mensaje de Messenger'
    })
  },
  {
    type: 'channel-instagram',
    kind: 'action',
    label: 'Instagram Direct',
    brand: 'Instagram',
    category: 'action-content',
    description: 'Envía un DM por Instagram',
    icon: Instagram,
    accent: 'pink',
    addButtonLabel: 'Agregar DM',
    allowedChannels: ['instagram'],
    defaultConfig: () => ({ message: '', account: '' }),
    fields: [
      {
        key: 'message',
        label: 'Texto del DM',
        type: 'textarea',
        placeholder: 'Escribe el mensaje…',
        required: true,
        showVariables: true
      },
      { key: 'account', label: 'Cuenta de Instagram (opcional)', type: 'text', placeholder: 'Cuenta conectada por defecto' }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      box: str(config.message) || undefined,
      empty: 'Escribe el DM de Instagram'
    })
  },
  {
    type: 'channel-facebook-message',
    kind: 'action',
    label: 'Enviar mensaje',
    brand: 'Facebook',
    category: 'action-content',
    description: 'Envía un mensaje por Facebook (Messenger)',
    icon: Facebook,
    accent: 'blue',
    addButtonLabel: 'Agregar mensaje',
    allowedChannels: ['messenger'],
    defaultConfig: () => ({ message: '', page: '' }),
    fields: [
      {
        key: 'message',
        label: 'Texto del mensaje',
        type: 'textarea',
        placeholder: 'Escribe el mensaje…',
        required: true,
        showVariables: true
      },
      { key: 'page', label: 'Página remitente (opcional)', type: 'text', placeholder: 'Página conectada por defecto' }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      box: str(config.message) || undefined,
      empty: 'Escribe el mensaje'
    })
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
      { key: 'firstName', label: 'Nombre', type: 'text', placeholder: '{{nombre}}', showVariables: true },
      { key: 'lastName', label: 'Apellido', type: 'text', placeholder: '{{apellido}}' },
      { key: 'phone', label: 'Teléfono', type: 'text', placeholder: '{{telefono}}', required: true },
      { key: 'email', label: 'Email (dato de contacto, opcional)', type: 'text', placeholder: '{{email}}' },
      { key: 'source', label: 'Fuente (opcional)', type: 'text', placeholder: 'Ej. automatización' },
      { key: 'tags', label: 'Etiquetas iniciales', type: 'catalogTags', catalog: 'tags' },
      { key: 'assignedUser', label: 'Usuario asignado (opcional)', type: 'catalogSelect', catalog: 'users' },
      { key: 'customFields', label: 'Campos personalizados', type: 'keyValue' }
    ],
    outputs: () => SINGLE_OUTPUT,
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
        catalog: 'contactFields',
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
    defaultConfig: () => ({ field: '', fieldName: '', operation: 'replace', value: '' }),
    fields: [
      { key: 'field', label: 'Campo', type: 'catalogSelect', catalog: 'contactFields', required: true },
      {
        key: 'operation',
        label: 'Operación',
        type: 'select',
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
        showIf: (config) => str(config.operation) !== 'clear'
      }
    ],
    outputs: () => SINGLE_OUTPUT,
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
      text: str(config.tag) ? `Añade "${str(config.tag)}"` : undefined,
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
      text: str(config.tag) ? `Elimina "${str(config.tag)}"` : undefined,
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
    defaultConfig: () => ({ url: '', method: 'POST', headers: [], body: '', timeout: 15, onError: 'continue' }),
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
      { key: 'headers', label: 'Headers', type: 'keyValue' },
      { key: 'body', label: 'Body (JSON)', type: 'textarea', placeholder: '{\n  "telefono": "{{telefono}}"\n}', showVariables: true },
      { key: 'timeout', label: 'Timeout (segundos)', type: 'number', placeholder: '15' },
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
    description: 'Divide el flujo según datos reales del CRM',
    icon: Filter,
    accent: 'purple',
    tintedHeader: true,
    addButtonLabel: 'Agregar regla',
    configComponent: 'conditions',
    defaultConfig: () => ({ ...emptyConditionConfig() }),
    fields: [],
    outputs: () => [
      { id: 'yes', label: 'Sí' },
      { id: 'no', label: 'No' }
    ],
    validate: (config) => validateConditionRules(config),
    summary: (config) => ({
      text: summarizeCondition(config) || undefined,
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
      // fecha específica
      untilDate: '',
      timezone: '',
      useContactTimezone: false,
      // recurrente
      recurrence: 'weekly',
      weekdays: [],
      monthDay: 1,
      timeOfDay: '09:00',
      startDate: '',
      endDate: '',
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
      actionChannel: 'any',
      // condiciones
      conditions: emptyConditionConfig(),
      evaluation: 'continuous',
      // timeout compartido (respuesta/acción/condiciones)
      timeoutEnabled: false,
      timeoutAmount: 2,
      timeoutUnit: 'days',
      // ventana horaria
      windowEnabled: false,
      windowDays: [],
      windowStart: '09:00',
      windowEnd: '18:00',
      windowTimezone: '',
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

      if (mode === 'duration' && (Number(config.amount) || 0) <= 0) {
        errors.push('La duración debe ser mayor a cero')
      }
      if (mode === 'datetime' && !str(config.untilDate)) {
        errors.push('Selecciona la fecha y hora de espera')
      }
      if (mode === 'recurring') {
        if (str(config.recurrence) === 'weekly' && arr(config.weekdays).length === 0) {
          errors.push('Selecciona al menos un día de la semana')
        }
        if (!str(config.timeOfDay)) errors.push('Define la hora de continuación')
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
      if (mode === 'conditions') {
        errors.push(...validateConditionRules(config.conditions).map((error) => `Condición: ${error}`))
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
      const timeoutText = config.timeoutEnabled
        ? ` hasta ${durationLabel(Number(config.timeoutAmount) || 0, str(config.timeoutUnit) || 'days')}`
        : ''
      if (mode === 'duration') {
        return { text: `Espera ${durationLabel(Number(config.amount) || 0, str(config.unit) || 'hours')} y luego continúa` }
      }
      if (mode === 'datetime') {
        const until = str(config.untilDate)
        return { text: until ? `Espera hasta ${until.replace('T', ' ')}` : undefined, empty: 'Configura la espera' }
      }
      if (mode === 'recurring') {
        const recurrences: Record<string, string> = { daily: 'cada día', weekly: 'cada semana', monthly: 'cada mes' }
        return { text: `Continúa ${recurrences[str(config.recurrence)] || ''} a las ${str(config.timeOfDay) || '09:00'}` }
      }
      if (mode === 'appointment') {
        const offsets: Record<string, string> = { before: 'antes de', after: 'después de', at: 'al inicio de' }
        const offset = str(config.appointmentOffset) || 'before'
        const amount = offset === 'at' ? '' : `${durationLabel(Number(config.offsetAmount) || 0, str(config.offsetUnit) || 'hours')} `
        return { text: `Espera hasta ${amount}${offsets[offset]} la cita` }
      }
      if (mode === 'reply') {
        return { text: `Espera respuesta · ${channelLabel(str(config.replyChannel) || 'any')}${timeoutText}` }
      }
      if (mode === 'action') {
        const actions: Record<string, string> = {
          click_link: 'haga clic en un enlace',
          submit_form: 'envíe un formulario',
          purchase: 'realice un pago',
          book_appointment: 'agende una cita',
          reply_message: 'responda un mensaje',
          custom_event: 'dispare un evento personalizado'
        }
        return { text: `Espera a que ${actions[str(config.expectedAction)] || 'realice una acción'}${timeoutText}` }
      }
      if (mode === 'conditions') {
        const summary = summarizeCondition(config.conditions)
        return { text: `Espera hasta que ${summary || 'se cumpla una condición'}${timeoutText}` }
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
      if (!str(config.name).trim()) errors.push('Ponle nombre al objetivo')
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
          return `${operators[str(config.tagOperator)] || 'Tiene etiqueta'} ${str(config.tag)}`
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
        link: () => (str(config.linkEvent) === 'activation' ? 'Clic en enlace de activación' : 'Hizo clic en enlace'),
        conversation: () => `Respondió por ${channelLabel(str(config.conversationChannel) || 'any')}`,
        contact: () => 'Cambio en el contacto',
        ads: () => (str(config.adsEvent) === 'ctwa' ? 'Click to WhatsApp ads' : 'Clic en anuncio de Facebook'),
        custom: () => `Evento "${str(config.customEventName)}"`
      }
      const detail = summaries[goalType]?.()
      return {
        text: detail ? `Objetivo: ${detail}` : undefined,
        empty: 'Configura la meta de este objetivo'
      }
    }
  },
  {
    type: 'logic-split',
    kind: 'action',
    label: 'Dividir',
    category: 'action-logic',
    description: 'Crea múltiples ramas con nombre',
    icon: Split,
    accent: 'purple',
    tintedHeader: true,
    addButtonLabel: 'Agregar rama',
    defaultConfig: () => ({
      branches: [
        { id: 'branch-1', label: 'Rama 1' },
        { id: 'branch-2', label: 'Rama 2' }
      ]
    }),
    fields: [
      { key: 'branches', label: 'Ramas', type: 'branches', required: true }
    ],
    outputs: (config) =>
      arr<{ id?: unknown; label?: unknown }>(config.branches).map((branch, index) => ({
        id: str(branch.id) || `branch-${index + 1}`,
        label: str(branch.label) || `Rama ${index + 1}`
      })),
    validate: (config) => {
      const branches = arr<{ label?: unknown }>(config.branches)
      if (branches.length < 2) return ['Agrega al menos dos ramas']
      if (branches.some((branch) => !str(branch.label).trim())) return ['Ponle nombre a todas las ramas']
      return []
    },
    summary: (config) => ({ text: `${arr(config.branches).length} ramas` })
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
    type: 'logic-smart-pause',
    kind: 'action',
    label: 'Pausa inteligente',
    category: 'action-logic',
    description: 'Espera respetando una ventana horaria y días permitidos',
    icon: Timer,
    accent: 'coral',
    tintedHeader: true,
    addButtonLabel: 'Configurar pausa',
    defaultConfig: () => ({
      amount: 23,
      unit: 'hours',
      windowEnabled: false,
      windowDays: [],
      windowStart: '09:00',
      windowEnd: '18:00',
      timezone: ''
    }),
    fields: [
      { key: 'amount', label: 'Duración', type: 'duration' },
      { key: 'windowEnabled', label: 'Limitar a una ventana horaria', type: 'toggle' },
      {
        key: 'windowDays',
        label: 'Días permitidos',
        type: 'weekdays',
        showIf: (config) => Boolean(config.windowEnabled)
      },
      { key: 'windowStart', label: 'Desde', type: 'time', showIf: (config) => Boolean(config.windowEnabled) },
      { key: 'windowEnd', label: 'Hasta', type: 'time', showIf: (config) => Boolean(config.windowEnabled) },
      {
        key: 'timezone',
        label: 'Zona horaria (opcional)',
        type: 'text',
        placeholder: 'Zona horaria de la cuenta',
        showIf: (config) => Boolean(config.windowEnabled)
      }
    ],
    outputs: () => SINGLE_OUTPUT,
    validate: (config) => ((Number(config.amount) || 0) <= 0 ? ['La duración debe ser mayor a cero'] : []),
    summary: (config) => {
      const base = `Espera ${durationLabel(Number(config.amount) || 0, str(config.unit) || 'hours')} y luego continúa`
      return {
        text: config.windowEnabled
          ? `${base} (${str(config.windowStart) || '09:00'}–${str(config.windowEnd) || '18:00'})`
          : base
      }
    }
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
      saveAs: 'respuesta_ia'
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
      { key: 'saveAs', label: 'Guardar respuesta en variable', type: 'text', placeholder: 'respuesta_ia' }
    ],
    outputs: () => SINGLE_OUTPUT,
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
      saveAs: 'respuesta_ia'
    }),
    fields: [
      { key: 'model', label: 'Modelo', type: 'text', placeholder: 'gpt-4o-mini' },
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
      { key: 'saveAs', label: 'Guardar respuesta en variable', type: 'text', placeholder: 'respuesta_ia' }
    ],
    outputs: () => SINGLE_OUTPUT,
    summary: (config) => ({
      box: str(config.systemPrompt) || undefined,
      empty: 'Escribe el prompt del modelo'
    })
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

export const NODE_DEFINITIONS: NodeDefinition[] = [
  ...TRIGGERS,
  ...CHANNEL_NODES,
  ...CONTACT_ACTIONS,
  ...OTHER_ACTIONS
]

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
