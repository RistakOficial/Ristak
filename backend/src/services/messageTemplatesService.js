import crypto from 'crypto'
import { db, getAppConfig } from '../config/database.js'
import {
  createWhatsAppApiTemplate,
  deleteWhatsAppApiTemplate,
  deleteWhatsAppApiTemplateSnapshot,
  editWhatsAppApiTemplate,
  retrieveWhatsAppApiTemplate,
  sendWhatsAppApiTemplateMessage,
  syncWhatsAppApiTemplates,
  upsertWhatsAppApiTemplateSnapshot
} from './whatsappApiService.js'
import {
  WHATSAPP_PROVIDER_META_DIRECT,
  WHATSAPP_PROVIDER_YCLOUD,
  normalizeWhatsAppProvider
} from './whatsapp/providers/providerRegistry.js'
import { renderTemplateVariables } from './templateVariablesService.js'
import { logger } from '../utils/logger.js'
import { createRistakId } from '../utils/idGenerator.js'

const TEMPLATE_CATEGORIES = new Set(['utility', 'marketing', 'authentication', 'service'])
const TEMPLATE_STATUSES = new Set(['draft', 'active', 'archived'])
const HEADER_TYPES = new Set(['none', 'text', 'image', 'video', 'document', 'location'])
const BUTTON_TYPES = new Set(['quick_reply', 'website', 'phone', 'whatsapp_call'])
const VARIABLE_PATTERN = /{{\s*([a-zA-Z0-9_.-]+)\s*}}/g
const NUMERIC_VARIABLE_PATTERN = /{{\s*(\d+)\s*}}/g
const TEXT_VARIABLE_TARGETS = new Set(['headerText', 'bodyText'])
const BUTTON_VALUE_TARGET_PATTERN = /^buttons\.(\d+)\.value$/

const BASE_CONTACT_VARIABLES = [
  ['Full Name', 'contact.name', 'Jane Smith'],
  ['First Name', 'contact.first_name', 'Jane'],
  ['Last Name', 'contact.last_name', 'Smith'],
  ['Email', 'contact.email', 'jane@smith.com'],
  ['Phone', 'contact.phone', '(515) 555-2345'],
  ['Phone Raw Format', 'contact.phone_raw', '+15155552345'],
  ['Company Name', 'contact.company_name', 'Smith Plumbing'],
  ['Full Address', 'contact.full_address', '1234 W. Main St, Chicago, IL 60657'],
  ['Address Line 1', 'contact.address1', '1234 W. Main St'],
  ['City', 'contact.city', 'Chicago'],
  ['State/Region', 'contact.state', 'Illinois'],
  ['Postal Code', 'contact.postal_code', '60657'],
  ['Time Zone', 'contact.timezone', 'GMT-06:00 America/Chicago'],
  ['Date Of Birth', 'contact.date_of_birth', 'Jan 3, 1980'],
  ['Source', 'contact.source', 'Referral'],
  ['Website', 'contact.website', 'www.example.com'],
  ['Contact ID', 'contact.id', 'FZDn5mYlkZuCCQe5Bep8']
].map(([label, key, example]) => ({
  key,
  label,
  mergeField: `{{${key}}}`,
  example,
  group: 'Contacto',
  source: 'system'
}))

const BASE_APPOINTMENT_VARIABLES = [
  ['Título de cita', 'cita.titulo', 'Consulta inicial'],
  ['Fecha de cita', 'cita.fecha', 'viernes 19 de junio'],
  ['Hora de cita', 'cita.hora', '9:00'],
  ['Fecha y hora de cita', 'cita.fecha_hora', 'viernes, 19 de junio de 2026 9:00']
].map(([label, key, example]) => ({
  key,
  label,
  mergeField: `{{${key}}}`,
  example,
  group: 'Citas',
  source: 'system'
}))

const BASE_PAYMENT_VARIABLES = [
  ['ID del pago', 'payment.id', 'rstk_payment_3NfL8dZ9xQ2aB6mP7KcR'],
  ['ID publico del pago', 'payment.public_id', 'pay_3NfL8dZ9xQ2aB6mP'],
  ['Concepto del pago', 'payment.product', 'Plan mensual'],
  ['Monto del pago', 'payment.amount', '$1,499 MXN'],
  ['Moneda del pago', 'payment.currency', 'MXN'],
  ['Estado del pago', 'payment.status', 'Pendiente'],
  ['Metodo de pago', 'payment.method', 'Tarjeta'],
  ['Proveedor del pago', 'payment.provider', 'Stripe'],
  ['Referencia del pago', 'payment.receipt', 'REC-1048'],
  ['Numero de comprobante', 'payment.invoice_number', 'COMP-1048'],
  ['Fecha del pago', 'payment.date', '20 de junio de 2026'],
  ['URL de pago', 'payment.url', 'https://app.ristak.com/pay/pay_3NfL8dZ9xQ2aB6mP'],
  ['URL de comprobante', 'payment.receipt_url', 'https://app.ristak.com/pay/pay_3NfL8dZ9xQ2aB6mP?receipt=1'],
  ['Ruta dinamica de comprobante', 'payment.receipt_path', 'pay_3NfL8dZ9xQ2aB6mP?receipt=1']
].map(([label, key, example]) => ({
  key,
  label,
  mergeField: `{{${key}}}`,
  example,
  group: 'Pagos',
  source: 'system'
}))

const DEFAULT_APPOINTMENT_TEMPLATE_LANGUAGE = 'es_MX'
const DEFAULT_APPOINTMENT_TEMPLATE_FOLDER = {
  id: 'Reminders',
  name: 'Recordatorios'
}

const DEFAULT_PAYMENT_TEMPLATE_LANGUAGE = 'es_MX'
const DEFAULT_PAYMENT_TEMPLATE_FOLDER = {
  id: 'Payments',
  name: 'Pagos'
}
const DEFAULT_PAYMENT_TEMPLATE_NAME_LIST = [
  'recordatorio_pago_pendiente',
  'comprobante_pago_recibido',
  'pago_fallido_reintento'
]

const DEFAULT_APPOINTMENT_MESSAGE_TEMPLATES = [
  {
    name: 'cita_programada',
    description: 'Plantilla automática de Ristak para avisar cuando una cita queda agendada.',
    category: 'utility',
    language: DEFAULT_APPOINTMENT_TEMPLATE_LANGUAGE,
    status: 'active',
    headerEnabled: true,
    headerType: 'text',
    headerText: 'Cita programada para {{1}}',
    bodyText: 'Hola {{1}}.\n\nTu cita quedó agendada correctamente para la fecha y hora indicadas. Te esperamos. Si necesitas hacer algún cambio, avísanos con anticipación.\n\n¡Gracias!',
    footerText: '',
    buttons: [],
    variableExamples: {
      '{{cita.fecha_hora}}': 'viernes, 19 de junio de 2026 9:00',
      '{{contact.first_name}}': 'María'
    },
    variableBindings: {
      headerText: {
        1: {
          variableKey: 'cita.fecha_hora',
          mergeField: '{{cita.fecha_hora}}',
          label: 'Fecha y hora de cita',
          example: 'viernes, 19 de junio de 2026 9:00'
        }
      },
      bodyText: {
        1: {
          variableKey: 'contact.first_name',
          mergeField: '{{contact.first_name}}',
          label: 'Primer nombre',
          example: 'María'
        }
      }
    }
  },
  {
    name: 'recordatorio_cita_un_dia_antes',
    description: 'Plantilla automática de Ristak para recordar una cita un día antes.',
    category: 'utility',
    language: DEFAULT_APPOINTMENT_TEMPLATE_LANGUAGE,
    status: 'active',
    headerEnabled: false,
    headerType: 'none',
    headerText: '',
    bodyText: '*Recordatorio de cita* ⏰\nHola {{1}}, te recordamos que tienes una cita el {{2}} a las {{3}}. Recuerda estar al pendiente. 😄',
    footerText: 'Esto es un mensaje automático',
    buttons: [],
    variableExamples: {
      '{{contact.first_name}}': 'María',
      '{{cita.fecha}}': 'viernes 19 de junio',
      '{{cita.hora}}': '9:00'
    },
    variableBindings: {
      headerText: {},
      bodyText: {
        1: {
          variableKey: 'contact.first_name',
          mergeField: '{{contact.first_name}}',
          label: 'Primer nombre',
          example: 'María'
        },
        2: {
          variableKey: 'cita.fecha',
          mergeField: '{{cita.fecha}}',
          label: 'Fecha de cita',
          example: 'viernes 19 de junio'
        },
        3: {
          variableKey: 'cita.hora',
          mergeField: '{{cita.hora}}',
          label: 'Hora de cita',
          example: '9:00'
        }
      }
    }
  },
  {
    name: 'confirmacion_cita_dia_anterior',
    description: 'Plantilla automática de Ristak para confirmar asistencia un día antes de la cita.',
    category: 'utility',
    language: DEFAULT_APPOINTMENT_TEMPLATE_LANGUAGE,
    status: 'active',
    headerEnabled: false,
    headerType: 'none',
    headerText: '',
    bodyText: 'Hola {{1}}, queremos confirmar tu asistencia a la cita del {{2}} a las {{3}}. ¿Nos confirmas, por favor?',
    footerText: '',
    buttons: [],
    variableExamples: {
      '{{contact.first_name}}': 'María',
      '{{cita.fecha}}': 'viernes 19 de junio',
      '{{cita.hora}}': '12:00'
    },
    variableBindings: {
      headerText: {},
      bodyText: {
        1: {
          variableKey: 'contact.first_name',
          mergeField: '{{contact.first_name}}',
          label: 'Primer nombre',
          example: 'María'
        },
        2: {
          variableKey: 'cita.fecha',
          mergeField: '{{cita.fecha}}',
          label: 'Fecha de cita',
          example: 'viernes 19 de junio'
        },
        3: {
          variableKey: 'cita.hora',
          mergeField: '{{cita.hora}}',
          label: 'Hora de cita',
          example: '12:00'
        }
      }
    }
  }
]
const DEFAULT_APPOINTMENT_TEMPLATE_NAMES = new Set(DEFAULT_APPOINTMENT_MESSAGE_TEMPLATES.map(template => template.name))
const DEFAULT_APPOINTMENT_REVIEW_RETRY_TIMEOUT_MS = 6 * 60 * 60 * 1000
const DEFAULT_APPOINTMENT_REVIEW_MAX_RETRIES = 2
const DEFAULT_APPOINTMENT_REVIEW_RETRY_ALERT_TYPE = 'template_review_retry_exhausted'

function makeId(prefix) {
  return createRistakId(prefix)
}

function hashId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(String(value || crypto.randomUUID())).digest('hex').slice(0, 24)}`
}

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function normalizePublicBaseUrl(value = '') {
  const cleaned = cleanString(value).replace(/\/+$/, '')
  return /^https?:\/\//i.test(cleaned) ? cleaned : ''
}

function buildPaymentButtonUrlTemplate(publicBaseUrl = '') {
  const baseUrl = normalizePublicBaseUrl(publicBaseUrl)
  return baseUrl ? `${baseUrl}/pay/{{1}}` : '{{1}}'
}

function paymentButtonBinding({ hasPublicBaseUrl, receipt = false } = {}) {
  if (!hasPublicBaseUrl) {
    return {
      variableKey: receipt ? 'payment.receipt_url' : 'payment.url',
      mergeField: receipt ? '{{payment.receipt_url}}' : '{{payment.url}}',
      label: receipt ? 'URL de comprobante' : 'URL de pago',
      example: receipt
        ? 'https://app.ristak.com/pay/pay_3NfL8dZ9xQ2aB6mP?receipt=1'
        : 'https://app.ristak.com/pay/pay_3NfL8dZ9xQ2aB6mP'
    }
  }

  return {
    variableKey: receipt ? 'payment.receipt_path' : 'payment.public_id',
    mergeField: receipt ? '{{payment.receipt_path}}' : '{{payment.public_id}}',
    label: receipt ? 'Ruta dinamica de comprobante' : 'ID publico del pago',
    example: receipt ? 'pay_3NfL8dZ9xQ2aB6mP?receipt=1' : 'pay_3NfL8dZ9xQ2aB6mP'
  }
}

function getDefaultPaymentMessageTemplates({ publicBaseUrl = '' } = {}) {
  const buttonUrl = buildPaymentButtonUrlTemplate(publicBaseUrl)
  const hasPublicBaseUrl = Boolean(normalizePublicBaseUrl(publicBaseUrl))
  const payButtonBinding = paymentButtonBinding({ hasPublicBaseUrl })
  const receiptButtonBinding = paymentButtonBinding({ hasPublicBaseUrl, receipt: true })

  return [
    {
      name: 'recordatorio_pago_pendiente',
      description: 'Plantilla automática de Ristak para recordar un pago pendiente antes del cobro.',
      category: 'utility',
      language: DEFAULT_PAYMENT_TEMPLATE_LANGUAGE,
      status: 'active',
      headerEnabled: false,
      headerType: 'none',
      headerText: '',
      bodyText: '*Pago pendiente* ⏳\nHola {{1}}, tienes pendiente el pago de {{2}} por {{3}}. Toca el botón para realizarlo. 👇',
      footerText: 'Mensaje automático de Ristak',
      buttons: [
        {
          type: 'website',
          label: 'Realizar pago',
          value: buttonUrl
        }
      ],
      variableExamples: {
        '{{contact.first_name}}': 'Maria',
        '{{payment.product}}': 'Plan mensual',
        '{{payment.amount}}': '$1,499 MXN',
        '{{payment.public_id}}': 'pay_3NfL8dZ9xQ2aB6mP',
        '{{payment.url}}': 'https://app.ristak.com/pay/pay_3NfL8dZ9xQ2aB6mP'
      },
      variableBindings: {
        headerText: {},
        bodyText: {
          1: {
            variableKey: 'contact.first_name',
            mergeField: '{{contact.first_name}}',
            label: 'Primer nombre',
            example: 'Maria'
          },
          2: {
            variableKey: 'payment.product',
            mergeField: '{{payment.product}}',
            label: 'Concepto del pago',
            example: 'Plan mensual'
          },
          3: {
            variableKey: 'payment.amount',
            mergeField: '{{payment.amount}}',
            label: 'Monto del pago',
            example: '$1,499 MXN'
          }
        },
        'buttons.0.value': {
          1: payButtonBinding
        }
      }
    },
    {
      name: 'comprobante_pago_recibido',
      description: 'Plantilla automática de Ristak para enviar el comprobante descargable después del pago.',
      category: 'utility',
      language: DEFAULT_PAYMENT_TEMPLATE_LANGUAGE,
      status: 'active',
      headerEnabled: false,
      headerType: 'none',
      headerText: '',
      bodyText: '*Pago confirmado* ✅ \nHola {{1}}, recibimos tu pago de {{2}} por {{3}}. Gracias. Puedes descargar tu comprobante desde el botón. 👇',
      footerText: 'Mensaje automático de Ristak',
      buttons: [
        {
          type: 'website',
          label: 'Descargar comprobante',
          value: buttonUrl
        }
      ],
      variableExamples: {
        '{{contact.first_name}}': 'Maria',
        '{{payment.product}}': 'Plan mensual',
        '{{payment.amount}}': '$1,499 MXN',
        '{{payment.public_id}}': 'pay_3NfL8dZ9xQ2aB6mP',
        '{{payment.receipt_path}}': 'pay_3NfL8dZ9xQ2aB6mP?receipt=1',
        '{{payment.receipt_url}}': 'https://app.ristak.com/pay/pay_3NfL8dZ9xQ2aB6mP?receipt=1'
      },
      variableBindings: {
        headerText: {},
        bodyText: {
          1: {
            variableKey: 'contact.first_name',
            mergeField: '{{contact.first_name}}',
            label: 'Primer nombre',
            example: 'Maria'
          },
          2: {
            variableKey: 'payment.product',
            mergeField: '{{payment.product}}',
            label: 'Concepto del pago',
            example: 'Plan mensual'
          },
          3: {
            variableKey: 'payment.amount',
            mergeField: '{{payment.amount}}',
            label: 'Monto del pago',
            example: '$1,499 MXN'
          }
        },
        'buttons.0.value': {
          1: receiptButtonBinding
        }
      }
    },
    {
      name: 'pago_fallido_reintento',
      description: 'Plantilla automática de Ristak para avisar un cobro fallido y mandar al cliente al link correcto de pago.',
      category: 'utility',
      language: DEFAULT_PAYMENT_TEMPLATE_LANGUAGE,
      status: 'active',
      headerEnabled: false,
      headerType: 'none',
      headerText: '',
      bodyText: '❌ *Cobro fallido*\nHola {{1}}, no pudimos procesar tu pago de {{2}} por {{3}}. Puedes intentar nuevamente desde el botón.',
      footerText: 'Mensaje automático de Ristak',
      buttons: [
        {
          type: 'website',
          label: 'Reintentar pago',
          value: buttonUrl
        }
      ],
      variableExamples: {
        '{{contact.first_name}}': 'Maria',
        '{{payment.product}}': 'Plan mensual',
        '{{payment.amount}}': '$1,499 MXN',
        '{{payment.public_id}}': 'pay_3NfL8dZ9xQ2aB6mP',
        '{{payment.url}}': 'https://app.ristak.com/pay/pay_3NfL8dZ9xQ2aB6mP'
      },
      variableBindings: {
        headerText: {},
        bodyText: {
          1: {
            variableKey: 'contact.first_name',
            mergeField: '{{contact.first_name}}',
            label: 'Primer nombre',
            example: 'Maria'
          },
          2: {
            variableKey: 'payment.product',
            mergeField: '{{payment.product}}',
            label: 'Concepto del pago',
            example: 'Plan mensual'
          },
          3: {
            variableKey: 'payment.amount',
            mergeField: '{{payment.amount}}',
            label: 'Monto del pago',
            example: '$1,499 MXN'
          }
        },
        'buttons.0.value': {
          1: payButtonBinding
        }
      }
    }
  ]
}

function normalizeOptionalString(value) {
  const cleaned = cleanString(value)
  return cleaned || null
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function jsonString(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify(null)
  }
}

function normalizeKey(value) {
  return cleanString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
}

function normalizeTemplateName(value) {
  const normalized = normalizeKey(value)
  if (!normalized) {
    throw new Error('El nombre de la plantilla es obligatorio')
  }
  return normalized.slice(0, 80)
}

function normalizeFieldKey(value) {
  const normalized = normalizeKey(value)
  if (!normalized) {
    throw new Error('La llave del campo personalizado es obligatoria')
  }
  return normalized.slice(0, 80)
}

function normalizeCategory(value) {
  const category = normalizeKey(value)
  return TEMPLATE_CATEGORIES.has(category) ? category : 'utility'
}

function normalizeStatus(value) {
  const status = normalizeKey(value)
  return TEMPLATE_STATUSES.has(status) ? status : 'draft'
}

function normalizeHeaderType(value, enabled) {
  if (!enabled) return 'none'
  const headerType = normalizeKey(value)
  return HEADER_TYPES.has(headerType) ? headerType : 'text'
}

function normalizeLanguage(value) {
  const language = cleanString(value).replace('-', '_')
  return language || 'es_MX'
}

function clampText(value, maxLength) {
  const cleaned = cleanString(value)
  return cleaned.slice(0, maxLength)
}

function normalizeLocation(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    latitude: clampText(source.latitude, 40),
    longitude: clampText(source.longitude, 40),
    name: clampText(source.name, 80),
    address: clampText(source.address, 160)
  }
}

function normalizeButtons(value = []) {
  if (!Array.isArray(value)) return []

  return value
    .slice(0, 10)
    .map((button) => {
      const type = BUTTON_TYPES.has(cleanString(button?.type)) ? cleanString(button.type) : 'quick_reply'
      return {
        id: cleanString(button?.id) || makeId('tmpl_btn'),
        type,
        label: clampText(button?.label, 25),
        value: clampText(button?.value, type === 'website' ? 2048 : 80)
      }
    })
    .filter((button) => button.label)
}

function normalizeVariableExamples(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return Object.fromEntries(
    Object.entries(source)
      .map(([key, example]) => [cleanString(key), clampText(example, 140)])
      .filter(([key, example]) => key && example)
  )
}

function isSupportedVariableTarget(target) {
  const cleanTarget = cleanString(target)
  return TEXT_VARIABLE_TARGETS.has(cleanTarget) || BUTTON_VALUE_TARGET_PATTERN.test(cleanTarget)
}

function normalizeVariableBindings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const normalized = {}
  const targets = new Set(TEXT_VARIABLE_TARGETS)

  Object.keys(source).forEach((target) => {
    if (isSupportedVariableTarget(target)) targets.add(target)
  })

  for (const target of targets) {
    const targetSource = source[target] && typeof source[target] === 'object' && !Array.isArray(source[target])
      ? source[target]
      : {}
    const entries = {}

    for (const [index, binding] of Object.entries(targetSource)) {
      const variableIndex = cleanString(index).replace(/\D/g, '')
      if (!variableIndex) continue

      const bindingSource = binding && typeof binding === 'object' && !Array.isArray(binding) ? binding : {}
      entries[variableIndex] = {
        variableKey: clampText(bindingSource.variableKey, 120),
        mergeField: clampText(bindingSource.mergeField, 160),
        label: clampText(bindingSource.label, 120),
        example: clampText(bindingSource.example, 140)
      }
    }

    normalized[target] = entries
  }

  return normalized
}

function extractVariablesFromText(text, targetSet) {
  const content = cleanString(text)
  if (!content) return

  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    const key = cleanString(match[1])
    if (key) targetSet.add(`{{${key}}}`)
  }
}

function extractVariablesFromTemplate(template) {
  const variables = new Set()
  extractVariablesFromText(template.headerText, variables)
  extractVariablesFromText(template.bodyText, variables)
  extractVariablesFromText(template.footerText, variables)

  for (const button of template.buttons || []) {
    extractVariablesFromText(button.label, variables)
    extractVariablesFromText(button.value, variables)
  }

  return Array.from(variables).sort((a, b) => a.localeCompare(b))
}

function extractNumericVariableIndexes(text) {
  const indexes = new Set()
  const content = cleanString(text)
  if (!content) return []

  for (const match of content.matchAll(NUMERIC_VARIABLE_PATTERN)) {
    const index = Number(match[1])
    if (Number.isInteger(index) && index > 0) indexes.add(index)
  }

  return Array.from(indexes).sort((left, right) => left - right)
}

function normalizeTemplatePayload(payload = {}) {
  const headerEnabled = Boolean(payload.headerEnabled)
  const headerType = normalizeHeaderType(payload.headerType, headerEnabled)
  const headerText = headerType === 'text' ? clampText(payload.headerText, 60) : ''
  const headerMediaUrl = ['image', 'video', 'document'].includes(headerType)
    ? clampText(payload.headerMediaUrl, 2048)
    : ''
  const metaHeaderHandle = ['image', 'video', 'document'].includes(headerType)
    ? clampText(payload.metaHeaderHandle, 4096)
    : ''
  const headerLocation = headerType === 'location' ? normalizeLocation(payload.headerLocation) : normalizeLocation()
  const buttons = normalizeButtons(payload.buttons)

  const template = {
    folderId: normalizeOptionalString(payload.folderId),
    name: normalizeTemplateName(payload.name),
    description: clampText(payload.description, 240),
    category: normalizeCategory(payload.category),
    language: normalizeLanguage(payload.language),
    status: normalizeStatus(payload.status),
    headerEnabled: headerType !== 'none',
    headerType,
    headerText,
    headerMediaUrl,
    metaHeaderHandle,
    headerLocation,
    bodyText: clampText(payload.bodyText, 1024),
    footerText: clampText(payload.footerText, 60),
    buttons,
    variableExamples: normalizeVariableExamples(payload.variableExamples),
    variableBindings: normalizeVariableBindings(payload.variableBindings),
    ycloudTemplateName: normalizeOptionalString(payload.ycloudTemplateName),
    ycloudTemplateId: normalizeOptionalString(payload.ycloudTemplateId),
    ycloudStatus: normalizeOptionalString(payload.ycloudStatus)
  }

  if (!template.bodyText) {
    throw new Error('El cuerpo de la plantilla es obligatorio')
  }

  template.variables = extractVariablesFromTemplate(template)
  return template
}

function mapFolder(row) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id || null,
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapCustomField(row) {
  return {
    id: row.id,
    name: row.name,
    fieldKey: row.field_key,
    mergeField: row.merge_field,
    example: row.example || '',
    dataType: row.data_type || 'text',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapTemplate(row) {
  const templateProvider = normalizeWhatsAppProvider(row.template_provider || WHATSAPP_PROVIDER_YCLOUD)
  return {
    id: row.id,
    folderId: row.folder_id || null,
    name: row.name,
    description: row.description || '',
    category: row.category || 'utility',
    language: row.language || 'es_MX',
    status: row.status || 'draft',
    headerEnabled: Boolean(row.header_enabled),
    headerType: row.header_type || 'none',
    headerText: row.header_text || '',
    headerMediaUrl: row.header_media_url || '',
    metaHeaderHandle: row.meta_header_handle || '',
    headerLocation: parseJson(row.header_location_json, normalizeLocation()),
    bodyText: row.body_text || '',
    footerText: row.footer_text || '',
    buttons: parseJson(row.buttons_json, []),
    variables: parseJson(row.variables_json, []),
    variableExamples: parseJson(row.variable_examples_json, {}),
    variableBindings: parseJson(row.variable_bindings_json, { headerText: {}, bodyText: {} }),
    templateProvider,
    providerTemplateName: row.provider_template_name || null,
    providerTemplateId: row.provider_template_id || null,
    providerStatus: row.provider_status || null,
    providerReason: row.provider_reason || null,
    providerStatusUpdateEvent: row.provider_status_update_event || null,
    providerQualityRating: row.provider_quality_rating || null,
    providerRawPayload: parseJson(row.provider_raw_payload_json, null),
    providerSubmittedAt: row.provider_submitted_at || null,
    providerSyncedAt: row.provider_synced_at || null,
    ycloudTemplateName: row.ycloud_template_name || null,
    ycloudTemplateId: row.ycloud_template_id || null,
    ycloudStatus: row.ycloud_status || null,
    ycloudReason: row.ycloud_reason || null,
    ycloudStatusUpdateEvent: row.ycloud_status_update_event || null,
    ycloudQualityRating: row.ycloud_quality_rating || null,
    ycloudRawPayload: parseJson(row.ycloud_raw_payload_json, null),
    ycloudSubmittedAt: row.ycloud_submitted_at || null,
    ycloudSyncedAt: row.ycloud_synced_at || null,
    ycloudReviewRetryCount: Number(row.ycloud_review_retry_count || 0),
    ycloudReviewRetryLastAt: row.ycloud_review_retry_last_at || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function getBuiltinDefaultMessageTemplateForSend({ templateName, language, publicBaseUrl = '' } = {}) {
  const cleanTemplateName = cleanString(templateName)
  if (!cleanTemplateName) return null

  const cleanLanguage = cleanString(language)
  const defaults = [
    ...DEFAULT_APPOINTMENT_MESSAGE_TEMPLATES,
    ...getDefaultPaymentMessageTemplates({ publicBaseUrl })
  ]
  const template = defaults.find((item) => (
    item.name === cleanTemplateName &&
    (!cleanLanguage || item.language === cleanLanguage)
  ))
  if (!template) return null

  return {
    ...template,
    id: null,
    folderId: null
  }
}

function customFieldVariables(customFields = []) {
  return customFields.map((field) => ({
    key: `contact.custom.${field.fieldKey}`,
    label: field.name,
    mergeField: field.mergeField,
    example: field.example || field.name,
    group: 'Campos personalizados',
    source: 'custom',
    fieldKey: field.fieldKey
  }))
}

function buildCatalog(customFields = []) {
  return [
    ...BASE_CONTACT_VARIABLES,
    ...BASE_APPOINTMENT_VARIABLES,
    ...BASE_PAYMENT_VARIABLES,
    ...customFieldVariables(customFields)
  ]
}

function getVariableLookup(catalog = []) {
  return new Map(catalog.map((variable) => [variable.mergeField, variable]))
}

function resolveText(text, variableExamples = {}, catalog = []) {
  const lookup = getVariableLookup(catalog)
  return cleanString(text).replace(VARIABLE_PATTERN, (fullMatch, key) => {
    const mergeField = `{{${key}}}`
    return variableExamples[mergeField] ||
      variableExamples[key] ||
      lookup.get(mergeField)?.example ||
      fullMatch
  })
}

async function assertFolderExists(folderId) {
  if (!folderId) return
  const folder = await db.get('SELECT id FROM whatsapp_template_folders WHERE id = ?', [folderId])
  if (!folder) throw new Error('La carpeta seleccionada no existe')
}

export async function getMessageTemplateBundle() {
  const [folderRows, templateRows, customFieldRows] = await Promise.all([
    db.all('SELECT * FROM whatsapp_template_folders ORDER BY sort_order ASC, name ASC'),
    db.all('SELECT * FROM whatsapp_message_templates ORDER BY updated_at DESC, name ASC'),
    db.all('SELECT * FROM whatsapp_template_custom_fields ORDER BY name ASC')
  ])

  const folders = folderRows.map(mapFolder)
  const templates = templateRows.map(mapTemplate)
  const customFields = customFieldRows.map(mapCustomField)
  const variables = buildCatalog(customFields)

  return { folders, templates, customFields, variables }
}

export async function getVariableCatalog() {
  const rows = await db.all('SELECT * FROM whatsapp_template_custom_fields ORDER BY name ASC')
  return buildCatalog(rows.map(mapCustomField))
}

export async function previewMessageTemplate(payload = {}) {
  const normalized = normalizeTemplatePayload({
    ...payload,
    name: payload.name || 'preview_template',
    bodyText: payload.bodyText || 'Mensaje de ejemplo'
  })
  const variables = await getVariableCatalog()

  return {
    header: resolveText(normalized.headerText, normalized.variableExamples, variables),
    body: resolveText(normalized.bodyText, normalized.variableExamples, variables),
    footer: resolveText(normalized.footerText, normalized.variableExamples, variables),
    buttons: normalized.buttons.map((button) => ({
      ...button,
      label: resolveText(button.label, normalized.variableExamples, variables),
      value: resolveText(button.value, normalized.variableExamples, variables)
    })),
    variablesUsed: normalized.variables
  }
}

function getTemplateErrorMessage(error, fallback) {
  const ycloudError = error?.ycloud?.error || error?.ycloud
  const metaError = error?.metaDirect?.error || error?.metaDirect
  return cleanString(
    ycloudError?.error_user_msg ||
    ycloudError?.error_data ||
    ycloudError?.message ||
    metaError?.error_user_msg ||
    metaError?.message ||
    error?.message
  ) || fallback
}

function normalizeProviderTemplateStatus(value) {
  const status = cleanString(value).toUpperCase()
  return status || null
}

const TEMPLATE_LOCKED_REVIEW_STATES = new Set(['PENDING', 'IN_APPEAL', 'IN_REVIEW', 'UNDER_REVIEW', 'PENDING_REVIEW'])
const TEMPLATE_PROVIDER_EDITABLE_STATES = new Set(['APPROVED', 'REJECTED', 'PAUSED'])

function isTemplateLockedForEditing(status) {
  return TEMPLATE_LOCKED_REVIEW_STATES.has(normalizeProviderTemplateStatus(status))
}

function stableJson(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize)
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, normalize(input[key])])
      )
    }
    return input
  }

  return JSON.stringify(normalize(value ?? null))
}

function normalizeProviderTemplateCategory(category) {
  const normalized = normalizeCategory(category).toUpperCase()
  if (normalized === 'SERVICE') return 'UTILITY'
  return normalized
}

function getYCloudTemplateName(template = {}) {
  const raw = template.ycloudRawPayload && typeof template.ycloudRawPayload === 'object'
    ? template.ycloudRawPayload
    : {}
  return cleanString(template.ycloudTemplateName || raw.name || template.name)
}

async function getActiveTemplateProvider() {
  return normalizeWhatsAppProvider(await getAppConfig('whatsapp_api_provider'), WHATSAPP_PROVIDER_YCLOUD)
}

function getTemplateProviderLabel(provider) {
  return normalizeWhatsAppProvider(provider, WHATSAPP_PROVIDER_YCLOUD) === WHATSAPP_PROVIDER_META_DIRECT
    ? 'WhatsApp API con Meta'
    : 'YCloud'
}

export function getMessageTemplateProviderState(template = {}, provider = template.templateProvider) {
  const targetProvider = normalizeWhatsAppProvider(provider, WHATSAPP_PROVIDER_YCLOUD)
  const ownerProvider = normalizeWhatsAppProvider(template.templateProvider, WHATSAPP_PROVIDER_YCLOUD)
  const neutralOwnedByTarget = ownerProvider === targetProvider
  const providerRaw = neutralOwnedByTarget && template.providerRawPayload && typeof template.providerRawPayload === 'object'
    ? template.providerRawPayload
    : {}

  if (targetProvider === WHATSAPP_PROVIDER_META_DIRECT) {
    return {
      provider: targetProvider,
      name: cleanString(neutralOwnedByTarget ? template.providerTemplateName : '') || cleanString(template.name),
      templateId: cleanString(neutralOwnedByTarget ? template.providerTemplateId : ''),
      status: normalizeProviderTemplateStatus(neutralOwnedByTarget ? template.providerStatus : ''),
      reason: cleanString(neutralOwnedByTarget ? template.providerReason : '') || null,
      statusUpdateEvent: normalizeProviderTemplateStatus(neutralOwnedByTarget ? template.providerStatusUpdateEvent : ''),
      qualityRating: normalizeProviderTemplateStatus(neutralOwnedByTarget ? template.providerQualityRating : ''),
      submittedAt: cleanString(neutralOwnedByTarget ? template.providerSubmittedAt : '') || null,
      syncedAt: cleanString(neutralOwnedByTarget ? template.providerSyncedAt : '') || null,
      rawPayload: providerRaw
    }
  }

  const ycloudRaw = template.ycloudRawPayload && typeof template.ycloudRawPayload === 'object'
    ? template.ycloudRawPayload
    : {}
  return {
    provider: targetProvider,
    name: cleanString(
      (neutralOwnedByTarget ? template.providerTemplateName : '') ||
      template.ycloudTemplateName ||
      ycloudRaw.name ||
      template.name
    ),
    templateId: cleanString(
      (neutralOwnedByTarget ? template.providerTemplateId : '') ||
      template.ycloudTemplateId ||
      ycloudRaw.officialTemplateId ||
      ycloudRaw.id
    ),
    status: normalizeProviderTemplateStatus(
      (neutralOwnedByTarget ? template.providerStatus : '') || template.ycloudStatus
    ),
    reason: cleanString((neutralOwnedByTarget ? template.providerReason : '') || template.ycloudReason) || null,
    statusUpdateEvent: normalizeProviderTemplateStatus(
      (neutralOwnedByTarget ? template.providerStatusUpdateEvent : '') || template.ycloudStatusUpdateEvent
    ),
    qualityRating: normalizeProviderTemplateStatus(
      (neutralOwnedByTarget ? template.providerQualityRating : '') || template.ycloudQualityRating
    ),
    submittedAt: cleanString((neutralOwnedByTarget ? template.providerSubmittedAt : '') || template.ycloudSubmittedAt) || null,
    syncedAt: cleanString((neutralOwnedByTarget ? template.providerSyncedAt : '') || template.ycloudSyncedAt) || null,
    rawPayload: Object.keys(providerRaw).length ? providerRaw : ycloudRaw
  }
}

function getTemplateProviderIdentity(template = {}, provider = template.templateProvider) {
  const state = getMessageTemplateProviderState(template, provider)
  const raw = state.rawPayload
  return {
    wabaId: cleanString(raw.wabaId || raw.waba_id),
    providerTemplateId: state.templateId,
    officialTemplateId: state.templateId
  }
}

function hasTemplateProviderFootprint(template = {}, provider = WHATSAPP_PROVIDER_YCLOUD) {
  const state = getMessageTemplateProviderState(template, provider)
  return Boolean(
    state.templateId ||
    state.status ||
    state.submittedAt ||
    Object.keys(state.rawPayload).length
  )
}

function shouldEditExistingProviderTemplate(template = {}, provider = WHATSAPP_PROVIDER_YCLOUD) {
  if (!hasTemplateProviderFootprint(template, provider)) return false
  const status = getMessageTemplateProviderState(template, provider).status
  if (isTemplateLockedForEditing(status)) {
    throw new Error(`Esta plantilla ya está en revisión con ${getTemplateProviderLabel(provider)}. Espera el resultado antes de reenviarla.`)
  }
  if (status === 'ARCHIVED') {
    throw new Error(`Esta plantilla está archivada en ${getTemplateProviderLabel(provider)} y no se puede editar. Crea una nueva con otro nombre.`)
  }
  if (status && !TEMPLATE_PROVIDER_EDITABLE_STATES.has(status)) {
    throw new Error(`Esta plantilla está en estado ${status} en ${getTemplateProviderLabel(provider)} y no se puede editar. Crea una nueva con otro nombre.`)
  }
  return true
}

function isYCloudTemplateAlreadyExistsError(error) {
  const text = [
    error?.message,
    error?.ycloud?.message,
    error?.ycloud?.error?.message,
    error?.ycloud?.error?.error_user_msg,
    error?.ycloud?.error?.error_data,
    stableJson(error?.ycloud || {})
  ].filter(Boolean).join(' ').toLowerCase()

  return text.includes('already exists') || text.includes('ya existe')
}

function getButtonValueTarget(index) {
  return `buttons.${index}.value`
}

function getTemplateTextForTarget(template = {}, target = '') {
  const match = cleanString(target).match(BUTTON_VALUE_TARGET_PATTERN)
  if (match) {
    const index = Number(match[1])
    return template.buttons?.[index]?.value || ''
  }
  return template[target]
}

function assertMetaVariableSyntax(text, label) {
  const content = cleanString(text)
  if (!content) return

  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    const key = cleanString(match[1])
    if (!/^\d+$/.test(key)) {
      throw new Error(`${label} usa ${match[0]}. Para plantillas oficiales de WhatsApp las variables deben ser {{1}}, {{2}}, {{3}}.`)
    }
  }
}

function getVariableExamplesForTarget(template, target, label) {
  const indexes = extractNumericVariableIndexes(getTemplateTextForTarget(template, target))
  if (!indexes.length) return []

  indexes.forEach((index, position) => {
    if (index !== position + 1) {
      throw new Error(`${label} debe usar variables consecutivas empezando en {{1}}. Revisa {{${index}}}.`)
    }
  })

  const bindings = template.variableBindings?.[target] || {}
  return indexes.map((index) => {
    const binding = bindings[String(index)] || {}
    if (!cleanString(binding.variableKey) && !cleanString(binding.mergeField)) {
      throw new Error(`Selecciona el dato dinamico para {{${index}}} en ${label}.`)
    }
    if (!cleanString(binding.example)) {
      throw new Error(`Escribe el ejemplo que Meta revisara para {{${index}}} en ${label}.`)
    }
    return cleanString(binding.example)
  })
}

function buildMetaTemplateButtons(template = {}) {
  const buttons = Array.isArray(template.buttons) ? template.buttons : []
  return buttons.map((button, index) => {
    const label = clampText(button.label, 25)
    if (!label) return null

    if (button.type === 'website') {
      const url = clampText(button.value, 2000)
      if (!url) throw new Error(`El botón ${label} necesita URL`)
      assertMetaVariableSyntax(url, `La URL del botón ${label}`)
      const examples = getVariableExamplesForTarget(template, getButtonValueTarget(index), `la URL del botón ${label}`)
      if (examples.length > 1) {
        throw new Error(`La URL del botón ${label} solo puede usar una variable.`)
      }
      return {
        type: 'URL',
        text: label,
        url,
        ...(examples.length ? { example: examples } : {})
      }
    }

    if (button.type === 'phone') {
      const phoneNumber = clampText(button.value, 20)
      if (!phoneNumber) throw new Error(`El botón ${label} necesita teléfono`)
      return { type: 'PHONE_NUMBER', text: label, phone_number: phoneNumber }
    }

    if (button.type === 'whatsapp_call') {
      return { type: 'VOICE_CALL', text: label }
    }

    return { type: 'QUICK_REPLY', text: label }
  }).filter(Boolean)
}

const TEMPLATE_REVIEW_LOCK_FIELDS = [
  'name',
  'description',
  'category',
  'language',
  'status',
  'headerEnabled',
  'headerType',
  'headerText',
  'headerMediaUrl',
  'metaHeaderHandle',
  'headerLocation',
  'bodyText',
  'footerText',
  'buttons',
  'variableExamples',
  'variableBindings'
]

function assertTemplateReviewLockAllowsUpdate(existingRow, nextTemplate) {
  const mappedExistingTemplate = mapTemplate(existingRow)
  const providerState = getMessageTemplateProviderState(mappedExistingTemplate)
  if (!isTemplateLockedForEditing(providerState.status)) return

  const existingTemplate = normalizeTemplatePayload(mappedExistingTemplate)
  const changedLockedField = TEMPLATE_REVIEW_LOCK_FIELDS.some((field) => (
    stableJson(existingTemplate[field]) !== stableJson(nextTemplate[field])
  ))

  if (!changedLockedField) return

  const error = new Error('Esta plantilla está en revisión. Espera la respuesta de Meta antes de editarla otra vez.')
  error.statusCode = 409
  throw error
}

function buildProviderTemplatePayload(template, provider = template.templateProvider) {
  assertMetaVariableSyntax(template.headerText, 'El encabezado')
  assertMetaVariableSyntax(template.bodyText, 'El cuerpo')

  const components = []

  if (template.headerEnabled && template.headerType !== 'none') {
    if (template.headerType === 'text') {
      if (!cleanString(template.headerText)) {
        throw new Error('Escribe el texto del encabezado o apaga el encabezado de la plantilla.')
      }

      const headerExamples = getVariableExamplesForTarget(template, 'headerText', 'el encabezado')
      if (headerExamples.length > 1) {
        throw new Error('Meta solo permite una variable en el encabezado de texto.')
      }

      const headerComponent = {
        type: 'HEADER',
        format: 'TEXT',
        text: template.headerText
      }
      if (headerExamples.length) {
        headerComponent.example = { header_text: headerExamples }
      }
      components.push(headerComponent)
    } else if (['image', 'video', 'document'].includes(template.headerType)) {
      if (!template.headerMediaUrl && !template.metaHeaderHandle) {
        throw new Error('Agrega una URL de ejemplo para el archivo del encabezado.')
      }
      components.push({
        type: 'HEADER',
        format: template.headerType.toUpperCase(),
        example: template.metaHeaderHandle
          ? { header_handle: [template.metaHeaderHandle] }
          : { header_url: [template.headerMediaUrl] }
      })
    } else if (template.headerType === 'location') {
      components.push({
        type: 'HEADER',
        format: 'LOCATION'
      })
    }
  }

  const bodyExamples = getVariableExamplesForTarget(template, 'bodyText', 'el cuerpo')
  const bodyComponent = {
    type: 'BODY',
    text: template.bodyText
  }
  if (bodyExamples.length) {
    bodyComponent.example = { body_text: [bodyExamples] }
  }
  components.push(bodyComponent)

  if (template.footerText) {
    components.push({
      type: 'FOOTER',
      text: template.footerText
    })
  }

  const buttons = buildMetaTemplateButtons(template)
  if (buttons.length) {
    components.push({
      type: 'BUTTONS',
      buttons
    })
  }

  return {
    name: getMessageTemplateProviderState(template, provider).name,
    language: template.language,
    category: normalizeProviderTemplateCategory(template.category),
    components
  }
}

function buildSnapshotButtons(buttons = []) {
  return buttons.map((button) => {
    const type = cleanString(button?.type)
    const label = clampText(button?.label || button?.text, 25)
    const value = cleanString(button?.value)
    if (!label) return null

    if (type === 'website') return { type: 'URL', text: label, url: value }
    if (type === 'phone') return { type: 'PHONE_NUMBER', text: label, phone_number: value }
    if (type === 'whatsapp_call') return { type: 'VOICE_CALL', text: label }
    return { type: 'QUICK_REPLY', text: label }
  }).filter(Boolean)
}

function buildSnapshotComponents(template) {
  const components = []

  if (template.headerEnabled && template.headerType !== 'none') {
    if (template.headerType === 'text' && template.headerText) {
      components.push({
        type: 'HEADER',
        format: 'TEXT',
        text: template.headerText
      })
    } else if (['image', 'video', 'document'].includes(template.headerType)) {
      components.push({
        type: 'HEADER',
        format: template.headerType.toUpperCase()
      })
    } else if (template.headerType === 'location') {
      components.push({
        type: 'HEADER',
        format: 'LOCATION'
      })
    }
  }

  components.push({
    type: 'BODY',
    text: template.bodyText
  })

  if (template.footerText) {
    components.push({
      type: 'FOOTER',
      text: template.footerText
    })
  }

  const buttons = buildSnapshotButtons(template.buttons)
  if (buttons.length) {
    components.push({
      type: 'BUTTONS',
      buttons
    })
  }

  return components
}

function buildWhatsAppApiSnapshot(template) {
  const provider = normalizeWhatsAppProvider(template.templateProvider, WHATSAPP_PROVIDER_YCLOUD)
  const providerState = getMessageTemplateProviderState(template, provider)
  const raw = providerState.rawPayload
  const officialTemplateId = providerState.templateId
  const components = buildSnapshotComponents(template)

  return {
    id: officialTemplateId || template.id,
    officialTemplateId,
    providerTemplateId: officialTemplateId,
    provider,
    wabaId: cleanString(raw.wabaId || raw.waba_id),
    name: providerState.name,
    language: template.language,
    category: normalizeProviderTemplateCategory(template.category),
    status: providerState.status || normalizeProviderTemplateStatus(template.status),
    qualityRating: providerState.qualityRating,
    reason: providerState.reason,
    statusUpdateEvent: providerState.statusUpdateEvent,
    components,
    raw: {
      ...raw,
      localTemplateId: template.id,
      localTemplateName: template.name,
      source: 'ristak_message_template',
      components
    }
  }
}

async function persistWhatsAppApiSnapshot(template) {
  if (!template?.name || !template?.language || !template?.bodyText) return null

  try {
    return await upsertWhatsAppApiTemplateSnapshot(buildWhatsAppApiSnapshot(template))
  } catch (error) {
    logger.warn(`No se pudo guardar snapshot WhatsApp API de plantilla ${template.name}/${template.language}: ${error.message}`)
    return null
  }
}

export async function syncLocalMessageTemplateSnapshots({ onlyApproved = false } = {}) {
  const rows = await db.all(`
    SELECT * FROM whatsapp_message_templates
    ${onlyApproved ? "WHERE UPPER(COALESCE(provider_status, CASE WHEN template_provider = 'ycloud' THEN ycloud_status END, '')) = 'APPROVED'" : ''}
    ORDER BY updated_at DESC
  `)
  let synced = 0

  for (const row of rows) {
    const snapshotId = await persistWhatsAppApiSnapshot(mapTemplate(row))
    if (snapshotId) synced += 1
  }

  return { synced }
}

function normalizeProviderTemplateResponse(record = {}) {
  return {
    officialTemplateId: cleanString(record.officialTemplateId || record.id) || null,
    name: cleanString(record.name) || null,
    status: normalizeProviderTemplateStatus(record.status),
    reason: cleanString(record.reason || record.whatsappApiError?.error_user_msg || record.whatsappApiError?.message || record.whatsappApiError?.error_data) || null,
    statusUpdateEvent: normalizeProviderTemplateStatus(record.statusUpdateEvent),
    qualityRating: normalizeProviderTemplateStatus(record.qualityRating),
    raw: record
  }
}

async function getMessageTemplateById(id) {
  const row = await db.get('SELECT * FROM whatsapp_message_templates WHERE id = ?', [id])
  if (!row) {
    const error = new Error('Plantilla no encontrada')
    error.statusCode = 404
    throw error
  }
  return mapTemplate(row)
}

async function applyProviderTemplateResponse(id, record = {}, { submitted = false, provider = WHATSAPP_PROVIDER_YCLOUD } = {}) {
  const normalized = normalizeProviderTemplateResponse(record)
  const nextStatus = normalized.status || (submitted ? 'PENDING' : null)
  const cleanProvider = normalizeWhatsAppProvider(record.provider || provider, WHATSAPP_PROVIDER_YCLOUD)
  const isYCloud = cleanProvider === WHATSAPP_PROVIDER_YCLOUD
  await db.run(`
    UPDATE whatsapp_message_templates
    SET
      template_provider = ?,
      provider_template_id = COALESCE(?, provider_template_id),
      provider_template_name = COALESCE(?, provider_template_name),
      provider_status = COALESCE(?, provider_status),
      provider_reason = ?,
      provider_status_update_event = ?,
      provider_quality_rating = ?,
      provider_raw_payload_json = ?,
      provider_submitted_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE provider_submitted_at END,
      provider_synced_at = CURRENT_TIMESTAMP,
      ycloud_template_id = CASE WHEN ? = 1 THEN COALESCE(?, ycloud_template_id) ELSE ycloud_template_id END,
      ycloud_template_name = CASE WHEN ? = 1 THEN COALESCE(?, ycloud_template_name) ELSE ycloud_template_name END,
      ycloud_status = CASE WHEN ? = 1 THEN COALESCE(?, ycloud_status) ELSE ycloud_status END,
      ycloud_reason = CASE WHEN ? = 1 THEN ? ELSE ycloud_reason END,
      ycloud_status_update_event = CASE WHEN ? = 1 THEN ? ELSE ycloud_status_update_event END,
      ycloud_quality_rating = CASE WHEN ? = 1 THEN ? ELSE ycloud_quality_rating END,
      ycloud_raw_payload_json = CASE WHEN ? = 1 THEN ? ELSE ycloud_raw_payload_json END,
      ycloud_submitted_at = CASE WHEN ? = 1 AND ? = 1 THEN CURRENT_TIMESTAMP ELSE ycloud_submitted_at END,
      ycloud_synced_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE ycloud_synced_at END,
      last_error = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    cleanProvider,
    normalized.officialTemplateId,
    normalized.name,
    nextStatus,
    normalized.reason,
    normalized.statusUpdateEvent,
    normalized.qualityRating,
    jsonString(normalized.raw),
    submitted ? 1 : 0,
    isYCloud ? 1 : 0,
    normalized.officialTemplateId,
    isYCloud ? 1 : 0,
    normalized.name,
    isYCloud ? 1 : 0,
    nextStatus,
    isYCloud ? 1 : 0,
    normalized.reason,
    isYCloud ? 1 : 0,
    normalized.statusUpdateEvent,
    isYCloud ? 1 : 0,
    normalized.qualityRating,
    isYCloud ? 1 : 0,
    jsonString(normalized.raw),
    isYCloud ? 1 : 0,
    submitted ? 1 : 0,
    isYCloud ? 1 : 0,
    id
  ])

  const updated = await getMessageTemplateById(id)
  await persistWhatsAppApiSnapshot(updated)
  return updated
}

async function saveTemplateLastError(id, error) {
  const message = getTemplateErrorMessage(error, 'El proveedor de WhatsApp rechazó la solicitud')
  await db.run(`
    UPDATE whatsapp_message_templates
    SET last_error = ?, provider_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [message, id])
  return message
}

export async function createMessageTemplate(payload = {}) {
  const template = normalizeTemplatePayload(payload)
  await assertFolderExists(template.folderId)
  const id = makeId('tmpl')
  const templateProvider = await getActiveTemplateProvider()
  const isYCloud = templateProvider === WHATSAPP_PROVIDER_YCLOUD
  const providerTemplateName = isYCloud ? template.ycloudTemplateName : null
  const providerTemplateId = isYCloud ? template.ycloudTemplateId : null
  const providerStatus = isYCloud ? template.ycloudStatus : null

  try {
    await db.run(`
      INSERT INTO whatsapp_message_templates (
        id, folder_id, name, description, category, language, status,
        header_enabled, header_type, header_text, header_media_url, meta_header_handle, header_location_json,
        body_text, footer_text, buttons_json, variables_json, variable_examples_json,
        variable_bindings_json, template_provider,
        provider_template_name, provider_template_id, provider_status,
        ycloud_template_name, ycloud_template_id, ycloud_status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      id,
      template.folderId,
      template.name,
      template.description,
      template.category,
      template.language,
      template.status,
      template.headerEnabled ? 1 : 0,
      template.headerType,
      template.headerText,
      template.headerMediaUrl,
      template.metaHeaderHandle,
      jsonString(template.headerLocation),
      template.bodyText,
      template.footerText,
      jsonString(template.buttons),
      jsonString(template.variables),
      jsonString(template.variableExamples),
      jsonString(template.variableBindings),
      templateProvider,
      providerTemplateName,
      providerTemplateId,
      providerStatus,
      isYCloud ? template.ycloudTemplateName : null,
      isYCloud ? template.ycloudTemplateId : null,
      isYCloud ? template.ycloudStatus : null
    ])
  } catch (error) {
    if (error.message?.includes('UNIQUE') || error.message?.includes('unique')) {
      throw new Error('Ya existe una plantilla con ese nombre')
    }
    throw error
  }

  const row = await db.get('SELECT * FROM whatsapp_message_templates WHERE id = ?', [id])
  const saved = mapTemplate(row)
  await persistWhatsAppApiSnapshot(saved)
  return saved
}

export async function updateMessageTemplate(id, payload = {}) {
  const existing = await db.get('SELECT * FROM whatsapp_message_templates WHERE id = ?', [id])
  if (!existing) {
    const error = new Error('Plantilla no encontrada')
    error.statusCode = 404
    throw error
  }

  const template = normalizeTemplatePayload({
    ...payload,
    ycloudTemplateName: payload.ycloudTemplateName ?? existing.ycloud_template_name,
    ycloudTemplateId: payload.ycloudTemplateId ?? existing.ycloud_template_id,
    ycloudStatus: payload.ycloudStatus ?? existing.ycloud_status
  })
  assertTemplateReviewLockAllowsUpdate(existing, template)
  await assertFolderExists(template.folderId)

  try {
    await db.run(`
      UPDATE whatsapp_message_templates SET
        folder_id = ?,
        name = ?,
        description = ?,
        category = ?,
        language = ?,
        status = ?,
        header_enabled = ?,
        header_type = ?,
        header_text = ?,
        header_media_url = ?,
        meta_header_handle = ?,
        header_location_json = ?,
        body_text = ?,
        footer_text = ?,
        buttons_json = ?,
        variables_json = ?,
        variable_examples_json = ?,
        variable_bindings_json = ?,
        ycloud_template_name = ?,
        ycloud_template_id = ?,
        ycloud_status = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      template.folderId,
      template.name,
      template.description,
      template.category,
      template.language,
      template.status,
      template.headerEnabled ? 1 : 0,
      template.headerType,
      template.headerText,
      template.headerMediaUrl,
      template.metaHeaderHandle,
      jsonString(template.headerLocation),
      template.bodyText,
      template.footerText,
      jsonString(template.buttons),
      jsonString(template.variables),
      jsonString(template.variableExamples),
      jsonString(template.variableBindings),
      template.ycloudTemplateName,
      template.ycloudTemplateId,
      template.ycloudStatus,
      id
    ])
  } catch (error) {
    if (error.message?.includes('UNIQUE') || error.message?.includes('unique')) {
      throw new Error('Ya existe una plantilla con ese nombre')
    }
    throw error
  }

  const row = await db.get('SELECT * FROM whatsapp_message_templates WHERE id = ?', [id])
  const saved = mapTemplate(row)
  await persistWhatsAppApiSnapshot(saved)
  return saved
}

async function findMessageTemplateByNameLanguage(name, language) {
  const row = await db.get(
    'SELECT * FROM whatsapp_message_templates WHERE name = ? AND language = ?',
    [name, language]
  )
  return row ? mapTemplate(row) : null
}

function comparableDefaultTemplate(template = {}) {
  const buttons = Array.isArray(template.buttons) ? template.buttons : []
  return {
    folderId: normalizeOptionalString(template.folderId),
    description: clampText(template.description, 240),
    category: normalizeCategory(template.category),
    language: normalizeLanguage(template.language),
    status: normalizeStatus(template.status),
    headerEnabled: Boolean(template.headerEnabled),
    headerType: normalizeHeaderType(template.headerType, Boolean(template.headerEnabled)),
    headerText: clampText(template.headerText, 60),
    headerMediaUrl: clampText(template.headerMediaUrl, 2048),
    headerLocation: normalizeLocation(template.headerLocation),
    bodyText: clampText(template.bodyText, 1024),
    footerText: clampText(template.footerText, 60),
    buttons: buttons.map((button) => ({
      type: cleanString(button?.type),
      label: clampText(button?.label, 25),
      value: clampText(button?.value, cleanString(button?.type) === 'website' ? 2048 : 80)
    })),
    variableExamples: normalizeVariableExamples(template.variableExamples),
    variableBindings: normalizeVariableBindings(template.variableBindings)
  }
}

function shouldRefreshDefaultMessageTemplate(existing, definition, folderId) {
  const desired = normalizeTemplatePayload({
    ...definition,
    folderId,
    name: normalizeTemplateName(definition.name),
    language: normalizeLanguage(definition.language)
  })

  return stableJson(comparableDefaultTemplate(existing)) !== stableJson(comparableDefaultTemplate(desired))
}

async function ensureTemplateFolder(folderDefinition, sortOrder = -100) {
  const existing = await db.get(
    'SELECT * FROM whatsapp_template_folders WHERE id = ?',
    [folderDefinition.id]
  )

  if (existing) {
    if (existing.name !== folderDefinition.name || existing.parent_id) {
      await db.run(`
        UPDATE whatsapp_template_folders
        SET name = ?, parent_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [folderDefinition.name, folderDefinition.id])
      return mapFolder(await db.get(
        'SELECT * FROM whatsapp_template_folders WHERE id = ?',
        [folderDefinition.id]
      ))
    }

    return mapFolder(existing)
  }

  await db.run(`
    INSERT INTO whatsapp_template_folders (id, name, parent_id, sort_order, created_at, updated_at)
    VALUES (?, ?, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT DO NOTHING
  `, [folderDefinition.id, folderDefinition.name, sortOrder])

  return mapFolder(await db.get(
    'SELECT * FROM whatsapp_template_folders WHERE id = ?',
    [folderDefinition.id]
  ))
}

async function ensureDefaultTemplateFolder() {
  return ensureTemplateFolder(DEFAULT_APPOINTMENT_TEMPLATE_FOLDER, -100)
}

async function ensureDefaultMessageTemplate(definition, folderId, { provider } = {}) {
  const name = normalizeTemplateName(definition.name)
  const language = normalizeLanguage(definition.language)
  const existing = await findMessageTemplateByNameLanguage(name, language)
  if (existing) {
    let template = existing
    let refreshed = false
    let refreshSkippedLocked = false
    const shouldRefreshDefault = shouldRefreshDefaultMessageTemplate(existing, definition, folderId)

    if (shouldRefreshDefault) {
      const providerState = getMessageTemplateProviderState(existing, provider || existing.templateProvider)
      if (isTemplateLockedForEditing(providerState.status)) {
        refreshSkippedLocked = true
      } else {
        template = await updateMessageTemplate(existing.id, {
          ...definition,
          folderId,
          name,
          language
        })
        refreshed = true
      }
    }

    if (folderId && template.folderId !== folderId) {
      await db.run(`
        UPDATE whatsapp_message_templates
        SET folder_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [folderId, template.id])
      template = await getMessageTemplateById(template.id)
    }

    return { template, refreshed, refreshSkippedLocked, created: false }
  }

  try {
    return {
      template: await createMessageTemplate({
        ...definition,
        folderId,
        name,
        language
      }),
      refreshed: true,
      refreshSkippedLocked: false,
      created: true
    }
  } catch (error) {
    // Dos instancias pueden arrancar al mismo tiempo. Si la otra ganó la
    // inserción, la plantilla ya existe y este arranque debe continuar como un
    // ensure idempotente, no tumbar el servicio por una carrera inocente.
    const concurrent = await findMessageTemplateByNameLanguage(name, language)
    if (!concurrent) throw error
    return {
      template: concurrent,
      refreshed: false,
      refreshSkippedLocked: false,
      created: false
    }
  }
}

const TEMPLATE_REVIEW_STATES = new Set(['APPROVED', 'PENDING', 'IN_APPEAL', 'IN_REVIEW', 'UNDER_REVIEW', 'PENDING_REVIEW'])
const TEMPLATE_RETRYABLE_REVIEW_STATES = new Set(['PENDING', 'IN_APPEAL', 'IN_REVIEW', 'UNDER_REVIEW', 'PENDING_REVIEW'])
const TEMPLATE_RETRYABLE_FAILURE_STATES = new Set(['REJECTED'])

function isDefaultAppointmentTemplate(template = {}) {
  return DEFAULT_APPOINTMENT_TEMPLATE_NAMES.has(cleanString(template.name))
}

function getDefaultAppointmentDefinition(name) {
  const cleanName = cleanString(name)
  return DEFAULT_APPOINTMENT_MESSAGE_TEMPLATES.find((definition) => definition.name === cleanName) || null
}

function buildDefaultAppointmentRetryName(baseName, retryNumber) {
  return normalizeTemplateName(`${baseName}_r${retryNumber}`)
}

function parseTimestampMs(value) {
  const text = cleanString(value)
  if (!text) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function isStaleYCloudDefaultAppointmentReview(template = {}, nowMs = Date.now()) {
  const status = normalizeProviderTemplateStatus(template.ycloudStatus)
  if (!TEMPLATE_RETRYABLE_REVIEW_STATES.has(status)) return false

  const submittedAt = parseTimestampMs(template.ycloudSubmittedAt || template.ycloudSyncedAt || template.updatedAt)
  if (!submittedAt) return false

  return nowMs - submittedAt >= DEFAULT_APPOINTMENT_REVIEW_RETRY_TIMEOUT_MS
}

function isRejectedYCloudDefaultAppointmentReview(template = {}) {
  return TEMPLATE_RETRYABLE_FAILURE_STATES.has(normalizeProviderTemplateStatus(template.ycloudStatus))
}

function haveYCloudDefaultAppointmentPeersAccepted(template = {}, templates = []) {
  const peers = templates.filter((candidate) => (
    candidate.id !== template.id &&
    isDefaultAppointmentTemplate(candidate)
  ))
  return peers.length > 0 && peers.every((peer) => normalizeProviderTemplateStatus(peer.ycloudStatus) === 'APPROVED')
}

async function upsertYCloudDefaultAppointmentReviewRetryAlert(template = {}) {
  const alertType = DEFAULT_APPOINTMENT_REVIEW_RETRY_ALERT_TYPE
  const entityType = 'template'
  const entityId = cleanString(template.id || `${template.name}:${template.language}`)
  if (!entityId) return null

  const id = hashId('waapi_alert', `${alertType}|${entityType}|${entityId}`)
  const name = cleanString(template.name) || 'plantilla de recordatorio'
  const language = cleanString(template.language) || DEFAULT_APPOINTMENT_TEMPLATE_LANGUAGE
  const retryCount = Number(template.ycloudReviewRetryCount || 0)
  const status = normalizeProviderTemplateStatus(template.ycloudStatus) || 'sin estado'

  await db.run(`
    INSERT INTO whatsapp_api_alerts (
      id, severity, alert_type, title, message, entity_type, entity_id,
      status, raw_payload_json, updated_at
    ) VALUES (?, 'warning', ?, ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      severity = 'warning',
      title = excluded.title,
      message = excluded.message,
      entity_type = excluded.entity_type,
      entity_id = excluded.entity_id,
      status = 'active',
      raw_payload_json = excluded.raw_payload_json,
      resolved_at = NULL,
      updated_at = CURRENT_TIMESTAMP
  `, [
    id,
    alertType,
    'Plantilla de recordatorio requiere revisión',
    `Meta dejó ${name} (${language}) en estado ${status} después de ${retryCount} reintentos automáticos. Ristak ya no la recreará para evitar un ciclo; espera la notificación de Meta o revisa la plantilla manualmente.`,
    entityType,
    entityId,
    jsonString({
      templateId: template.id,
      name: template.name,
      language: template.language,
      ycloudStatus: template.ycloudStatus,
      ycloudSubmittedAt: template.ycloudSubmittedAt,
      retryCount
    })
  ])

  return id
}

async function resolveYCloudDefaultAppointmentReviewRetryAlert(template = {}) {
  const entityId = cleanString(template.id || `${template.name}:${template.language}`)
  if (!entityId) return

  await db.run(`
    UPDATE whatsapp_api_alerts
    SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE status = 'active'
      AND alert_type = ?
      AND COALESCE(entity_type, '') = 'template'
      AND COALESCE(entity_id, '') = ?
  `, [DEFAULT_APPOINTMENT_REVIEW_RETRY_ALERT_TYPE, entityId])
}

async function retryYCloudDefaultAppointmentTemplateReview(template = {}) {
  const retryNumber = Number(template.ycloudReviewRetryCount || 0) + 1
  const definition = getDefaultAppointmentDefinition(template.name)
  if (!definition) {
    throw new Error('No se encontró la definición base de esta plantilla de recordatorio.')
  }
  const retryName = buildDefaultAppointmentRetryName(definition.name, retryNumber)
  const deleteResult = await deleteWhatsAppApiTemplate({
    wabaId: getTemplateWabaId(template),
    name: getYCloudTemplateName(template),
    language: template.language
  })
  const retryTemplate = normalizeTemplatePayload({
    ...definition,
    folderId: template.folderId,
    language: template.language || definition.language,
    ycloudTemplateName: retryName,
    ycloudTemplateId: null,
    ycloudStatus: null
  })

  await db.run(`
    UPDATE whatsapp_message_templates
    SET
      folder_id = ?,
      name = ?,
      description = ?,
      category = ?,
      language = ?,
      status = ?,
      header_enabled = ?,
      header_type = ?,
      header_text = ?,
      header_media_url = ?,
      meta_header_handle = ?,
      header_location_json = ?,
      body_text = ?,
      footer_text = ?,
      buttons_json = ?,
      variables_json = ?,
      variable_examples_json = ?,
      variable_bindings_json = ?,
      ycloud_template_name = ?,
      ycloud_template_id = NULL,
      ycloud_status = NULL,
      ycloud_reason = NULL,
      ycloud_status_update_event = NULL,
      ycloud_quality_rating = NULL,
      ycloud_raw_payload_json = NULL,
      ycloud_submitted_at = NULL,
      ycloud_synced_at = CURRENT_TIMESTAMP,
      ycloud_review_retry_count = COALESCE(ycloud_review_retry_count, 0) + 1,
      ycloud_review_retry_last_at = CURRENT_TIMESTAMP,
      last_error = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    retryTemplate.folderId,
    retryTemplate.name,
    retryTemplate.description,
    retryTemplate.category,
    retryTemplate.language,
    retryTemplate.status,
    retryTemplate.headerEnabled ? 1 : 0,
    retryTemplate.headerType,
    retryTemplate.headerText,
    retryTemplate.headerMediaUrl,
    retryTemplate.metaHeaderHandle,
    jsonString(retryTemplate.headerLocation),
    retryTemplate.bodyText,
    retryTemplate.footerText,
    jsonString(retryTemplate.buttons),
    jsonString(retryTemplate.variables),
    jsonString(retryTemplate.variableExamples),
    jsonString(retryTemplate.variableBindings),
    retryTemplate.ycloudTemplateName,
    template.id
  ])

  const result = await submitMessageTemplateToActiveProvider(template.id)
  await resolveYCloudDefaultAppointmentReviewRetryAlert(result.template)
  return {
    template: result.template,
    ycloud: result.ycloud,
    deleted: deleteResult
  }
}

async function canSubmitDefaultTemplatesToActiveProvider() {
  const provider = await getActiveTemplateProvider()
  if (provider === WHATSAPP_PROVIDER_META_DIRECT) {
    const [status, wabaId, phoneNumberId, token] = await Promise.all([
      getAppConfig('whatsapp_meta_direct_status'),
      getAppConfig('whatsapp_meta_direct_waba_id'),
      getAppConfig('whatsapp_meta_direct_phone_number_id'),
      getAppConfig('whatsapp_meta_direct_system_user_token_encrypted')
    ])
    return status === 'connected' && Boolean(cleanString(wabaId) && cleanString(phoneNumberId) && cleanString(token))
  }

  const [enabled, apiKey] = await Promise.all([
    getAppConfig('whatsapp_api_enabled'),
    getAppConfig('whatsapp_api_ycloud_api_key_encrypted')
  ])

  return enabled !== '0' && Boolean(cleanString(apiKey))
}

export async function ensureDefaultAppointmentMessageTemplates({ submitToActiveProvider = false } = {}) {
  const results = []
  const folder = await ensureDefaultTemplateFolder()
  const provider = await getActiveTemplateProvider()
  const ensuredTemplates = []

  for (const definition of DEFAULT_APPOINTMENT_MESSAGE_TEMPLATES) {
    ensuredTemplates.push(await ensureDefaultMessageTemplate(definition, folder.id, {
      provider: submitToActiveProvider ? provider : undefined
    }))
  }
  const templates = ensuredTemplates.map((ensured) => ensured.template)

  for (let index = 0; index < templates.length; index += 1) {
    let template = templates[index]
    const ensured = ensuredTemplates[index]
    let providerState = getMessageTemplateProviderState(template, provider)
    let submitted = false
    let retried = false
    let retryAlerted = false
    let error = null

    if (submitToActiveProvider && ensured.refreshed && !isTemplateLockedForEditing(providerState.status)) {
      try {
        const result = await submitMessageTemplateToActiveProvider(template.id)
        template = result.template
        providerState = getMessageTemplateProviderState(template, provider)
        templates[index] = template
        ensuredTemplates[index] = { ...ensured, template }
        submitted = true
      } catch (submitError) {
        error = getTemplateErrorMessage(submitError, 'No se pudo enviar a revisión')
        logger.warn(`No se pudo reenviar plantilla default ${template.name}/${template.language} a revisión después del backfill: ${error}`)
      }
    } else if (
      submitToActiveProvider &&
      provider === WHATSAPP_PROVIDER_YCLOUD &&
      providerState.status === 'APPROVED'
    ) {
      await resolveYCloudDefaultAppointmentReviewRetryAlert(template)
    }

    if (
      !submitted &&
      submitToActiveProvider &&
      !TEMPLATE_REVIEW_STATES.has(providerState.status) &&
      !providerState.templateId
    ) {
      try {
        const result = await submitMessageTemplateToActiveProvider(template.id)
        template = result.template
        providerState = getMessageTemplateProviderState(template, provider)
        templates[index] = template
        ensuredTemplates[index] = { ...ensuredTemplates[index], template }
        submitted = true
      } catch (submitError) {
        error = getTemplateErrorMessage(submitError, 'No se pudo enviar a revisión')
        logger.warn(`No se pudo enviar plantilla default ${template.name}/${template.language} a revisión: ${error}`)
      }
    } else if (
      submitToActiveProvider &&
      provider === WHATSAPP_PROVIDER_YCLOUD &&
      isDefaultAppointmentTemplate(template) &&
      (
        isRejectedYCloudDefaultAppointmentReview(template) ||
        (
          isStaleYCloudDefaultAppointmentReview(template) &&
          haveYCloudDefaultAppointmentPeersAccepted(template, templates)
        )
      )
    ) {
      const retryCount = Number(template.ycloudReviewRetryCount || 0)
      if (retryCount >= DEFAULT_APPOINTMENT_REVIEW_MAX_RETRIES) {
        await upsertYCloudDefaultAppointmentReviewRetryAlert(template)
        retryAlerted = true
      } else {
        try {
          const result = await retryYCloudDefaultAppointmentTemplateReview(template)
          template = result.template
          providerState = getMessageTemplateProviderState(template, provider)
          templates[index] = template
          submitted = true
          retried = true
        } catch (retryError) {
          error = getTemplateErrorMessage(retryError, 'No se pudo recrear la plantilla atorada')
          logger.warn(`No se pudo reintentar plantilla default ${template.name}/${template.language}: ${error}`)
        }
      }
    }

    results.push({
      id: template.id,
      name: template.name,
      language: template.language,
      provider,
      providerStatus: providerState.status,
      reviewRetryCount: provider === WHATSAPP_PROVIDER_YCLOUD ? template.ycloudReviewRetryCount || 0 : 0,
      refreshed: ensured.refreshed,
      refreshSkippedLocked: ensured.refreshSkippedLocked,
      submitted,
      retried,
      retryAlerted,
      error
    })
  }

  return {
    total: results.length,
    submitted: results.filter((result) => result.submitted).length,
    errors: results.filter((result) => result.error).length,
    templates: results
  }
}

export async function ensureDefaultPaymentMessageTemplates({ submitToActiveProvider = false, publicBaseUrl = '' } = {}) {
  const results = []
  const folder = await ensureTemplateFolder(DEFAULT_PAYMENT_TEMPLATE_FOLDER, -90)
  const provider = await getActiveTemplateProvider()
  const ensuredTemplates = []
  const canSubmitToActiveProvider = submitToActiveProvider && Boolean(normalizePublicBaseUrl(publicBaseUrl))

  for (const definition of getDefaultPaymentMessageTemplates({ publicBaseUrl })) {
    ensuredTemplates.push(await ensureDefaultMessageTemplate(definition, folder.id, {
      provider: canSubmitToActiveProvider ? provider : undefined
    }))
  }
  const templates = ensuredTemplates.map((ensured) => ensured.template)

  for (let index = 0; index < templates.length; index += 1) {
    let template = templates[index]
    const ensured = ensuredTemplates[index]
    let providerState = getMessageTemplateProviderState(template, provider)
    let submitted = false
    let error = null

    if (canSubmitToActiveProvider && ensured.refreshed && !isTemplateLockedForEditing(providerState.status)) {
      try {
        const result = await submitMessageTemplateToActiveProvider(template.id)
        template = result.template
        providerState = getMessageTemplateProviderState(template, provider)
        templates[index] = template
        ensuredTemplates[index] = { ...ensured, template }
        submitted = true
      } catch (submitError) {
        error = getTemplateErrorMessage(submitError, 'No se pudo enviar a revisión')
        logger.warn(`No se pudo reenviar plantilla default de pago ${template.name}/${template.language} a revisión después del backfill: ${error}`)
      }
    } else if (
      canSubmitToActiveProvider &&
      !TEMPLATE_REVIEW_STATES.has(providerState.status) &&
      !providerState.templateId
    ) {
      try {
        const result = await submitMessageTemplateToActiveProvider(template.id)
        template = result.template
        providerState = getMessageTemplateProviderState(template, provider)
        templates[index] = template
        ensuredTemplates[index] = { ...ensured, template }
        submitted = true
      } catch (submitError) {
        error = getTemplateErrorMessage(submitError, 'No se pudo enviar a revisión')
        logger.warn(`No se pudo enviar plantilla default de pago ${template.name}/${template.language} a revisión: ${error}`)
      }
    }

    results.push({
      id: template.id,
      name: template.name,
      language: template.language,
      provider,
      providerStatus: providerState.status,
      reviewRetryCount: provider === WHATSAPP_PROVIDER_YCLOUD ? template.ycloudReviewRetryCount || 0 : 0,
      refreshed: ensured.refreshed,
      refreshSkippedLocked: ensured.refreshSkippedLocked,
      submitted,
      retried: false,
      retryAlerted: false,
      error
    })
  }

  return {
    total: results.length,
    submitted: results.filter((result) => result.submitted).length,
    errors: results.filter((result) => result.error).length,
    templates: results
  }
}

function combineDefaultTemplateResults(results = []) {
  const templates = results.flatMap((result) => Array.isArray(result?.templates) ? result.templates : [])
  return {
    total: templates.length,
    submitted: templates.filter((template) => template.submitted).length,
    errors: templates.filter((template) => template.error).length,
    templates
  }
}

export async function ensureDefaultWhatsAppApiMessageTemplates({ submitToActiveProvider = false, publicBaseUrl = '' } = {}) {
  const appointmentResult = await ensureDefaultAppointmentMessageTemplates({ submitToActiveProvider })
  const paymentResult = await ensureDefaultPaymentMessageTemplates({ submitToActiveProvider, publicBaseUrl })
  return combineDefaultTemplateResults([appointmentResult, paymentResult])
}

export async function repairDefaultAppointmentMessageTemplatesForCurrentConnection() {
  const submitToActiveProvider = await canSubmitDefaultTemplatesToActiveProvider()
  return ensureDefaultAppointmentMessageTemplates({ submitToActiveProvider })
}

export async function repairDefaultMessageTemplatesForCurrentConnection({ publicBaseUrl = '' } = {}) {
  const submitToActiveProvider = await canSubmitDefaultTemplatesToActiveProvider()
  return ensureDefaultWhatsAppApiMessageTemplates({
    submitToActiveProvider,
    publicBaseUrl: publicBaseUrl || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || ''
  })
}

export async function submitMessageTemplateToActiveProvider(id) {
  const template = await getMessageTemplateById(id)
  const provider = await getActiveTemplateProvider()
  const providerPayload = buildProviderTemplatePayload(template, provider)
  const providerIdentity = hasTemplateProviderFootprint(template, provider)
    ? getTemplateProviderIdentity(template, provider)
    : { wabaId: '', providerTemplateId: '', officialTemplateId: '' }
  const editPayload = {
    ...providerPayload,
    provider,
    ...providerIdentity
  }
  let shouldEdit = false

  try {
    shouldEdit = shouldEditExistingProviderTemplate(template, provider)
    const response = shouldEdit
      ? await editWhatsAppApiTemplate(editPayload)
      : await createWhatsAppApiTemplate({ ...providerPayload, provider })
    const label = getTemplateProviderLabel(provider)
    return {
      template: await applyProviderTemplateResponse(id, response, { submitted: true, provider }),
      provider,
      providerResponse: response,
      ...(provider === WHATSAPP_PROVIDER_YCLOUD ? { ycloud: response } : { metaDirect: response }),
      message: shouldEdit
        ? `Plantilla existente actualizada y reenviada a revisión con ${label}.`
        : `Plantilla enviada a revisión con ${label}.`
    }
  } catch (error) {
    if (
      !shouldEdit &&
      provider === WHATSAPP_PROVIDER_YCLOUD &&
      isYCloudTemplateAlreadyExistsError(error) &&
      (providerIdentity.officialTemplateId || providerPayload.name)
    ) {
      try {
        const response = await editWhatsAppApiTemplate(editPayload)
        return {
          template: await applyProviderTemplateResponse(id, response, { submitted: true, provider }),
          provider,
          providerResponse: response,
          ...(provider === WHATSAPP_PROVIDER_YCLOUD ? { ycloud: response } : { metaDirect: response }),
          message: 'La plantilla ya existía en Meta; Ristak la actualizó y la reenvió a revisión.'
        }
      } catch (editError) {
        const message = await saveTemplateLastError(id, editError)
        throw new Error(message)
      }
    }
    const message = await saveTemplateLastError(id, error)
    throw new Error(message)
  }
}

export async function syncMessageTemplateStatus(id) {
  const template = await getMessageTemplateById(id)
  const provider = normalizeWhatsAppProvider(template.templateProvider || await getActiveTemplateProvider(), WHATSAPP_PROVIDER_YCLOUD)
  const providerState = getMessageTemplateProviderState(template, provider)

  try {
    const response = await retrieveWhatsAppApiTemplate({
      name: providerState.name,
      language: template.language,
      provider,
      ...getTemplateProviderIdentity(template, provider)
    })
    return {
      template: await applyProviderTemplateResponse(id, response, { provider }),
      provider,
      providerResponse: response,
      ...(provider === WHATSAPP_PROVIDER_YCLOUD ? { ycloud: response } : { metaDirect: response }),
      message: `Estado sincronizado con ${getTemplateProviderLabel(provider)}.`
    }
  } catch (error) {
    const message = await saveTemplateLastError(id, error)
    throw new Error(message)
  }
}

export async function syncAllMessageTemplatesWithActiveProvider() {
  await syncWhatsAppApiTemplates()
  await syncLocalMessageTemplateSnapshots({ onlyApproved: true })
  return getMessageTemplateBundle()
}

async function findMessageTemplateForSendDefaults({ templateId, templateName, language } = {}) {
  const cleanTemplateId = cleanString(templateId)
  const cleanTemplateName = cleanString(templateName)
  const cleanLanguage = cleanString(language)

  if (cleanTemplateId) {
    const direct = await db.get(`
      SELECT *
      FROM whatsapp_message_templates
      WHERE id = ?
        OR provider_template_id = ?
        OR (template_provider = 'ycloud' AND ycloud_template_id = ?)
      ORDER BY updated_at DESC
      LIMIT 1
    `, [cleanTemplateId, cleanTemplateId, cleanTemplateId])
    if (direct) return mapTemplate(direct)

    const apiTemplate = await db.get(`
      SELECT id, official_template_id, provider_template_id, provider, name, language
      FROM whatsapp_api_templates
      WHERE id = ? OR official_template_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `, [cleanTemplateId, cleanTemplateId])

    if (apiTemplate) {
      const fromSnapshot = await db.get(`
        SELECT *
        FROM whatsapp_message_templates
        WHERE language = ?
          AND (
            provider_template_id = ?
            OR provider_template_id = ?
            OR provider_template_name = ?
            OR (
              template_provider = 'ycloud'
              AND (ycloud_template_id = ? OR ycloud_template_id = ? OR ycloud_template_name = ?)
            )
            OR name = ?
          )
        ORDER BY
          CASE
            WHEN provider_template_id = ? OR provider_template_id = ? THEN 0
            WHEN provider_template_name = ? THEN 1
            WHEN template_provider = 'ycloud' AND (ycloud_template_id = ? OR ycloud_template_id = ?) THEN 2
            WHEN template_provider = 'ycloud' AND ycloud_template_name = ? THEN 3
            ELSE 2
          END,
          updated_at DESC
        LIMIT 1
      `, [
        apiTemplate.language,
        apiTemplate.provider_template_id || apiTemplate.id,
        apiTemplate.official_template_id,
        apiTemplate.name,
        apiTemplate.provider_template_id || apiTemplate.id,
        apiTemplate.official_template_id,
        apiTemplate.name,
        apiTemplate.name,
        apiTemplate.provider_template_id || apiTemplate.id,
        apiTemplate.official_template_id,
        apiTemplate.name,
        apiTemplate.provider_template_id || apiTemplate.id,
        apiTemplate.official_template_id,
        apiTemplate.name
      ])
      if (fromSnapshot) return mapTemplate(fromSnapshot)
    }
  }

  if (!cleanTemplateName) return null
  const languageClause = cleanLanguage ? 'AND language = ?' : ''

  const byName = await db.get(`
    SELECT *
    FROM whatsapp_message_templates
    WHERE (
      provider_template_name = ?
      OR name = ?
      OR (template_provider = 'ycloud' AND ycloud_template_name = ?)
    )
      ${languageClause}
    ORDER BY
      CASE
        WHEN provider_template_name = ? THEN 0
        WHEN name = ? THEN 1
        ELSE 2
      END,
      updated_at DESC
    LIMIT 1
  `, [cleanTemplateName, cleanTemplateName, cleanTemplateName, ...(cleanLanguage ? [cleanLanguage] : []), cleanTemplateName, cleanTemplateName])

  return byName ? mapTemplate(byName) : null
}

function bindingFallback(template, index) {
  return cleanString(template?.variableExamples?.[`{{${index}}}`]) ||
    cleanString(template?.variableExamples?.[String(index)])
}

async function renderSendBindingValue(template, binding = {}, index, variableOptions = {}) {
  const mergeField = cleanString(binding.mergeField) ||
    (cleanString(binding.variableKey) ? `{{${cleanString(binding.variableKey)}}}` : '')
  const fallback = cleanString(binding.example) || bindingFallback(template, index)
  if (!mergeField) return fallback

  const rendered = cleanString(await renderTemplateVariables(mergeField, variableOptions))
  return rendered || fallback
}

async function buildTextSendParametersFromTemplate(template, target, variableOptions = {}) {
  const indexes = extractNumericVariableIndexes(getTemplateTextForTarget(template, target))
  if (!indexes.length) return []

  const bindings = template.variableBindings?.[target] || {}
  const parameters = []
  for (const index of indexes) {
    const value = await renderSendBindingValue(template, bindings[String(index)] || {}, index, variableOptions)
    if (!value) {
      throw new Error(`Configura el dato dinámico y el ejemplo para {{${index}}} en la plantilla ${template.name}.`)
    }
    parameters.push({ type: 'text', text: value })
  }
  return parameters
}

async function buildUrlButtonSendComponentsFromTemplate(template, variableOptions = {}) {
  const buttons = Array.isArray(template?.buttons) ? template.buttons : []
  const components = []

  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons[index]
    if (cleanString(button?.type) !== 'website') continue

    const parameters = await buildTextSendParametersFromTemplate(
      template,
      getButtonValueTarget(index),
      variableOptions
    )
    if (!parameters.length) continue

    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(index),
      parameters
    })
  }

  return components
}

function buildMediaHeaderSendComponent(template) {
  const headerType = cleanString(template?.headerType).toLowerCase()
  if (!['image', 'video', 'document'].includes(headerType)) return null

  const link = cleanString(template.headerMediaUrl, 2048)
  if (!link) {
    throw new Error(`Agrega el archivo de encabezado predeterminado en la plantilla ${template.name}.`)
  }

  return {
    type: 'header',
    parameters: [{
      type: headerType,
      [headerType]: { link }
    }]
  }
}

export async function buildDefaultMessageTemplateSendComponents({
  templateId,
  templateName,
  language,
  variableOptions = {}
} = {}) {
  const template = await findMessageTemplateForSendDefaults({ templateId, templateName, language }) ||
    getBuiltinDefaultMessageTemplateForSend({
      templateName,
      language,
      publicBaseUrl: variableOptions.publicBaseUrl
    })
  if (!template) return []

  const components = []
  const mediaHeader = buildMediaHeaderSendComponent(template)
  if (mediaHeader) {
    components.push(mediaHeader)
  } else {
    const headerParameters = await buildTextSendParametersFromTemplate(template, 'headerText', variableOptions)
    if (headerParameters.length) {
      components.push({ type: 'header', parameters: headerParameters })
    }
  }

  const bodyParameters = await buildTextSendParametersFromTemplate(template, 'bodyText', variableOptions)
  if (bodyParameters.length) {
    components.push({ type: 'body', parameters: bodyParameters })
  }

  components.push(...await buildUrlButtonSendComponentsFromTemplate(template, variableOptions))

  return components
}

async function renderDefaultTemplateTargetText(template, target, variableOptions = {}) {
  const sourceText = cleanString(getTemplateTextForTarget(template, target), 4000)
  if (!sourceText) return ''

  const indexes = extractNumericVariableIndexes(sourceText)
  if (!indexes.length) return sourceText

  const bindings = template.variableBindings?.[target] || {}
  const valuesByIndex = new Map()
  for (const index of indexes) {
    const value = await renderSendBindingValue(template, bindings[String(index)] || {}, index, variableOptions)
    valuesByIndex.set(index, value)
  }

  return sourceText.replace(NUMERIC_VARIABLE_PATTERN, (match, index) => {
    const value = valuesByIndex.get(Number(index))
    return value === undefined || value === null || value === '' ? match : cleanString(value, 1000)
  })
}

function formatFallbackTemplateButton(button = {}, renderedValue = '') {
  const type = cleanString(button.type, 40).toLowerCase()
  const label = cleanString(button.label || button.text || button.title, 120)
  const value = cleanString(renderedValue || button.value || button.phoneNumber || button.phone, 2000)
  if (!label && !value) return ''

  if (type === 'website') {
    return [label, value].filter(Boolean).join(': ')
  }
  if (type === 'phone') {
    return [label, value].filter(Boolean).join(': ')
  }
  return label || value
}

export async function buildDefaultMessageTemplateFallbackText({
  templateId,
  templateName,
  language,
  variableOptions = {}
} = {}) {
  const template = await findMessageTemplateForSendDefaults({ templateId, templateName, language }) ||
    getBuiltinDefaultMessageTemplateForSend({
      templateName,
      language,
      publicBaseUrl: variableOptions.publicBaseUrl
    })
  if (!template) return ''

  const parts = []
  const headerText = cleanString(template.headerType).toLowerCase() === 'text'
    ? await renderDefaultTemplateTargetText(template, 'headerText', variableOptions)
    : ''
  const bodyText = await renderDefaultTemplateTargetText(template, 'bodyText', variableOptions)
  const footerText = await renderDefaultTemplateTargetText(template, 'footerText', variableOptions)

  if (headerText) parts.push(headerText)
  if (bodyText) parts.push(bodyText)
  if (footerText) parts.push(footerText)

  const buttonLines = []
  const buttons = Array.isArray(template.buttons) ? template.buttons : []
  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons[index]
    const renderedValue = await renderDefaultTemplateTargetText(template, getButtonValueTarget(index), variableOptions)
    const line = formatFallbackTemplateButton(button, renderedValue)
    if (line) buttonLines.push(line)
  }
  if (buttonLines.length) parts.push(buttonLines.join('\n'))

  return parts.map(part => cleanString(part, 4000)).filter(Boolean).join('\n\n')
}

async function buildSendComponentsFromTemplate(template) {
  const components = []
  const mediaHeader = buildMediaHeaderSendComponent(template)
  if (mediaHeader) {
    components.push(mediaHeader)
  } else {
    const headerParameters = await buildTextSendParametersFromTemplate(template, 'headerText')
    if (headerParameters.length) {
      components.push({ type: 'header', parameters: headerParameters })
    }
  }

  const bodyParameters = await buildTextSendParametersFromTemplate(template, 'bodyText')
  if (bodyParameters.length) {
    components.push({ type: 'body', parameters: bodyParameters })
  }

  components.push(...await buildUrlButtonSendComponentsFromTemplate(template))

  return components
}

export async function sendMessageTemplateTest(id, payload = {}) {
  const template = await getMessageTemplateById(id)
  const providerState = getMessageTemplateProviderState(template)
  if (providerState.status !== 'APPROVED') {
    throw new Error(`${getTemplateProviderLabel(providerState.provider)} todavía no aprobó esta plantilla. Solo se pueden enviar plantillas APPROVED.`)
  }

  const to = cleanString(payload.to)
  if (!to) throw new Error('Escribe el número destino para enviar la prueba')

  try {
    const response = await sendWhatsAppApiTemplateMessage({
      to,
      from: payload.from,
      templateName: providerState.name,
      language: template.language,
      components: await buildSendComponentsFromTemplate(template),
      externalId: payload.externalId
    })
    return {
      sent: true,
      response,
      message: 'Plantilla enviada por WhatsApp Business.'
    }
  } catch (error) {
    const message = await saveTemplateLastError(id, error)
    throw new Error(message)
  }
}

function getTemplateWabaId(template = {}, provider = template.templateProvider) {
  const raw = getMessageTemplateProviderState(template, provider).rawPayload
  return cleanString(template.wabaId || template.waba_id || raw.wabaId || raw.waba_id)
}

function shouldDeleteTemplateFromProvider(template = {}, provider = template.templateProvider) {
  const providerState = getMessageTemplateProviderState(template, provider)
  return Boolean(
    providerState.templateId ||
    providerState.status ||
    providerState.submittedAt ||
    Object.keys(providerState.rawPayload).length
  )
}

export async function deleteMessageTemplate(id) {
  const row = await db.get('SELECT * FROM whatsapp_message_templates WHERE id = ?', [id])
  if (!row) return { deleted: false, providerResponse: null, snapshot: { deleted: 0, sendReferencesReleased: 0 } }

  const template = mapTemplate(row)
  const provider = normalizeWhatsAppProvider(template.templateProvider || await getActiveTemplateProvider(), WHATSAPP_PROVIDER_YCLOUD)
  const providerState = getMessageTemplateProviderState(template, provider)
  let providerResponse = null

  if (shouldDeleteTemplateFromProvider(template, provider)) {
    try {
      providerResponse = await deleteWhatsAppApiTemplate({
        provider,
        wabaId: getTemplateWabaId(template, provider),
        name: providerState.name,
        language: template.language,
        providerTemplateId: providerState.templateId,
        officialTemplateId: providerState.templateId
      })
    } catch (error) {
      const message = await saveTemplateLastError(id, error)
      throw new Error(message)
    }
  }

  const snapshot = providerResponse?.snapshot || await deleteWhatsAppApiTemplateSnapshot({
    wabaId: getTemplateWabaId(template, provider),
    name: providerState.name,
    language: template.language,
    ids: [template.id, providerState.templateId]
  })
  const result = await db.run('DELETE FROM whatsapp_message_templates WHERE id = ?', [id])
  return {
    deleted: result.changes > 0,
    provider,
    providerResponse,
    ...(provider === WHATSAPP_PROVIDER_YCLOUD ? { ycloud: providerResponse } : { metaDirect: providerResponse }),
    snapshot
  }
}

export async function createTemplateFolder(payload = {}) {
  const name = clampText(payload.name, 80)
  if (!name) {
    throw new Error('El nombre de la carpeta es obligatorio')
  }

  const parentId = normalizeOptionalString(payload.parentId)
  if (parentId) {
    const parent = await db.get('SELECT id FROM whatsapp_template_folders WHERE id = ?', [parentId])
    if (!parent) throw new Error('La carpeta padre no existe')
  }

  const id = makeId('tmpl_folder')
  const sortOrder = Number.isFinite(Number(payload.sortOrder)) ? Number(payload.sortOrder) : 0

  await db.run(`
    INSERT INTO whatsapp_template_folders (id, name, parent_id, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [id, name, parentId, sortOrder])

  const row = await db.get('SELECT * FROM whatsapp_template_folders WHERE id = ?', [id])
  return mapFolder(row)
}

function collectDescendantFolderIds(folders, rootId) {
  const ids = new Set([rootId])
  let changed = true

  while (changed) {
    changed = false
    for (const folder of folders) {
      if (folder.parent_id && ids.has(folder.parent_id) && !ids.has(folder.id)) {
        ids.add(folder.id)
        changed = true
      }
    }
  }

  return Array.from(ids)
}

export async function updateTemplateFolder(id, payload = {}) {
  const existing = await db.get('SELECT * FROM whatsapp_template_folders WHERE id = ?', [id])
  if (!existing) {
    const error = new Error('Carpeta no encontrada')
    error.statusCode = 404
    throw error
  }

  const name = clampText(payload.name, 80)
  if (!name) throw new Error('El nombre de la carpeta es obligatorio')

  const parentId = normalizeOptionalString(payload.parentId)
  if (parentId === id) throw new Error('Una carpeta no puede estar dentro de sí misma')

  if (parentId) {
    const folders = await db.all('SELECT id, parent_id FROM whatsapp_template_folders')
    const descendants = collectDescendantFolderIds(folders, id)
    if (descendants.includes(parentId)) {
      throw new Error('No puedes mover una carpeta dentro de una subcarpeta propia')
    }
    const parent = await db.get('SELECT id FROM whatsapp_template_folders WHERE id = ?', [parentId])
    if (!parent) throw new Error('La carpeta padre no existe')
  }

  const sortOrder = Number.isFinite(Number(payload.sortOrder)) ? Number(payload.sortOrder) : Number(existing.sort_order || 0)

  await db.run(`
    UPDATE whatsapp_template_folders
    SET name = ?, parent_id = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [name, parentId, sortOrder, id])

  const row = await db.get('SELECT * FROM whatsapp_template_folders WHERE id = ?', [id])
  return mapFolder(row)
}

export async function deleteTemplateFolder(id) {
  const existing = await db.get('SELECT id FROM whatsapp_template_folders WHERE id = ?', [id])
  if (!existing) return { deleted: false, releasedTemplates: 0 }

  const folders = await db.all('SELECT id, parent_id FROM whatsapp_template_folders')
  const ids = collectDescendantFolderIds(folders, id)
  if (!ids.length) return { deleted: false, releasedTemplates: 0 }

  let releasedTemplates = 0
  for (const folderId of ids) {
    const result = await db.run(
      'UPDATE whatsapp_message_templates SET folder_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE folder_id = ?',
      [folderId]
    )
    releasedTemplates += Number(result.changes || 0)
  }

  for (const folderId of ids.reverse()) {
    await db.run('DELETE FROM whatsapp_template_folders WHERE id = ?', [folderId])
  }

  return { deleted: true, releasedTemplates }
}

export async function createTemplateCustomField(payload = {}) {
  const name = clampText(payload.name, 80)
  if (!name) throw new Error('El nombre del campo personalizado es obligatorio')

  const fieldKey = normalizeFieldKey(payload.fieldKey || name)
  const id = makeId('tmpl_field')
  const mergeField = `{{contact.custom.${fieldKey}}}`
  const example = clampText(payload.example, 140)
  const dataType = normalizeKey(payload.dataType) || 'text'

  try {
    await db.run(`
      INSERT INTO whatsapp_template_custom_fields (
        id, name, field_key, merge_field, example, data_type, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [id, name, fieldKey, mergeField, example, dataType])
  } catch (error) {
    if (error.message?.includes('UNIQUE') || error.message?.includes('unique')) {
      throw new Error('Ya existe un campo personalizado con esa llave')
    }
    throw error
  }

  const row = await db.get('SELECT * FROM whatsapp_template_custom_fields WHERE id = ?', [id])
  return mapCustomField(row)
}

export async function deleteTemplateCustomField(id) {
  const result = await db.run('DELETE FROM whatsapp_template_custom_fields WHERE id = ?', [id])
  return { deleted: result.changes > 0 }
}
