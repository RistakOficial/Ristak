import crypto from 'crypto'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { buildTagMatchKeys, resolveTagIds, tagNamesForIds } from './contactTagsService.js'

/**
 * Motor de ejecución de automatizaciones.
 *
 * Cuando ocurre un evento real (p. ej. un contacto escribe por WhatsApp),
 * inscribe al contacto en las automatizaciones publicadas cuyo disparador
 * coincide y recorre el flujo paso a paso, registrando TODO en
 * automation_enrollments.log para que el usuario vea qué pasó y dónde se
 * detuvo. Los pasos que el motor aún no sabe ejecutar se registran como
 * "omitido" y el flujo continúa: nunca se pierde silenciosamente.
 */

const MAX_STEPS = 60
const MAX_INLINE_DELAY_SECONDS = 120

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

function nowIso() {
  return new Date().toISOString()
}

function parseJson(raw, fallback) {
  if (raw === null || raw === undefined) return fallback
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Flujo: lectura de nodos, disparadores y aristas
// ---------------------------------------------------------------------------

function getStartNode(flow) {
  return (flow.nodes || []).find((node) => node.type === 'start') || null
}

function getTriggers(startNode) {
  const triggers = startNode?.config?.triggers
  return Array.isArray(triggers) ? triggers : []
}

function getNode(flow, nodeId) {
  return (flow.nodes || []).find((node) => node.id === nodeId) || null
}

function edgesFrom(flow, nodeId, handle) {
  return (flow.edges || []).filter(
    (edge) => edge.sourceNodeId === nodeId && (handle === undefined || edge.sourceHandle === handle)
  )
}

function nodeLabel(node) {
  const custom = str(node?.config?.customTitle).trim()
  return custom || node?.label || node?.type || 'Paso'
}

// ---------------------------------------------------------------------------
// Variables {{contact.x}} → datos reales del contacto / conversación
// ---------------------------------------------------------------------------

function buildVariableMap(ctx) {
  const contact = ctx.contact || {}
  const custom = contact.customFields || {}
  const map = {
    'contact.first_name': contact.firstName || (contact.fullName || '').split(' ')[0] || '',
    'contact.last_name': contact.lastName || '',
    'contact.full_name': contact.fullName || '',
    'contact.name': contact.fullName || contact.firstName || '',
    'contact.phone': contact.phone || '',
    'contact.email': contact.email || '',
    'conversation.last_message': ctx.messageText || '',
    'message.text': ctx.messageText || '',
    'automation.name': ctx.automationName || ''
  }
  Object.entries(custom).forEach(([key, value]) => {
    map[`contact.custom.${key}`] = String(value ?? '')
  })
  return map
}

export function renderTemplate(text, ctx) {
  const map = buildVariableMap(ctx)
  return String(text || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, token) => map[token] ?? '')
}

// ---------------------------------------------------------------------------
// Coincidencia de disparadores y filtros
// ---------------------------------------------------------------------------

function keywordsMatch(config, messageText) {
  const keywords = Array.isArray(config.keywords) ? config.keywords.filter(Boolean) : []
  if (keywords.length === 0) return true
  const text = normalizeText(messageText)
  const mode = str(config.match) || 'contains'
  return keywords.some((keyword) => {
    const needle = normalizeText(keyword)
    if (!needle) return false
    if (mode === 'exact') return text === needle
    if (mode === 'starts_with') return text.startsWith(needle)
    return text.includes(needle)
  })
}

function filterFieldValue(filter, ctx) {
  const contact = ctx.contact || {}
  switch (filter.field) {
    case 'message': return ctx.messageText || ''
    case 'source': return contact.source || ''
    case 'email': return contact.email || ''
    case 'phone': return contact.phone || ''
    case 'country': return contact.country || ''
    case 'tag': return (contact.tagKeys || contact.tags || []).join(' , ')
    case 'custom': return String((contact.customFields || {})[filter.customKey] ?? '')
    // Campos del evento (cita, pago, anuncio…)
    case 'calendar': return ctx.calendarId || null
    case 'appointment_type': return ctx.appointmentType || null
    case 'product': return ctx.product || null
    case 'currency': return ctx.currency || null
    case 'provider': return ctx.provider || null
    case 'campaign': return ctx.campaign || null
    default: return null // campo sin dato local: no bloquea
  }
}

function evaluateFilter(filter, ctx) {
  const actualRaw = filterFieldValue(filter, ctx)
  if (actualRaw === null) return true
  const actual = normalizeText(actualRaw)
  const expected = normalizeText(filter.value)
  switch (filter.match) {
    case 'not': return actual !== expected
    case 'contains': return actual.includes(expected)
    case 'not_contains': return !actual.includes(expected)
    default: return actual === expected
  }
}

export function filtersMatch(filters, ctx) {
  // Los filtros se unen en secuencia con Y / O (connector del propio filtro)
  const list = (Array.isArray(filters) ? filters : []).filter(
    (filter) => filter?.field && String(filter.value || '').trim()
  )
  return list.reduce((accumulated, filter, index) => {
    const met = evaluateFilter(filter, ctx)
    if (index === 0) return met
    return filter.connector === 'or' ? accumulated || met : accumulated && met
  }, true)
}

const APPOINTMENT_STATUS_ALIASES = {
  showed: 'completed',
  noshow: 'no_show',
  'no-show': 'no_show'
}

function triggerMatches(trigger, eventType, ctx) {
  const config = trigger.config || {}
  if (!filtersMatch(config.filters, ctx)) return false

  switch (eventType) {
    case 'message-received': {
      if (trigger.type !== 'trigger-customer-replied') return false
      const channel = str(config.channel) || 'any'
      if (channel !== 'any' && channel !== ctx.channel) return false
      return keywordsMatch(config, ctx.messageText)
    }

    case 'contact-created': {
      if (trigger.type !== 'trigger-contact-created') return false
      const source = str(config.source)
      return !source || normalizeText(source) === normalizeText(ctx.contact?.source)
    }

    case 'contact-updated': {
      if (trigger.type !== 'trigger-contact-updated') return false
      const field = str(config.field)
      if (!field) return true
      const changed = (ctx.changedFields || []).map(normalizeText)
      return changed.includes(normalizeText(field)) || changed.includes(normalizeText(field.replace(/^custom:/, '')))
    }

    case 'tag-changed': {
      if (trigger.type !== 'trigger-contact-tag') return false
      const operator = str(config.operator) || 'added'
      const tag = normalizeText(config.tag)
      if (!tag) return false
      if (operator === 'contains') return (ctx.contact?.tagKeys || ctx.contact?.tags || []).map(normalizeText).includes(tag)
      // El evento trae el nombre (ctx.tag) y el ID (ctx.tagId); la config puede tener cualquiera de los dos
      return ctx.tagAction === operator && (normalizeText(ctx.tag) === tag || normalizeText(ctx.tagId) === tag)
    }

    case 'form-submitted': {
      if (trigger.type !== 'trigger-form-submitted') return false
      const form = str(config.form)
      return !form || form === str(ctx.formId)
    }

    case 'appointment-booked': {
      if (trigger.type !== 'trigger-appointment-booked') return false
      const calendar = str(config.calendar)
      return !calendar || calendar === str(ctx.calendarId)
    }

    case 'appointment-status': {
      if (trigger.type !== 'trigger-appointment-status') return false
      const wanted = str(config.status) || 'confirmed'
      const actualRaw = normalizeText(ctx.status)
      const actual = APPOINTMENT_STATUS_ALIASES[actualRaw] || actualRaw
      if (wanted !== actual) return false
      const calendar = str(config.calendar)
      return !calendar || calendar === str(ctx.calendarId)
    }

    case 'payment-received': {
      if (trigger.type !== 'trigger-payment-received') return false
      const operator = str(config.amountOperator) || 'any'
      if (operator !== 'any') {
        const amount = Number(ctx.amount) || 0
        const expected = Number(config.amount) || 0
        if (operator === 'gt' && !(amount > expected)) return false
        if (operator === 'gte' && !(amount >= expected)) return false
        if (operator === 'lt' && !(amount < expected)) return false
        if (operator === 'eq' && amount !== expected) return false
      }
      const product = str(config.product)
      return !product || normalizeText(product) === normalizeText(ctx.product)
    }

    case 'refund':
      return trigger.type === 'trigger-refund'

    case 'webhook-received': {
      if (trigger.type !== 'trigger-incoming-webhook') return false
      const endpointId = str(config.endpointId)
      return !endpointId || endpointId === str(ctx.endpointId)
    }

    default:
      return false
  }
}

const EVENT_DESCRIPTIONS = {
  'message-received': (ctx) => `el contacto respondió por ${ctx.channel}`,
  'contact-created': () => 'se creó el contacto',
  'contact-updated': (ctx) => `cambió ${(ctx.changedFields || []).join(', ') || 'un campo'} del contacto`,
  'tag-changed': (ctx) => `etiqueta "${ctx.tag}" ${ctx.tagAction === 'removed' ? 'eliminada' : 'añadida'}`,
  'form-submitted': (ctx) => `envió el formulario${ctx.formName ? ` "${ctx.formName}"` : ''}`,
  'appointment-booked': () => 'agendó una cita',
  'appointment-status': (ctx) => `la cita cambió a ${ctx.status}`,
  'payment-received': (ctx) => `se recibió un pago${ctx.amount ? ` de $${ctx.amount}` : ''}`,
  refund: () => 'se procesó un reembolso',
  'webhook-received': () => 'se recibió un webhook'
}

// ---------------------------------------------------------------------------
// Condiciones (modelo avanzado: ramas → grupos → reglas)
// ---------------------------------------------------------------------------

function ruleFieldValue(rule, ctx) {
  const contact = ctx.contact || {}
  switch (rule.field) {
    case 'contact-first-name': return contact.firstName || ''
    case 'contact-last-name': return contact.lastName || ''
    case 'contact-phone': return contact.phone || ''
    case 'contact-email': return contact.email || ''
    case 'contact-source': return contact.source || ''
    case 'contact-custom-field': return String((contact.customFields || {})[rule.customKey] ?? '')
    case 'conv-last-received': return ctx.messageText || ''
    case 'conv-keyword': return ctx.messageText || ''
    case 'conv-replied': return ctx.messageText ? 'true' : 'false'
    case 'tag-has':
    case 'tag-any-of':
      return (contact.tagKeys || contact.tags || []).join(' , ')
    default: return null
  }
}

function evaluateRule(rule, ctx) {
  const actualRaw = ruleFieldValue(rule, ctx)
  if (actualRaw === null) return { ok: false, known: false }
  const actual = normalizeText(actualRaw)
  const expected = normalizeText(renderTemplate(String(rule.value ?? ''), ctx))
  switch (rule.operator) {
    case 'is': return { ok: actual === expected, known: true }
    case 'is_not': return { ok: actual !== expected, known: true }
    case 'contains': return { ok: actual.includes(expected), known: true }
    case 'not_contains': return { ok: !actual.includes(expected), known: true }
    case 'starts_with': return { ok: actual.startsWith(expected), known: true }
    case 'ends_with': return { ok: actual.endsWith(expected), known: true }
    case 'is_empty': return { ok: actual === '', known: true }
    case 'is_not_empty': return { ok: actual !== '', known: true }
    case 'is_true': return { ok: actual === 'true', known: true }
    case 'is_false': return { ok: actual !== 'true', known: true }
    case 'gt': return { ok: Number(actual) > Number(expected), known: true }
    case 'gte': return { ok: Number(actual) >= Number(expected), known: true }
    case 'lt': return { ok: Number(actual) < Number(expected), known: true }
    case 'lte': return { ok: Number(actual) <= Number(expected), known: true }
    default: return { ok: false, known: false }
  }
}

function evaluateGroup(group, ctx) {
  const rules = Array.isArray(group.rules) ? group.rules : []
  if (rules.length === 0) return true
  const results = rules.map((rule) => evaluateRule(rule, ctx).ok)
  const met = (group.operator || 'AND') === 'OR' ? results.some(Boolean) : results.every(Boolean)
  return group.negate ? !met : met
}

function evaluateBranch(branch, ctx) {
  const groups = Array.isArray(branch.groups) ? branch.groups : []
  if (groups.length === 0) return false
  const results = groups.map((group) => evaluateGroup(group, ctx))
  return (branch.groupsOperator || 'AND') === 'OR' ? results.some(Boolean) : results.every(Boolean)
}

/** Devuelve el handle de salida que corresponde según la condición */
export function evaluateConditionNode(config, ctx) {
  const branches = Array.isArray(config?.branches) ? config.branches : []
  if (branches.length <= 1) {
    const met = branches.length === 1 ? evaluateBranch(branches[0], ctx) : false
    return { handle: met ? 'yes' : 'no', label: met ? 'Sí' : 'No' }
  }
  for (let index = 0; index < branches.length; index += 1) {
    if (evaluateBranch(branches[index], ctx)) {
      const id = str(branches[index].id) || `branch-${index + 1}`
      return { handle: id, label: str(branches[index].name) || `Rama ${index + 1}` }
    }
  }
  return { handle: 'none', label: 'Ninguna' }
}

// ---------------------------------------------------------------------------
// Inscripciones: persistencia y bitácora
// ---------------------------------------------------------------------------

async function saveEnrollment(enrollment) {
  await db.run(
    `UPDATE automation_enrollments
     SET status = ?, current_node_id = ?, log = ?, resume_at = ?, wait_kind = ?, context = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      enrollment.status,
      enrollment.currentNodeId,
      JSON.stringify(enrollment.log),
      enrollment.resumeAt || null,
      enrollment.waitKind || null,
      JSON.stringify(enrollment.context || {}),
      enrollment.id
    ]
  )
}

function addLog(enrollment, entry) {
  enrollment.log.push({ at: nowIso(), ...entry })
  if (enrollment.log.length > 200) enrollment.log = enrollment.log.slice(-200)
}

async function createEnrollment(automation, contact, ctx) {
  const id = makeId('enr')
  const enrollment = {
    id,
    automationId: automation.id,
    status: 'active',
    currentNodeId: 'start',
    log: [],
    resumeAt: null,
    waitKind: null,
    context: {
      messageText: ctx.messageText || '',
      channel: ctx.channel || '',
      businessPhoneNumberId: ctx.businessPhoneNumberId || null
    }
  }
  await db.run(
    `INSERT INTO automation_enrollments
       (id, automation_id, contact_id, contact_name, status, current_node_id, log, context)
     VALUES (?, ?, ?, ?, 'active', 'start', '[]', '{}')`,
    [id, automation.id, contact.id || null, contact.fullName || contact.phone || 'Contacto']
  )
  return enrollment
}

// ---------------------------------------------------------------------------
// Ejecución de nodos
// ---------------------------------------------------------------------------

const DURATION_MS = {
  seconds: 1000,
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000
}

async function applyTagAction(node, ctx, remove) {
  const tag = str(node.config?.tag)
  if (!tag || !ctx.contact?.id) return `Etiqueta no aplicada (sin ${tag ? 'contacto' : 'etiqueta'})`
  // La config puede traer el ID del catálogo (editor nuevo) o el nombre
  // (automatizaciones viejas); siempre se guarda el ID en contacts.tags.
  const [tagId] = await resolveTagIds([tag], { createMissing: !remove })
  const [tagName] = tagId ? await tagNamesForIds([tagId]) : []
  const displayName = tagName || tag
  const row = await db.get('SELECT tags FROM contacts WHERE id = ?', [ctx.contact.id])
  const tags = parseJson(row?.tags, [])
  const list = Array.isArray(tags) ? tags : []
  const next = remove
    ? list.filter((candidate) => candidate !== tagId && normalizeText(candidate) !== normalizeText(tag))
    : [...new Set([...list, tagId].filter(Boolean))]
  await db.run('UPDATE contacts SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
    JSON.stringify(next),
    ctx.contact.id
  ])
  ctx.contact.tags = next
  // El cambio de etiqueta puede disparar otras automatizaciones
  setImmediate(() => {
    handleAutomationEvent('tag-changed', {
      contactId: ctx.contact.id,
      tag: displayName,
      tagId: tagId || null,
      tagAction: remove ? 'removed' : 'added'
    }).catch(() => undefined)
  })
  return remove ? `Etiqueta "${displayName}" quitada` : `Etiqueta "${displayName}" añadida`
}

/** Envía un bloque adjunto: si es un archivo subido a Ristak se manda como
    data URL (el servicio de WhatsApp lo publica); si es URL externa, directo */
async function sendMediaBlock({ block, to, phoneNumberId, ctx }) {
  const {
    sendWhatsAppApiImageMessage,
    sendWhatsAppApiAudioMessage,
    sendWhatsAppApiDocumentMessage
  } = await import('./whatsappApiService.js')

  const caption = renderTemplate(str(block.caption), ctx).trim() || undefined
  let dataUrl = null
  let externalUrl = null
  let filename = str(block.caption) || 'archivo'
  let mimeType

  const assetMatch = /\/api\/automations\/assets\/([\w-]+)/.exec(str(block.url))
  if (assetMatch) {
    const row = await db.get('SELECT * FROM automation_assets WHERE id = ?', [assetMatch[1]])
    if (!row) throw new Error('El archivo adjunto ya no existe')
    dataUrl = `data:${row.content_type};base64,${row.content_base64}`
    mimeType = row.content_type
    filename = row.filename || filename
  } else {
    externalUrl = str(block.url)
  }

  if (block.type === 'image') {
    await sendWhatsAppApiImageMessage({ to, imageDataUrl: dataUrl || undefined, imageUrl: externalUrl || undefined, caption, phoneNumberId })
  } else if (block.type === 'audio') {
    await sendWhatsAppApiAudioMessage({
      to,
      audioDataUrl: dataUrl || undefined,
      audioUrl: externalUrl || undefined,
      // Nota de voz de WhatsApp (ogg/opus) salvo que el usuario lo apague
      voice: block.voiceNote !== false,
      phoneNumberId
    })
  } else {
    // video y archivo se envían como documento (conserva calidad y nombre)
    await sendWhatsAppApiDocumentMessage({
      to,
      documentDataUrl: dataUrl || undefined,
      documentUrl: externalUrl || undefined,
      filename,
      mimeType,
      caption,
      phoneNumberId
    })
  }
}

async function sendWhatsAppBlocks(node, ctx) {
  const { sendWhatsAppApiTextMessage, sendWhatsAppApiTemplateMessage } = await import('./whatsappApiService.js')
  const config = node.config || {}
  const to = ctx.contact?.phone
  if (!to) throw new Error('El contacto no tiene teléfono')

  // Remitente: último número donde escribió > principal > específico
  let phoneNumberId
  if (str(config.sender) === 'specific' && str(config.senderNumberId)) {
    phoneNumberId = str(config.senderNumberId)
  } else if (str(config.sender) !== 'default' && ctx.businessPhoneNumberId) {
    phoneNumberId = ctx.businessPhoneNumberId
  }

  if (str(config.messageType) === 'template') {
    const blocks = Array.isArray(config.messageBlocks) ? config.messageBlocks : []
    const sequence = blocks.filter((block) => block.type === 'template' || block.type === 'delay')
    // Compatibilidad: configs viejas con un solo templateId suelto
    if (!sequence.some((block) => block.type === 'template') && str(config.templateId)) {
      sequence.push({ type: 'template', templateId: str(config.templateId), templateName: str(config.templateName) })
    }
    const sentNames = []
    for (const block of sequence) {
      if (block.type === 'delay') {
        const seconds = Math.min(
          MAX_INLINE_DELAY_SECONDS,
          Math.max(0, (Number(block.amount) || 0) * (block.unit === 'minutes' ? 60 : 1))
        )
        if (seconds > 0) await sleep(seconds * 1000)
      } else if (str(block.templateId) || str(block.templateName)) {
        // Variables {{n}}: se rellenan con datos del contacto si traen tokens
        const rawVariables = block.templateVariables || {}
        const variables = {}
        Object.entries(rawVariables).forEach(([key, value]) => {
          const rendered = renderTemplate(String(value ?? ''), ctx).trim()
          if (rendered) variables[key] = rendered
        })

        // Encabezado multimedia: el archivo subido se publica y va como link
        let components
        const headerUrl = str(block.headerMediaUrl)
        if (headerUrl) {
          const { saveWhatsAppImageDataUrl, buildLocalMediaUrl } = await import('./whatsappApiService.js')
          let link = headerUrl
          const assetMatch = /\/api\/automations\/assets\/([\w-]+)/.exec(headerUrl)
          if (assetMatch) {
            const row = await db.get('SELECT * FROM automation_assets WHERE id = ?', [assetMatch[1]])
            if (row && row.content_type.startsWith('image/')) {
              const media = await saveWhatsAppImageDataUrl(`data:${row.content_type};base64,${row.content_base64}`)
              link = buildLocalMediaUrl(media)
            }
          }
          if (link && /^https?:/.test(link)) {
            components = [
              { type: 'header', parameters: [{ type: 'image', image: { link } }] },
              ...(Object.keys(variables).length
                ? [{
                    type: 'body',
                    parameters: Object.keys(variables)
                      .sort((a, b) => Number(a) - Number(b))
                      .map((key) => ({ type: 'text', text: variables[key] }))
                  }]
                : [])
            ]
          }
        }

        await sendWhatsAppApiTemplateMessage({
          to,
          templateId: str(block.templateId) || undefined,
          templateName: str(block.templateName) || undefined,
          ...(components ? { components } : { variables }),
          phoneNumberId
        })
        sentNames.push(str(block.templateName) || str(block.templateId))
      }
    }
    if (sentNames.length === 0) throw new Error('No hay plantilla seleccionada')
    return sentNames.length === 1
      ? `Plantilla "${sentNames[0]}" enviada`
      : `${sentNames.length} plantillas enviadas (${sentNames.join(', ')})`
  }

  const blocks = Array.isArray(config.messageBlocks) ? config.messageBlocks : []
  let sent = 0
  const notes = []
  for (const block of blocks) {
    if (block.type === 'text') {
      const text = renderTemplate(str(block.compiledText), ctx).trim()
      if (!text) continue
      const buttons = Array.isArray(block.buttons) ? block.buttons.filter((b) => str(b.label).trim()) : []
      const body = buttons.length
        ? `${text}\n\n${buttons.map((b) => `▸ ${b.label.trim()}`).join('\n')}`
        : text
      await sendWhatsAppApiTextMessage({ to, text: body, phoneNumberId })
      sent += 1
    } else if (block.type === 'delay') {
      const seconds = Math.min(
        MAX_INLINE_DELAY_SECONDS,
        Math.max(0, (Number(block.amount) || 0) * (block.unit === 'minutes' ? 60 : 1))
      )
      if (seconds > 0) await sleep(seconds * 1000)
    } else if (['image', 'video', 'audio', 'file'].includes(block.type) && str(block.url)) {
      await sendMediaBlock({ block, to, phoneNumberId, ctx })
      sent += 1
    } else {
      notes.push(`adjunto "${block.type}" sin archivo: omitido`)
    }
  }
  if (sent === 0) throw new Error('El mensaje está vacío: configura al menos un globo de texto')
  return `${sent} mensaje${sent > 1 ? 's' : ''} de WhatsApp enviado${sent > 1 ? 's' : ''}${notes.length ? ` (${notes.join(', ')})` : ''}`
}

/**
 * Ejecuta un nodo. Devuelve:
 *  { handle, detail }            → continuar por esa salida
 *  { wait: {kind, resumeAt}, detail } → pausar la inscripción
 *  { skipped: true, handle }     → paso no soportado, se registra y continúa
 */
async function executeNode(node, ctx) {
  switch (node.type) {
    case 'channel-whatsapp':
      return { handle: 'out', detail: await sendWhatsAppBlocks(node, ctx) }

    case 'logic-wait': {
      const config = node.config || {}
      const mode = str(config.mode)
      if (mode === 'duration') {
        const ms = (Number(config.amount) || 0) * (DURATION_MS[str(config.unit) || 'hours'] || DURATION_MS.hours)
        return {
          wait: { kind: 'duration', resumeAt: new Date(Date.now() + ms).toISOString() },
          detail: `Esperando ${config.amount} ${str(config.unit) || 'hours'}`
        }
      }
      if (mode === 'until-datetime' && str(config.untilDatetime)) {
        return {
          wait: { kind: 'duration', resumeAt: new Date(config.untilDatetime).toISOString() },
          detail: `Esperando hasta ${config.untilDatetime}`
        }
      }
      if (mode === 'reply') {
        const timeoutMs = config.timeoutEnabled
          ? (Number(config.timeoutAmount) || 0) * (DURATION_MS[str(config.timeoutUnit) || 'hours'] || DURATION_MS.hours)
          : 0
        return {
          wait: {
            kind: 'reply',
            resumeAt: timeoutMs > 0 ? new Date(Date.now() + timeoutMs).toISOString() : null
          },
          detail: 'Esperando la respuesta del contacto'
        }
      }
      return { skipped: true, handle: 'out', detail: `Espera "${mode}" aún no soportada: continúa` }
    }

    case 'logic-condition': {
      const result = evaluateConditionNode(node.config, ctx)
      return { handle: result.handle, detail: `Condición evaluada → ${result.label}` }
    }

    case 'logic-goal':
      return { handle: 'out', detail: 'Objetivo registrado' }

    case 'action-add-contact-tag':
      return { handle: 'out', detail: await applyTagAction(node, ctx, false) }

    case 'action-remove-contact-tag':
      return { handle: 'out', detail: await applyTagAction(node, ctx, true) }

    default:
      return { skipped: true, handle: 'out', detail: 'Paso aún no soportado por el motor: se omitió' }
  }
}

// ---------------------------------------------------------------------------
// Recorrido del flujo
// ---------------------------------------------------------------------------

async function runFrom(flow, enrollment, startNodeId, ctx) {
  let currentId = startNodeId
  let steps = 0

  while (currentId && steps < MAX_STEPS) {
    steps += 1
    const node = getNode(flow, currentId)
    if (!node) {
      addLog(enrollment, { nodeId: currentId, label: 'Paso', status: 'error', detail: 'El paso ya no existe en el flujo' })
      enrollment.status = 'exited'
      break
    }

    enrollment.currentNodeId = node.id
    let result
    try {
      result = await executeNode(node, ctx)
    } catch (error) {
      addLog(enrollment, { nodeId: node.id, label: nodeLabel(node), status: 'error', detail: error.message })
      enrollment.status = 'exited'
      logger.warn(`[Automatizaciones] Error en paso ${node.type}: ${error.message}`)
      break
    }

    if (result.wait) {
      addLog(enrollment, { nodeId: node.id, label: nodeLabel(node), status: 'waiting', detail: result.detail })
      enrollment.status = 'waiting'
      enrollment.waitKind = result.wait.kind
      enrollment.resumeAt = result.wait.resumeAt
      break
    }

    addLog(enrollment, {
      nodeId: node.id,
      label: nodeLabel(node),
      status: result.skipped ? 'skipped' : 'ok',
      detail: result.detail
    })

    const edge = edgesFrom(flow, node.id, result.handle)[0] || (node.type === 'start' ? edgesFrom(flow, node.id)[0] : null)
    if (!edge) {
      enrollment.status = 'completed'
      addLog(enrollment, { nodeId: node.id, label: nodeLabel(node), status: 'ok', detail: 'Fin del flujo' })
      break
    }
    currentId = edge.targetNodeId
  }

  if (steps >= MAX_STEPS) {
    enrollment.status = 'exited'
    addLog(enrollment, { nodeId: currentId, label: 'Flujo', status: 'error', detail: 'Límite de pasos alcanzado (posible ciclo)' })
  }

  await saveEnrollment(enrollment)
}

// ---------------------------------------------------------------------------
// Entradas del motor
// ---------------------------------------------------------------------------

async function loadContact(contactId, fallback = {}) {
  const row = contactId ? await db.get('SELECT * FROM contacts WHERE id = ?', [contactId]) : null
  const custom = parseJson(row?.custom_fields, {})
  const bag = typeof custom === 'object' && custom !== null && !Array.isArray(custom) ? custom : {}
  const storedTags = (() => {
    const parsed = parseJson(row?.tags, [])
    return Array.isArray(parsed) ? parsed : []
  })()
  // tagKeys: IDs del catálogo + nombres (configs viejas guardaban el nombre) +
  // etiquetas internas calculadas (Cliente, Cita agendada, Prospecto); es lo
  // que usan filtros y condiciones para comparar.
  const tagKeys = await buildTagMatchKeys(row?.id || contactId || null, storedTags)
    .then((keys) => [...keys])
    .catch(() => storedTags)
  return {
    id: row?.id || contactId || null,
    firstName: row?.first_name || '',
    lastName: row?.last_name || '',
    fullName: row?.full_name || fallback.name || '',
    phone: row?.phone || fallback.phone || '',
    email: row?.email || '',
    source: row?.source || bag.source || '',
    country: row?.country || bag.country || '',
    customFields: bag,
    tags: storedTags,
    tagKeys
  }
}

async function listPublishedAutomations() {
  const rows = await db.all(`SELECT id, name, flow FROM automations WHERE status = 'published'`)
  return rows.map((row) => ({ id: row.id, name: row.name, flow: parseJson(row.flow, { nodes: [], edges: [] }) }))
}

/** Evento principal: llega un mensaje entrante (WhatsApp por ahora) */
export async function handleIncomingMessage({ contactId, phone, contactName, text, channel = 'whatsapp', businessPhoneNumberId = null }) {
  try {
    const contact = await loadContact(contactId, { phone, name: contactName })
    const baseCtx = { contact, messageText: text || '', channel, businessPhoneNumberId }
    const automations = await listPublishedAutomations()

    // 1) Reanudar inscripciones que esperaban respuesta de este contacto
    const waiting = await db.all(
      `SELECT * FROM automation_enrollments WHERE contact_id = ? AND status = 'waiting' AND wait_kind = 'reply'`,
      [contact.id]
    )
    for (const row of waiting) {
      const automation = automations.find((candidate) => candidate.id === row.automation_id)
      if (!automation) continue
      const enrollment = {
        id: row.id,
        automationId: row.automation_id,
        status: 'active',
        currentNodeId: row.current_node_id,
        log: parseJson(row.log, []),
        resumeAt: null,
        waitKind: null,
        context: parseJson(row.context, {})
      }
      const ctx = { ...baseCtx, businessPhoneNumberId: businessPhoneNumberId || enrollment.context.businessPhoneNumberId }
      addLog(enrollment, { nodeId: row.current_node_id, label: 'Esperar', status: 'ok', detail: 'El contacto respondió' })
      const edge = edgesFrom(automation.flow, row.current_node_id, 'out')[0]
      if (edge) await runFrom(automation.flow, enrollment, edge.targetNodeId, ctx)
      else {
        enrollment.status = 'completed'
        await saveEnrollment(enrollment)
      }
    }

    // 2) Detener flujos configurados con "salir al responder"
    for (const automation of automations) {
      if (automation.flow?.settings?.stopOnContactResponse) {
        await db.run(
          `UPDATE automation_enrollments SET status = 'exited', updated_at = CURRENT_TIMESTAMP
           WHERE automation_id = ? AND contact_id = ? AND status IN ('active', 'waiting') AND wait_kind IS DISTINCT FROM 'reply'`,
          [automation.id, contact.id]
        ).catch(async () => {
          // SQLite no soporta IS DISTINCT FROM
          await db.run(
            `UPDATE automation_enrollments SET status = 'exited', updated_at = CURRENT_TIMESTAMP
             WHERE automation_id = ? AND contact_id = ? AND status IN ('active', 'waiting') AND (wait_kind IS NULL OR wait_kind != 'reply')`,
            [automation.id, contact.id]
          )
        })
      }
    }

    // 3) Inscribir en automatizaciones cuyo disparador coincide
    await enrollMatching(automations, 'message-received', baseCtx)
  } catch (error) {
    logger.error(`[Automatizaciones] Error procesando mensaje entrante: ${error.message}`)
  }
}

async function enrollMatching(automations, eventType, baseCtx) {
  const contact = baseCtx.contact || {}
  for (const automation of automations) {
    const flow = automation.flow
    const startNode = getStartNode(flow)
    if (!startNode) continue
    const matched = getTriggers(startNode).find((trigger) => triggerMatches(trigger, eventType, baseCtx))
    if (!matched) continue

    const settings = flow.settings || {}
    if (contact.id && settings.preventDuplicateActiveEnrollment !== false) {
      const active = await db.get(
        `SELECT id FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? AND status IN ('active','waiting')`,
        [automation.id, contact.id]
      )
      if (active) continue
    }
    if (contact.id && settings.allowReentry === false) {
      const any = await db.get(
        `SELECT id FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?`,
        [automation.id, contact.id]
      )
      if (any) continue
    }

    const ctx = { ...baseCtx, automationName: automation.name }
    const enrollment = await createEnrollment(automation, contact, ctx)
    const describe = EVENT_DESCRIPTIONS[eventType]
    addLog(enrollment, {
      nodeId: 'start',
      label: 'Cuando...',
      status: 'ok',
      detail: `Disparador: ${describe ? describe(ctx) : eventType}`
    })
    const edge = edgesFrom(flow, startNode.id)[0]
    if (edge) {
      logger.info(`[Automatizaciones] "${automation.name}": inscrito ${contact.fullName || contact.phone || 'contacto'} (${eventType})`)
      await runFrom(flow, enrollment, edge.targetNodeId, ctx)
    } else {
      addLog(enrollment, { nodeId: 'start', label: 'Cuando...', status: 'error', detail: 'El disparador no está conectado a ningún paso' })
      enrollment.status = 'exited'
      await saveEnrollment(enrollment)
    }
  }
}

/**
 * Entrada genérica para cualquier evento del CRM.
 * data: { contactId?, phone?, email?, contactName?, ...campos del evento }
 */
export async function handleAutomationEvent(eventType, data = {}) {
  try {
    let contact = await loadContact(data.contactId, { phone: data.phone, name: data.contactName })
    // Resolver contacto por teléfono o email cuando no llega id (webhooks)
    if (!contact.id && (data.phone || data.email)) {
      const row = await db.get(
        'SELECT id FROM contacts WHERE (phone = ? AND ? != \'\') OR (email = ? AND ? != \'\') LIMIT 1',
        [data.phone || '', data.phone || '', data.email || '', data.email || '']
      )
      if (row) contact = await loadContact(row.id)
    }
    const ctx = { ...data, contact, messageText: data.messageText || '', channel: data.channel || '' }
    const automations = await listPublishedAutomations()
    await enrollMatching(automations, eventType, ctx)
  } catch (error) {
    logger.error(`[Automatizaciones] Error en evento ${eventType}: ${error.message}`)
  }
}

/** Tick del programador: reanuda esperas vencidas (duración o timeout) */
export async function processDueResumes() {
  try {
    const rows = await db.all(
      `SELECT * FROM automation_enrollments
       WHERE status = 'waiting' AND resume_at IS NOT NULL AND resume_at <= ?
       LIMIT 50`,
      [nowIso()]
    )
    if (rows.length === 0) return
    const automations = await listPublishedAutomations()

    for (const row of rows) {
      const automation = automations.find((candidate) => candidate.id === row.automation_id)
      const enrollment = {
        id: row.id,
        automationId: row.automation_id,
        status: 'active',
        currentNodeId: row.current_node_id,
        log: parseJson(row.log, []),
        resumeAt: null,
        waitKind: null,
        context: parseJson(row.context, {})
      }
      if (!automation) {
        enrollment.status = 'exited'
        addLog(enrollment, { nodeId: row.current_node_id, label: 'Flujo', status: 'error', detail: 'La automatización ya no está publicada' })
        await saveEnrollment(enrollment)
        continue
      }
      const contact = await loadContact(row.contact_id)
      const ctx = {
        contact,
        messageText: enrollment.context.messageText || '',
        channel: enrollment.context.channel || 'whatsapp',
        businessPhoneNumberId: enrollment.context.businessPhoneNumberId || null,
        automationName: automation.name
      }
      const wasReplyTimeout = row.wait_kind === 'reply'
      const handle = wasReplyTimeout ? 'timeout' : 'out'
      addLog(enrollment, {
        nodeId: row.current_node_id,
        label: 'Esperar',
        status: 'ok',
        detail: wasReplyTimeout ? 'No respondió a tiempo' : 'Espera terminada'
      })
      const edge = edgesFrom(automation.flow, row.current_node_id, handle)[0]
      if (edge) await runFrom(automation.flow, enrollment, edge.targetNodeId, ctx)
      else {
        enrollment.status = 'completed'
        addLog(enrollment, { nodeId: row.current_node_id, label: 'Esperar', status: 'ok', detail: 'Fin del flujo' })
        await saveEnrollment(enrollment)
      }
    }
  } catch (error) {
    logger.error(`[Automatizaciones] Error reanudando esperas: ${error.message}`)
  }
}

let schedulerStarted = false

/** Arranca el tick del programador (idempotente) */
export function startAutomationScheduler(intervalMs = 20000) {
  if (schedulerStarted) return
  schedulerStarted = true
  setInterval(() => {
    processDueResumes().catch(() => undefined)
  }, intervalMs)
  logger.info('⚙️ Motor de automatizaciones activo (tick cada 20s)')
}
