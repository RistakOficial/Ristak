/**
 * Validación y normalización del flujo de una automatización.
 *
 * El flujo se guarda como JSON flexible: { nodes: [], edges: [], viewport: {} }.
 * Estas funciones son puras (sin acceso a BD) para poder probarlas de forma
 * aislada y reutilizarlas desde el servicio al guardar o publicar.
 */

const MAX_FLOW_BYTES = 2 * 1024 * 1024 // 2MB: límite defensivo para el JSON del flujo

export const START_NODE_TYPE = 'start'
const TRIGGER_LINK_WAIT_ACTIONS = new Set(['click_link', 'trigger_link_click', 'trigger-link-click'])
const REPLY_MESSAGE_WAIT_ACTIONS = new Set(['reply_message', 'reply-message'])
const APPOINTMENT_PAST_DUE_ACTIONS = new Set(['auto', 'continue', 'next_wait', 'specific_node', 'exit'])
const SENT_MESSAGE_NODE_TYPES = new Set(['channel-whatsapp', 'channel-messenger', 'channel-instagram'])
const DRIP_INTERVAL_UNITS = new Set(['minutes', 'hours', 'days'])
const DEFAULT_REPLY_ACTION_CHANNELS = new Set(['whatsapp', 'messenger', 'instagram', 'email'])
const SUPPORTED_GOAL_TYPES = new Set([
  'tag',
  'payment',
  'appointment',
  'form',
  'link',
  'conversation',
  'contact',
  'ads',
  'custom',
  'advanced'
])
const GOAL_EVALUATION_MODES = new Set(['immediate', 'during-automation', 'window'])
const GOAL_ON_MET_ACTIONS = new Set(['end-automation', 'end-branch', 'continue', 'remove'])
const GOAL_ON_NOT_MET_ACTIONS = new Set(['continue', 'wait', 'timeout-branch'])
const GOAL_WINDOW_MODES = new Set(['none', 'duration', 'until'])
const GOAL_TAG_OPERATORS = new Set(['has', 'received', 'lost', 'not_has', 'not-has', 'nothas'])
const GOAL_PAYMENT_EVENTS = new Set(['received', 'failed', 'refund'])
const GOAL_PAYMENT_AMOUNT_OPERATORS = new Set(['any', 'gt', 'gte', 'lt', 'lte', 'eq'])
const GOAL_APPOINTMENT_STATUSES = new Set([
  'booked',
  'confirmed',
  'cancelled',
  'rescheduled',
  'no_show',
  'completed',
  'attended',
  'showed'
])
const GOAL_CONVERSATION_EVENTS = new Set(['replied', 'keyword', 'no_reply'])
const GOAL_CONTACT_EVENTS = new Set(['created', 'updated', 'field_contains', 'assigned'])
const GOAL_ADS_EVENTS = new Set(['fb_click', 'ctwa'])
const GOAL_LINK_EVENTS = new Set(['clicked', 'activation'])
const FILTER_OPERATORS_WITHOUT_VALUE = new Set([
  'empty',
  'not_empty',
  'yes',
  'no',
  'is_disqualified',
  'not_disqualified'
])
const SUPPORTED_FILTER_OPERATORS = new Set([
  'is',
  'not',
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  ...FILTER_OPERATORS_WITHOUT_VALUE
])
const FILTER_FIELDS_REQUIRING_KEY = new Set(['custom', 'form_field', 'form-field-value'])

// Únicos canales conversacionales soportados (sin SMS ni Email)
export const ALLOWED_CHANNELS = ['whatsapp', 'messenger', 'instagram']

// (AUTO-001) Tipos de paso que el motor (executeNode en automationEngine.js) sabe
// ejecutar. Cualquier otro cae en el `default` del motor y se omite en silencio,
// cortando el flujo (sobre todo en nodos ramificados como el aleatorizador). Por eso
// bloqueamos la publicación de flujos con pasos que el motor no ejecuta.
// IMPORTANTE: mantener en sync con el switch de executeNode.
const EXECUTABLE_NODE_TYPES = new Set([
  START_NODE_TYPE,
  'channel-whatsapp',
  'channel-messenger',
  'channel-instagram',
  'channel-comment-public-reply',
  'channel-comment-dm-reply',
  'channel-email',
  'logic-wait',
  'logic-drip',
  'logic-condition',
  'logic-goal',
  'randomizer',
  'action-create-contact',
  'action-find-contact',
  'action-change-whatsapp-number',
  'action-set-default-reply-channel',
  'action-webhook',
  'action-contact-tag',
  'action-add-contact-tag',
  'action-remove-contact-tag',
  'action-contact-user',
  'action-assign-user',
  'action-unassign-user',
  'action-appointment-upsert',
  'action-appointment-confirmation',
  'action-system-notification'
])

// (AUTO-002) Disparadores que el motor (triggerMatches en automationEngine.js)
// realmente reconoce y que algún controlador emite. Si un disparador no está aquí,
// una automatización con él no debe publicarse porque nunca correría.
// IMPORTANTE: mantener en sync con triggerMatches.
const SUPPORTED_TRIGGER_TYPES = new Set([
  'trigger-whatsapp-message',
  'trigger-click-to-whatsapp',
  'trigger-instagram-message',
  'trigger-messenger-message',
  'trigger-facebook-comment',
  'trigger-instagram-comment',
  'trigger-email-message',
  'trigger-customer-replied',
  'trigger-contact-created',
  'trigger-contact-updated',
  'trigger-contact-tag',
  'trigger-form-submitted',
  'trigger-scheduler',
  'trigger-appointment-booked',
  'trigger-appointment-status',
  'trigger-payment-received',
  'trigger-refund',
  'trigger-incoming-webhook',
  'trigger-activation-link',
  'trigger-link-clicked'
])
const CHANNEL_CONFIG_KEYS = ['channel', 'replyChannel', 'conversationChannel', 'actionChannel']
const COMMENT_TRIGGER_TYPES = new Set(['trigger-facebook-comment', 'trigger-instagram-comment'])
const COMMENT_REPLY_MEDIA_BLOCKS = new Set(['image', 'video', 'audio', 'voice', 'file'])
const COMMENT_REPLY_TARGETS = {
  facebook_public_comment: {
    label: 'responder comentario público en Facebook',
    eventPlatform: 'facebook',
    delivery: 'public',
    apiChannel: 'messenger',
    allowedBlockTypes: new Set(['text', 'image'])
  },
  instagram_public_comment: {
    label: 'responder comentario público en Instagram',
    eventPlatform: 'instagram',
    delivery: 'public',
    apiChannel: 'instagram',
    allowedBlockTypes: new Set(['text'])
  },
  messenger_private_message: {
    label: 'enviar mensaje privado por Messenger',
    eventPlatform: 'facebook',
    delivery: 'private',
    apiChannel: 'messenger',
    allowedBlockTypes: new Set(['text'])
  },
  instagram_private_message: {
    label: 'enviar mensaje privado por Instagram DM',
    eventPlatform: 'instagram',
    delivery: 'private',
    apiChannel: 'instagram',
    allowedBlockTypes: new Set(['text'])
  }
}

const AUTOMATION_NODE_REQUIRED_FEATURES = {
  'channel-whatsapp': ['whatsapp'],
  'channel-email': ['email'],
  'channel-messenger': ['campaigns'],
  'channel-instagram': ['campaigns'],
  'channel-comment-public-reply': ['campaigns'],
  'channel-comment-dm-reply': ['campaigns'],
  'action-change-whatsapp-number': ['whatsapp'],
  'action-appointment-upsert': ['appointments'],
  'action-appointment-confirmation': ['appointments', 'whatsapp'],
  'action-webhook': ['developers'],
  'ai-step': ['ai_agent'],
  'ai-gpt-openai': ['ai_agent']
}

const AUTOMATION_TRIGGER_REQUIRED_FEATURES = {
  'trigger-whatsapp-message': ['whatsapp'],
  'trigger-click-to-whatsapp': ['whatsapp', 'campaigns'],
  'trigger-instagram-message': ['campaigns'],
  'trigger-messenger-message': ['campaigns'],
  'trigger-facebook-comment': ['campaigns'],
  'trigger-instagram-comment': ['campaigns'],
  'trigger-email-message': ['email'],
  'trigger-form-submitted': ['forms'],
  'trigger-appointment-booked': ['appointments'],
  'trigger-appointment-status': ['appointments'],
  'trigger-payment-received': ['payments'],
  'trigger-refund': ['payments'],
  'trigger-incoming-webhook': ['developers'],
  'trigger-activation-link': ['trigger_links'],
  'trigger-link-clicked': ['trigger_links']
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasSampleResponse(value) {
  if (Array.isArray(value)) return value.length > 0
  return isPlainObject(value) && Object.keys(value).length > 0
}

function uniqueFeatures(features = []) {
  return features
    .filter(Boolean)
    .filter((feature, index, all) => all.indexOf(feature) === index)
}

export function getAutomationTriggerRequiredFeatures(trigger = {}) {
  return uniqueFeatures(AUTOMATION_TRIGGER_REQUIRED_FEATURES[String(trigger?.type || '')] || [])
}

export function getAutomationNodeRequiredFeatures(node = {}) {
  const features = [...(AUTOMATION_NODE_REQUIRED_FEATURES[String(node?.type || '')] || [])]
  if (String(node?.type || '') === 'action-set-default-reply-channel') {
    const channel = String(node?.config?.channel || '').trim().toLowerCase()
    if (channel === 'whatsapp') features.push('whatsapp')
    if (channel === 'messenger' || channel === 'instagram') features.push('campaigns')
    if (channel === 'email') features.push('email')
  }
  const triggers = asArray(node?.config?.triggers)
  for (const trigger of triggers) {
    features.push(...getAutomationTriggerRequiredFeatures(trigger))
  }
  return uniqueFeatures(features)
}

export function collectAutomationFlowRequiredFeatures(flow = {}) {
  const features = []
  for (const node of asArray(flow?.nodes)) {
    features.push(...getAutomationNodeRequiredFeatures(node))
  }
  return uniqueFeatures(features)
}

/**
 * Normaliza un flujo recibido del cliente a la forma { nodes, edges, viewport }.
 * No valida reglas de negocio: solo garantiza estructura segura para persistir.
 * Lanza error (status 400) si la estructura es inválida o demasiado grande.
 */
export function normalizeFlow(rawFlow) {
  if (rawFlow === null || rawFlow === undefined) {
    return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
  }

  if (!isPlainObject(rawFlow)) {
    const error = new Error('El flujo de la automatización tiene un formato inválido')
    error.status = 400
    throw error
  }

  const nodes = asArray(rawFlow.nodes).filter(isPlainObject).map((node) => ({
    ...node,
    id: String(node.id || ''),
    type: String(node.type || ''),
    position: isPlainObject(node.position)
      ? { x: Number(node.position.x) || 0, y: Number(node.position.y) || 0 }
      : { x: 0, y: 0 },
    config: isPlainObject(node.config) ? node.config : {}
  }))

  const edges = asArray(rawFlow.edges).filter(isPlainObject).map((edge) => ({
    ...edge,
    id: String(edge.id || ''),
    sourceNodeId: String(edge.sourceNodeId || ''),
    targetNodeId: String(edge.targetNodeId || ''),
    sourceHandle: edge.sourceHandle ? String(edge.sourceHandle) : 'out',
    targetHandle: edge.targetHandle ? String(edge.targetHandle) : 'in',
    animated: edge.animated !== false
  }))

  const viewport = isPlainObject(rawFlow.viewport)
    ? {
        x: Number(rawFlow.viewport.x) || 0,
        y: Number(rawFlow.viewport.y) || 0,
        zoom: Math.min(2.5, Math.max(0.2, Number(rawFlow.viewport.zoom) || 1))
      }
    : { x: 0, y: 0, zoom: 1 }

  const invalidNode = nodes.find((node) => !node.id || !node.type)
  if (invalidNode) {
    const error = new Error('Hay pasos del flujo sin identificador o tipo')
    error.status = 400
    throw error
  }

  // Configuración global del flujo (zona horaria, horarios, reingreso…):
  // se preserva tal cual, es un objeto flexible definido por el editor.
  const settings = isPlainObject(rawFlow.settings) ? rawFlow.settings : undefined

  const flow = settings ? { nodes, edges, viewport, settings } : { nodes, edges, viewport }
  const size = Buffer.byteLength(JSON.stringify(flow), 'utf8')
  if (size > MAX_FLOW_BYTES) {
    const error = new Error('El flujo de la automatización es demasiado grande para guardarse')
    error.status = 400
    throw error
  }

  return flow
}

function detectCycle(nodes, edges) {
  const adjacency = new Map()
  nodes.forEach((node) => adjacency.set(node.id, []))
  edges.forEach((edge) => {
    if (adjacency.has(edge.sourceNodeId)) {
      adjacency.get(edge.sourceNodeId).push(edge.targetNodeId)
    }
  })

  const visiting = new Set()
  const visited = new Set()

  const visit = (nodeId) => {
    if (visiting.has(nodeId)) return true
    if (visited.has(nodeId)) return false
    visiting.add(nodeId)
    for (const next of adjacency.get(nodeId) || []) {
      if (visit(next)) return true
    }
    visiting.delete(nodeId)
    visited.add(nodeId)
    return false
  }

  return nodes.some((node) => visit(node.id))
}

function hasPath(edges, from, to) {
  if (from === to) return true
  const adjacency = new Map()
  edges.forEach((edge) => {
    const list = adjacency.get(edge.sourceNodeId) || []
    list.push(edge.targetNodeId)
    adjacency.set(edge.sourceNodeId, list)
  })

  const queue = [from]
  const visited = new Set([from])
  while (queue.length > 0) {
    const current = queue.shift()
    for (const next of adjacency.get(current) || []) {
      if (next === to) return true
      if (!visited.has(next)) {
        visited.add(next)
        queue.push(next)
      }
    }
  }
  return false
}

function nextDownstreamWaitNode(nodes, edges, sourceNodeId) {
  if (!sourceNodeId) return null
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const adjacency = new Map()
  for (const edge of edges) {
    const targets = adjacency.get(edge.sourceNodeId) || []
    targets.push(edge.targetNodeId)
    adjacency.set(edge.sourceNodeId, targets)
  }
  const queue = [...(adjacency.get(sourceNodeId) || [])]
  const visited = new Set([sourceNodeId])
  const candidates = new Map()
  while (queue.length > 0) {
    const nodeId = queue.shift()
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    const node = nodesById.get(nodeId)
    if (!node) continue
    if (node.type === 'logic-wait') {
      candidates.set(node.id, node)
      continue
    }
    for (const nextNodeId of adjacency.get(nodeId) || []) {
      if (!visited.has(nextNodeId)) queue.push(nextNodeId)
    }
  }
  return candidates.size === 1 ? [...candidates.values()][0] : null
}

function appointmentPastDueRoutingEdges(nodes, edges) {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const routingEdges = nodes.flatMap((node) => {
    const config = isPlainObject(node.config) ? node.config : {}
    if (
      node.type !== 'logic-wait' ||
      config.mode !== 'appointment' ||
      String(config.appointmentOffset || 'before') !== 'before'
    ) return []
    const action = String(config.appointmentPastDueAction || '')
    const targetNodeId = action === 'specific_node'
      ? String(config.appointmentPastDueTargetNodeId || '').trim()
      : action === 'next_wait' || action === 'auto'
        ? nextDownstreamWaitNode(nodes, edges, node.id)?.id || ''
        : ''
    if (!targetNodeId || !nodeIds.has(targetNodeId) || targetNodeId === node.id) return []
    return [{
      id: `virtual-appointment-past-due-${node.id}`,
      sourceNodeId: node.id,
      sourceHandle: 'appointment-past-due',
      targetNodeId
    }]
  })
  return [...edges, ...routingEdges]
}

export function validateAppointmentPastDueChoicesForSave(flow) {
  const nodes = asArray(flow?.nodes)
  const edges = asArray(flow?.edges)
  const errors = []

  nodes
    .filter((node) => node.type === 'logic-wait')
    .forEach((node) => {
      const config = isPlainObject(node.config) ? node.config : {}
      if (
        config.mode !== 'appointment' ||
        String(config.appointmentOffset || 'before') !== 'before'
      ) return

      const action = String(config.appointmentPastDueAction || '').trim()
      if (!APPOINTMENT_PAST_DUE_ACTIONS.has(action)) {
        errors.push('El paso Esperar necesita elegir qué debe pasar si ya pasó el tiempo de espera')
        return
      }
      if (action === 'auto') {
        if (!nextDownstreamWaitNode(nodes, edges, node.id)) {
          errors.push('El paso Esperar necesita elegir qué debe pasar porque no hay otra espera más adelante')
        }
        return
      }
      if (action === 'next_wait' && !nextDownstreamWaitNode(nodes, edges, node.id)) {
        errors.push('El paso Esperar ya no tiene un siguiente evento de espera inequívoco')
        return
      }
      if (action !== 'specific_node') return

      const targetNodeId = String(config.appointmentPastDueTargetNodeId || '').trim()
      const targetNode = nodes.find((candidate) => candidate.id === targetNodeId)
      if (!targetNodeId) {
        errors.push('El paso Esperar necesita elegir un evento para una cita cuyo tiempo ya pasó')
      } else if (!targetNode || targetNode.type === START_NODE_TYPE || targetNode.id === node.id) {
        errors.push('El evento elegido para una cita cuyo tiempo ya pasó no es válido')
      }
    })

  return errors
}

function commentTriggerPlatform(trigger) {
  if (trigger?.type === 'trigger-instagram-comment') return 'instagram'
  if (trigger?.type === 'trigger-facebook-comment') return 'facebook'
  return ''
}

function replyTypeFromCommentTarget(target, config = {}) {
  if (target) return target.delivery
  return String(config.replyType || '').toLowerCase() === 'private' ? 'private' : 'public'
}

function resolveCommentReplyTarget(config = {}, triggerPlatforms = []) {
  const explicitTarget = COMMENT_REPLY_TARGETS[String(config.commentReplyTarget || '')]
  if (explicitTarget) return explicitTarget
  if (triggerPlatforms.length !== 1) return null
  const replyType = String(config.replyType || '').toLowerCase() === 'private' ? 'private' : 'public'
  const platform = triggerPlatforms[0]
  if (platform === 'instagram') {
    return COMMENT_REPLY_TARGETS[replyType === 'private' ? 'instagram_private_message' : 'instagram_public_comment']
  }
  return COMMENT_REPLY_TARGETS[replyType === 'private' ? 'messenger_private_message' : 'facebook_public_comment']
}

function messageBlockHasContent(block) {
  if (!isPlainObject(block)) return false
  if (block.type === 'text') {
    return Boolean(String(block.compiledText || block.text || block.message || '').trim())
  }
  if (COMMENT_REPLY_MEDIA_BLOCKS.has(block.type)) {
    return Boolean(String(block.url || '').trim())
  }
  return false
}

function validateCommentReplyNode({ node, triggers, errors }) {
  const baseConfig = isPlainObject(node.config) ? node.config : {}
  const config = node.type === 'channel-comment-dm-reply' && !baseConfig.replyType
    ? { ...baseConfig, replyType: 'private' }
    : baseConfig
  const commentTriggers = triggers.filter((trigger) => COMMENT_TRIGGER_TYPES.has(String(trigger?.type || '')))
  const nonCommentTriggers = triggers.filter((trigger) => !COMMENT_TRIGGER_TYPES.has(String(trigger?.type || '')))
  const triggerPlatforms = [...new Set(commentTriggers.map(commentTriggerPlatform).filter(Boolean))]
  const target = resolveCommentReplyTarget(config, triggerPlatforms)

  if (commentTriggers.length === 0) {
    errors.push('La acción Responder comentario necesita un disparador de comentario de Facebook o Instagram')
    return
  }
  if (nonCommentTriggers.length > 0) {
    errors.push('La acción Responder comentario no puede compartir flujo con disparadores que no sean comentarios')
  }
  if (!target) {
    errors.push('Elige una acción específica para responder el comentario: Facebook, Instagram, Messenger o Instagram DM')
    return
  }
  if (triggerPlatforms.length !== 1) {
    errors.push('Separa Facebook e Instagram en automatizaciones distintas para responder comentarios sin ambigüedad')
    return
  }
  if (target.eventPlatform !== triggerPlatforms[0]) {
    errors.push(`La acción "${target.label}" no coincide con el disparador de comentario de ${triggerPlatforms[0] === 'instagram' ? 'Instagram' : 'Facebook'}`)
  }

  const blocks = asArray(config.messageBlocks)
  const contentBlocks = blocks.filter(messageBlockHasContent)
  if (contentBlocks.length === 0) {
    errors.push('Agrega contenido a la respuesta del comentario')
  }
  if (target.delivery === 'private' && contentBlocks.length > 1) {
    errors.push('Meta solo permite un mensaje privado inicial por comentario; deja un solo bloque con contenido')
  }
  blocks.forEach((block, index) => {
    if (!isPlainObject(block)) return
    const type = String(block.type || '')
    const buttons = [
      ...asArray(block.buttons),
      ...asArray(block.quickReplies)
    ]
    if (buttons.length > 0) {
      errors.push(`La respuesta a comentario no puede usar botones en el bloque ${index + 1}`)
    }
    if (!target.allowedBlockTypes.has(type)) {
      if (target.delivery === 'private' && COMMENT_REPLY_MEDIA_BLOCKS.has(type)) {
        errors.push('La respuesta privada inicial a un comentario solo admite texto; cuando la persona responda usa un paso normal de Messenger o Instagram para enviar multimedia')
      } else if (target.label.includes('Instagram') && COMMENT_REPLY_MEDIA_BLOCKS.has(type)) {
        errors.push('Instagram no permite adjuntos en respuestas públicas a comentarios; usa solo texto')
      } else if (target.label.includes('Facebook') && COMMENT_REPLY_MEDIA_BLOCKS.has(type)) {
        errors.push('Facebook solo permite imagen como adjunto en una respuesta pública a comentario')
      } else if (type === 'delay') {
        errors.push('Las respuestas a comentarios no usan retrasos internos; usa un paso Esperar antes de responder')
      } else {
        errors.push(`El bloque ${index + 1} no se puede enviar al ${target.label}`)
      }
    }
    if (COMMENT_REPLY_MEDIA_BLOCKS.has(type) && !String(block.url || '').trim()) {
      errors.push(`El adjunto del bloque ${index + 1} necesita una URL`)
    }
  })
}

function isSentMessageSourceNode(node) {
  const type = String(node?.type || '')
  if (SENT_MESSAGE_NODE_TYPES.has(type)) return true
  if (type === 'channel-comment-dm-reply') return true
  if (type === 'channel-comment-public-reply') {
    const target = resolveCommentReplyTarget(isPlainObject(node?.config) ? node.config : {})
    return replyTypeFromCommentTarget(target, node?.config) === 'private'
  }
  return false
}

function validateReplyMessageWaitSource({ node, nodes, edges, errors }) {
  const config = isPlainObject(node.config) ? node.config : {}
  const expectedAction = String(config.expectedAction || '')
  const sourceId = config.mode === 'reply'
    ? String(config.replySourceNodeId || '').trim()
    : config.mode === 'action' && REPLY_MESSAGE_WAIT_ACTIONS.has(expectedAction)
      ? String(config.actionResource || config.messageSourceNodeId || config.replySourceNodeId || '').trim()
      : ''
  if (!sourceId && config.mode !== 'action') return
  if (config.mode === 'action' && !REPLY_MESSAGE_WAIT_ACTIONS.has(expectedAction)) return
  if (!sourceId) {
    errors.push('El paso Esperar necesita un mensaje enviado anterior seleccionado')
    return
  }
  const sourceNode = nodes.find((candidate) => candidate.id === sourceId)
  if (!sourceNode || !isSentMessageSourceNode(sourceNode) || !hasPath(edges, sourceId, node.id)) {
    errors.push('El mensaje enviado seleccionado en Esperar ya no está antes de esa espera')
  }
}

function validateGoalFilters(config, errors) {
  asArray(config.filters).forEach((filter, index) => {
    const position = `Filtro ${index + 1} del objetivo`
    if (!isPlainObject(filter) || !String(filter.field || '').trim()) {
      errors.push(`${position}: elige el dato que debe revisar`)
      return
    }
    const field = String(filter.field || '').trim()
    if (FILTER_FIELDS_REQUIRING_KEY.has(field) && !String(filter.customKey || filter.custom_key || '').trim()) {
      errors.push(`${position}: elige el campo o la pregunta`)
    }
    const operator = String(filter.match || '').trim()
    if (!operator) {
      errors.push(`${position}: elige qué debe pasar`)
      return
    }
    if (!SUPPORTED_FILTER_OPERATORS.has(operator)) {
      errors.push(`${position}: la comparación seleccionada no es válida`)
      return
    }
    if (!FILTER_OPERATORS_WITHOUT_VALUE.has(operator) && !String(filter.value ?? '').trim()) {
      errors.push(`${position}: captura el valor a comparar`)
    }
    if (filter.connector && !['and', 'or'].includes(String(filter.connector))) {
      errors.push(`${position}: la combinación Y/O no es válida`)
    }
  })
}

function validateGoalNode(node, errors) {
  const config = isPlainObject(node.config) ? node.config : {}
  const goalType = String(config.goalType || '').trim()
  if (!goalType) {
    errors.push('El Evento objetivo necesita un tipo de objetivo')
    return
  }
  if (!SUPPORTED_GOAL_TYPES.has(goalType)) {
    errors.push(`El Evento objetivo usa un tipo no soportado (${goalType})`)
    return
  }

  if (goalType === 'tag' && !String(config.tag || '').trim()) {
    errors.push('El objetivo de etiqueta necesita una etiqueta seleccionada')
  }
  if (goalType === 'tag' && !GOAL_TAG_OPERATORS.has(String(config.tagOperator || 'has'))) {
    errors.push('El objetivo de etiqueta necesita una condición válida')
  }
  if (goalType === 'payment' && !GOAL_PAYMENT_EVENTS.has(String(config.paymentEvent || 'received'))) {
    errors.push('El objetivo de pago necesita un evento válido')
  }
  if (goalType === 'payment' && !GOAL_PAYMENT_AMOUNT_OPERATORS.has(String(config.amountOperator || 'any'))) {
    errors.push('El objetivo de pago necesita una comparación de monto válida')
  }
  if (
    goalType === 'payment' &&
    String(config.amountOperator || 'any') !== 'any' &&
    (!String(config.amount ?? '').trim() || !Number.isFinite(Number(config.amount)))
  ) {
    errors.push('El objetivo de pago necesita un monto válido')
  }
  if (goalType === 'form' && !String(config.form || config.formName || '').trim()) {
    errors.push('El objetivo de formulario necesita un formulario seleccionado')
  }
  if (goalType === 'link' && !GOAL_LINK_EVENTS.has(String(config.linkEvent || 'clicked'))) {
    errors.push('El objetivo de clic de disparo necesita un evento válido')
  }
  if (goalType === 'appointment' && !GOAL_APPOINTMENT_STATUSES.has(String(config.appointmentStatus || 'booked'))) {
    errors.push('El objetivo de cita necesita un estado válido')
  }
  if (goalType === 'conversation' && !GOAL_CONVERSATION_EVENTS.has(String(config.conversationEvent || 'replied'))) {
    errors.push('El objetivo de conversación necesita un evento válido')
  }
  if (
    goalType === 'conversation' &&
    String(config.conversationEvent || 'replied') === 'keyword' &&
    !String(config.keyword || '').trim()
  ) {
    errors.push('El objetivo de conversación necesita una palabra clave')
  }
  if (goalType === 'custom' && !String(config.customEventName || '').trim()) {
    errors.push('El objetivo personalizado necesita el nombre del evento')
  }
  if (goalType === 'contact' && !GOAL_CONTACT_EVENTS.has(String(config.contactEvent || 'created'))) {
    errors.push('El objetivo de contacto necesita un evento válido')
  }
  if (
    goalType === 'contact' &&
    String(config.contactEvent || 'created') === 'field_contains' &&
    (!String(config.contactField || '').trim() || !String(config.contactFieldValue || '').trim())
  ) {
    errors.push('El objetivo de contacto necesita el campo y el valor que debe contener')
  }
  if (goalType === 'ads' && !GOAL_ADS_EVENTS.has(String(config.adsEvent || 'fb_click'))) {
    errors.push('El objetivo de Ads necesita un evento válido')
  }

  const evaluation = String(config.evaluate || 'during-automation')
  const onMet = String(config.onMet || 'end-automation')
  const onNotMet = String(config.onNotMet || 'continue')
  const windowMode = String(config.windowMode || 'none')
  if (!GOAL_EVALUATION_MODES.has(evaluation)) {
    errors.push('El Evento objetivo necesita un modo de evaluación válido')
  }
  if (!GOAL_ON_MET_ACTIONS.has(onMet)) {
    errors.push('El Evento objetivo necesita una acción válida al cumplirse')
  }
  if (!GOAL_ON_NOT_MET_ACTIONS.has(onNotMet)) {
    errors.push('El Evento objetivo necesita una acción válida si no se cumple')
  }
  if (!GOAL_WINDOW_MODES.has(windowMode)) {
    errors.push('El Evento objetivo necesita una ventana de tiempo válida')
  }
  if (windowMode === 'duration' && !(Number(config.windowAmount) > 0)) {
    errors.push('La ventana del Evento objetivo debe ser mayor a cero')
  }
  if (windowMode === 'until' && !String(config.windowUntil || '').trim()) {
    errors.push('El Evento objetivo necesita una fecha límite')
  }
  if (
    goalType === 'conversation' &&
    String(config.conversationEvent || 'replied') === 'no_reply' &&
    !['duration', 'until'].includes(windowMode)
  ) {
    errors.push('El objetivo "No ha respondido" necesita una ventana de tiempo')
  }

  validateGoalFilters(config, errors)
}

function validateAppointmentConfirmationNode(node, errors) {
  const config = isPlainObject(node.config) ? node.config : {}
  if (!String(config.template || config.templateId || '').trim()) {
    errors.push('La acción Confirmar cita necesita una plantilla de WhatsApp')
  }
  if (
    String(config.senderMode || config.sender || '') === 'specific' &&
    !String(config.senderPhoneNumberId || config.senderNumberId || '').trim()
  ) {
    errors.push('La acción Confirmar cita necesita el número de WhatsApp remitente')
  }

  const timingAnchor = String(config.timingAnchor || 'before_appointment')
  const offsetUnit = String(config.offsetUnit || (timingAnchor === 'after_booking' ? 'minutes' : 'days'))
  const offsetValue = Number(config.offsetValue)
  const validInteger = Number.isInteger(offsetValue)
  if (timingAnchor === 'after_booking') {
    const unitMs = { seconds: 1000, minutes: 60_000, hours: 3_600_000 }[offsetUnit]
    if (!validInteger || offsetValue < 0 || !unitMs || offsetValue * unitMs > 86_400_000) {
      errors.push('Después de agendar, la confirmación debe programarse entre 0 y 24 horas')
    }
  } else if (
    timingAnchor !== 'before_appointment' ||
    !validInteger ||
    offsetValue < 1 ||
    offsetValue > 60 ||
    !['minutes', 'hours', 'days'].includes(offsetUnit)
  ) {
    errors.push('Antes de la cita, define un tiempo válido entre 1 y 60 minutos, horas o días')
  }

  const timeoutValue = Number(config.confirmationTimeoutValue)
  const timeoutUnit = String(config.confirmationTimeoutUnit || '')
  const timeoutMode = String(config.confirmationTimeoutMode || 'response_window')
  const timeoutUnitMs = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[timeoutUnit]
  if (
    !Number.isInteger(timeoutValue) ||
    timeoutValue < 1 ||
    !timeoutUnitMs ||
    timeoutValue * timeoutUnitMs > 30 * 86_400_000 ||
    (timeoutMode === 'response_window' && timeoutUnit === 'days')
  ) {
    errors.push('La acción Confirmar cita necesita un plazo de respuesta válido')
  }
  const responseStart = String(config.confirmationResponseStart || '')
  const responseEnd = String(config.confirmationResponseEnd || '')
  if (
    timeoutMode === 'response_window' &&
    (!/^\d{2}:\d{2}$/.test(responseStart) || !/^\d{2}:\d{2}$/.test(responseEnd) || responseStart === responseEnd)
  ) {
    errors.push('La acción Confirmar cita necesita un horario de respuesta válido')
  }
  if (timeoutMode === 'elapsed' && timingAnchor === 'before_appointment') {
    const offsetUnitMs = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[offsetUnit]
    if (timeoutUnitMs && offsetUnitMs && timeoutValue * timeoutUnitMs >= offsetValue * offsetUnitMs) {
      errors.push('El plazo para confirmar debe terminar antes de que comience la cita')
    }
  }
}

/**
 * Validación estructural mínima antes de publicar una automatización.
 * La validación detallada por tipo de paso vive en el editor (frontend);
 * aquí solo se garantiza que el flujo publicado sea coherente.
 *
 * Devuelve una lista de mensajes de error en español (vacía si es válido).
 */
export function validateFlowForPublish(flow) {
  const errors = []
  const nodes = asArray(flow?.nodes)
  const edges = asArray(flow?.edges)

  const startNode = nodes.find((node) => node.type === START_NODE_TYPE)
  const triggers = asArray(startNode?.config?.triggers)

  if (!startNode) {
    errors.push('El flujo no tiene tarjeta inicial "Cuando..."')
  } else if (!edges.some((edge) => edge.sourceNodeId === startNode.id)) {
    errors.push('Agrega al menos un paso conectado al inicio antes de publicar')
  }

  triggers
    .filter((trigger) => trigger?.type === 'trigger-incoming-webhook')
    .forEach((trigger) => {
      if (!hasSampleResponse(trigger?.config?.sampleResponse)) {
        errors.push('Prueba el webhook y recibe datos reales antes de publicar')
      }
    })

  const nodeIds = new Set(nodes.map((node) => node.id))
  const brokenEdge = edges.find(
    (edge) => !nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)
  )
  if (brokenEdge) {
    errors.push('Hay conexiones que apuntan a pasos que ya no existen')
  }

  // (AUTO-001) Rechazar pasos que el motor no sabe ejecutar (caerían en `default` y
  // cortarían el flujo en silencio). Se excluye el nodo `start` (estructural) que ya
  // está en la allowlist.
  const unsupportedNodeTypes = new Set()
  nodes.forEach((node) => {
    const type = String(node.type || '')
    if (type && !EXECUTABLE_NODE_TYPES.has(type)) unsupportedNodeTypes.add(type)
  })
  if (unsupportedNodeTypes.size > 0) {
    errors.push(
      `Hay pasos que aún no se pueden ejecutar y cortarían el flujo (${[...unsupportedNodeTypes].join(', ')}): quítalos antes de publicar`
    )
  }

  // (AUTO-002) Rechazar disparadores sin evento real: la automatización nunca
  // correría. Los comentarios FB/IG y Click-to-WhatsApp ya tienen emisor real.
  const unsupportedTriggerTypes = new Set()
  triggers.forEach((trigger) => {
    const type = String(trigger?.type || '')
    if (type && !SUPPORTED_TRIGGER_TYPES.has(type)) unsupportedTriggerTypes.add(type)
  })
  if (unsupportedTriggerTypes.size > 0) {
    errors.push(
      `Hay disparadores que todavía no están disponibles y nunca activarían la automatización (${[...unsupportedTriggerTypes].join(', ')}): elige otro disparador`
    )
  }

  nodes
    .filter((node) => node.type === 'randomizer')
    .forEach((node) => {
      const branches = asArray(node.config?.branches)
      const total = branches.reduce((sum, branch) => sum + (Number(branch?.percent) || 0), 0)
      if (branches.length < 2 || total !== 100) {
        errors.push('Las ramas del aleatorizador deben sumar 100%')
      }
    })

  nodes
    .filter((node) => node.type === 'action-set-default-reply-channel')
    .forEach((node) => {
      const channel = String(node.config?.channel || '').trim().toLowerCase()
      if (!DEFAULT_REPLY_ACTION_CHANNELS.has(channel)) {
        errors.push('La acción Cambiar canal de respuesta necesita un canal válido')
      } else if (channel === 'whatsapp' && !String(node.config?.whatsappPhoneNumberId || '').trim()) {
        errors.push('La acción Cambiar canal de respuesta necesita un número de WhatsApp conectado')
      }
    })

  nodes
    .filter((node) => node.type === 'action-appointment-confirmation')
    .forEach((node) => validateAppointmentConfirmationNode(node, errors))

  nodes
    .filter((node) => node.type === 'logic-wait')
    .forEach((node) => {
      const config = isPlainObject(node.config) ? node.config : {}
      if (config.mode !== 'action') return
      const expectedAction = String(config.expectedAction || 'click_link')
      if (!TRIGGER_LINK_WAIT_ACTIONS.has(expectedAction)) return
      if (!String(config.actionResource || config.link || config.triggerLinkId || '').trim()) {
        errors.push('El paso Esperar necesita un clic de disparo seleccionado')
      }
    })

  errors.push(...validateAppointmentPastDueChoicesForSave(flow))

  nodes
    .filter((node) => node.type === 'logic-wait')
    .forEach((node) => validateReplyMessageWaitSource({ node, nodes, edges, errors }))

  nodes
    .filter((node) => node.type === 'logic-drip')
    .forEach((node) => {
      const config = isPlainObject(node.config) ? node.config : {}
      const batchSize = Math.floor(Number(config.batchSize) || 0)
      const intervalAmount = Number(config.intervalAmount) || 0
      const intervalUnit = String(config.intervalUnit || 'minutes')
      if (batchSize <= 0) errors.push('El paso Goteo necesita un tamaño de lote mayor a cero')
      if (intervalAmount <= 0) errors.push('El paso Goteo necesita un intervalo mayor a cero')
      if (!DRIP_INTERVAL_UNITS.has(intervalUnit)) errors.push('El paso Goteo debe usar minutos, horas o días')
    })

  nodes
    .filter((node) => node.type === 'logic-goal')
    .forEach((node) => validateGoalNode(node, errors))

  nodes
    .filter((node) => node.type === 'channel-comment-public-reply' || node.type === 'channel-comment-dm-reply')
    .forEach((node) => validateCommentReplyNode({ node, triggers, errors }))

  nodes
    .filter((node) => node.type === 'channel-instagram')
    .forEach((node) => {
      const blocks = asArray(node.config?.messageBlocks)
      if (blocks.some((block) => String(block?.type || '') === 'file' && String(block?.url || '').trim())) {
        errors.push('Instagram no permite documentos por DM desde la API; usa imagen, audio o video')
      }
    })

  // Canales no soportados (SMS, Email…) en cualquier configuración
  const invalidChannels = new Set()
  const collectChannels = (config) => {
    if (!isPlainObject(config)) return
    CHANNEL_CONFIG_KEYS.forEach((key) => {
      const value = config[key]
      if (typeof value === 'string' && value && value !== 'any' && !ALLOWED_CHANNELS.includes(value)) {
        invalidChannels.add(value)
      }
    })
  }
  nodes.forEach((node) => {
    collectChannels(node.config)
    asArray(node.config?.triggers).forEach((trigger) => collectChannels(trigger?.config))
  })
  if (invalidChannels.size > 0) {
    errors.push(
      `Canales no soportados en el flujo (${[...invalidChannels].join(', ')}): usa WhatsApp, Messenger o Instagram Direct`
    )
  }

  // Máximo 10 ramas (salidas distintas conectadas) por nodo
  const handlesBySource = new Map()
  edges.forEach((edge) => {
    const set = handlesBySource.get(edge.sourceNodeId) || new Set()
    set.add(edge.sourceHandle || 'out')
    handlesBySource.set(edge.sourceNodeId, set)
  })
  for (const [, handles] of handlesBySource) {
    if (handles.size > 10) {
      errors.push('Máximo 10 ramas por paso')
      break
    }
  }

  // Horario global del flujo: si está activo necesita días y horas válidas
  const schedule = flow?.settings?.allowedSchedule
  if (isPlainObject(schedule) && schedule.enabled) {
    if (!Array.isArray(schedule.daysOfWeek) || schedule.daysOfWeek.length === 0) {
      errors.push('El horario del flujo necesita al menos un día permitido')
    }
    if (!schedule.startTime || !schedule.endTime) {
      errors.push('El horario del flujo necesita hora de inicio y fin')
    }
  }

  if (detectCycle(nodes, appointmentPastDueRoutingEdges(nodes, edges))) {
    errors.push('El flujo tiene un ciclo: una rama regresa a un paso anterior')
  }

  return errors
}
