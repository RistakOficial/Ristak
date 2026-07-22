import * as contactsController from '../controllers/contactsController.js'
import * as contactAssignmentController from '../controllers/contactAssignmentController.js'
import * as whatsappController from '../controllers/whatsappApiController.js'
import * as emailController from '../controllers/emailController.js'
import * as highLevelController from '../controllers/highlevelController.js'
import * as agentController from '../controllers/conversationalAgentController.js'
import * as calendarsController from '../controllers/calendarsController.js'
import * as transactionsController from '../controllers/transactionsController.js'
import * as paymentPlansController from '../controllers/paymentPlansController.js'
import * as automationsController from '../controllers/automationsController.js'

const ID = { type: 'string', minLength: 1, maxLength: 180 }
const TEXT = { type: 'string', maxLength: 50000 }
const SHORT_TEXT = { type: 'string', maxLength: 500 }
const IDEMPOTENCY_KEY = {
  type: 'string',
  minLength: 8,
  maxLength: 180,
  pattern: '^[A-Za-z0-9._:-]+$'
}
const CONFIRM = {
  type: 'boolean',
  description: 'Debe ser true después de confirmar la acción con la persona usuaria.'
}

function schema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function controls({ confirm = false, idempotency = false } = {}) {
  return {
    ...(confirm ? { confirm: CONFIRM } : {}),
    ...(idempotency ? { idempotencyKey: IDEMPOTENCY_KEY } : {})
  }
}

function requiredWith(required = [], { confirm = false, idempotency = false } = {}) {
  return [...required, ...(confirm ? ['confirm'] : []), ...(idempotency ? ['idempotencyKey'] : [])]
}

function cleanRequestObject(source = {}) {
  const result = { ...source }
  delete result.confirm
  delete result.idempotencyKey
  return result
}

function spec(definition) {
  return Object.freeze({
    featureKeys: [],
    adminOnly: false,
    confirmRequired: false,
    idempotencyRequired: false,
    ...definition
  })
}

function controllerSpec({
  handler,
  method = 'GET',
  params = () => ({}),
  query = () => ({}),
  body = () => ({}),
  ...definition
}) {
  if (typeof handler !== 'function') {
    throw new Error(`Controller MCP inválido para ${definition.name || 'una herramienta sin nombre'}`)
  }

  return spec({
    ...definition,
    async execute(context, args) {
      return context.invoke(handler, {
        method,
        params: params(args),
        query: query(args),
        body: body(args),
        headers: definition.idempotencyRequired
          ? { 'idempotency-key': args.idempotencyKey }
          : undefined
      })
    }
  })
}

const contactFields = {
  name: SHORT_TEXT,
  full_name: SHORT_TEXT,
  first_name: SHORT_TEXT,
  last_name: SHORT_TEXT,
  email: { type: 'string', maxLength: 320 },
  phone: { type: 'string', maxLength: 80 },
  source: { type: 'string', maxLength: 120 }
}

const paymentEditableFields = {
  amount: { type: 'number', exclusiveMinimum: 0 },
  method: SHORT_TEXT,
  paymentMethod: SHORT_TEXT,
  reference: SHORT_TEXT,
  title: SHORT_TEXT,
  description: TEXT,
  date: { type: 'string', maxLength: 80 },
  dueDate: { type: 'string', maxLength: 80 },
  contactId: ID
}

const paymentEditableChanges = {
  type: 'object',
  properties: paymentEditableFields,
  additionalProperties: false,
  maxProperties: Object.keys(paymentEditableFields).length,
  anyOf: Object.keys(paymentEditableFields).map((key) => ({ required: [key] }))
}

const contactTools = [
  controllerSpec({
    name: 'contacts_list',
    description: 'Lista contactos del CRM con filtros y paginación. No consulta proveedores externos.',
    module: 'contacts', access: 'read', scope: 'ristak.read', risk: 'low',
    handler: contactsController.getContacts,
    inputSchema: schema({
      page: { type: 'integer', minimum: 1, maximum: 100000 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      search: { type: 'string', maxLength: 200 },
      filter: { type: 'string', maxLength: 80 },
      source: { type: 'string', maxLength: 120 },
      tag: { type: 'string', maxLength: 180 },
      cursor: { type: 'string', maxLength: 1200 }
    }),
    query: cleanRequestObject
  }),
  controllerSpec({
    name: 'contacts_search',
    description: 'Busca contactos por nombre, correo, teléfono o identificador en el directorio local.',
    module: 'contacts', access: 'read', scope: 'ristak.read', risk: 'low',
    handler: contactsController.searchContacts,
    inputSchema: schema({ query: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['query']),
    query: (args) => ({ q: args.query, limit: args.limit, picker: 'true' })
  }),
  controllerSpec({
    name: 'contacts_get',
    description: 'Obtiene el perfil completo de un contacto.',
    module: 'contacts', access: 'read', scope: 'ristak.read', risk: 'low',
    handler: contactsController.getContactById,
    inputSchema: schema({ contactId: ID }, ['contactId']),
    params: (args) => ({ id: args.contactId })
  }),
  controllerSpec({
    name: 'contacts_get_payments',
    description: 'Lista los pagos asociados a un contacto.',
    module: 'contacts', additionalModules: ['payments'], access: 'read', scope: 'ristak.read', risk: 'low',
    handler: contactsController.getContactPayments,
    inputSchema: schema({ contactId: ID }, ['contactId']),
    params: (args) => ({ id: args.contactId })
  }),
  controllerSpec({
    name: 'contacts_get_appointments',
    description: 'Lista las citas asociadas a un contacto.',
    module: 'contacts', additionalModules: ['appointments'], access: 'read', scope: 'ristak.read', risk: 'low',
    handler: contactsController.getContactAppointments,
    inputSchema: schema({ contactId: ID }, ['contactId']),
    params: (args) => ({ id: args.contactId })
  }),
  controllerSpec({
    name: 'contacts_create',
    description: 'Crea un contacto usando las mismas validaciones, normalización y eventos del CRM.',
    module: 'contacts', access: 'write', scope: 'ristak.write', risk: 'medium',
    handler: contactsController.createContact, method: 'POST',
    idempotencyRequired: true,
    inputSchema: schema({ ...contactFields, ...controls({ idempotency: true }) }, requiredWith([], { idempotency: true })),
    body: cleanRequestObject
  }),
  controllerSpec({
    name: 'contacts_update',
    description: 'Actualiza identidad, etiquetas y campos personalizados de un contacto. No fusiona duplicados sin confirmMerge.',
    module: 'contacts', access: 'write', scope: 'ristak.write', risk: 'medium',
    handler: contactsController.updateContact, method: 'PUT',
    idempotencyRequired: true,
    inputSchema: schema({
      contactId: ID,
      full_name: SHORT_TEXT,
      email: { type: ['string', 'null'], maxLength: 320 },
      phone: { type: ['string', 'null'], maxLength: 80 },
      source: { type: 'string', maxLength: 120 },
      tags: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 180 } },
      customFields: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: true } },
      dnd: { type: 'boolean' },
      dndSettings: { type: 'object', additionalProperties: true },
      confirmMerge: { type: 'boolean' },
      ...controls({ idempotency: true })
    }, requiredWith(['contactId'], { idempotency: true })),
    params: (args) => ({ id: args.contactId }),
    body: (args) => {
      const bodyValue = cleanRequestObject(args)
      delete bodyValue.contactId
      return bodyValue
    }
  }),
  controllerSpec({
    name: 'contacts_archive',
    description: 'Mueve un contacto a la papelera conservando pagos e historial.',
    module: 'contacts', access: 'write', scope: 'ristak.destructive', risk: 'high',
    handler: contactsController.deleteContact, method: 'DELETE',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ contactId: ID, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['contactId'], { confirm: true, idempotency: true })),
    params: (args) => ({ id: args.contactId })
  }),
  controllerSpec({
    name: 'contacts_trash_list',
    description: 'Lista contactos archivados que todavía pueden restaurarse.',
    module: 'contacts', access: 'read', scope: 'ristak.read', risk: 'low',
    handler: contactsController.getTrashedContacts,
    inputSchema: schema({ limit: { type: 'integer', minimum: 1, maximum: 500 } }),
    query: cleanRequestObject
  }),
  controllerSpec({
    name: 'contacts_restore',
    description: 'Restaura un contacto desde la papelera.',
    module: 'contacts', access: 'write', scope: 'ristak.write', risk: 'medium',
    handler: contactsController.restoreContact, method: 'POST',
    idempotencyRequired: true,
    inputSchema: schema({ contactId: ID, ...controls({ idempotency: true }) }, requiredWith(['contactId'], { idempotency: true })),
    params: (args) => ({ id: args.contactId })
  }),
  controllerSpec({
    name: 'contacts_delete_permanently',
    description: 'Borra permanentemente un contacto ya archivado. Los pagos se conservan desacoplados.',
    module: 'contacts', access: 'write', scope: 'ristak.destructive', risk: 'critical', adminOnly: true,
    handler: contactsController.permanentDeleteContact, method: 'DELETE',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ contactId: ID, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['contactId'], { confirm: true, idempotency: true })),
    params: (args) => ({ id: args.contactId })
  }),
  controllerSpec({
    name: 'contacts_assignable_users',
    description: 'Lista usuarios activos que pueden ser responsables de contactos. No revela credenciales ni permisos internos.',
    module: 'contacts', access: 'read', scope: 'ristak.read', risk: 'low',
    handler: contactAssignmentController.getAssignableUsers,
    inputSchema: schema()
  }),
  controllerSpec({
    name: 'contacts_set_assignment',
    description: 'Asigna o desasigna el responsable de un contacto.',
    module: 'contacts', access: 'write', scope: 'ristak.write', risk: 'medium',
    handler: contactAssignmentController.setContactAssignment, method: 'PUT',
    idempotencyRequired: true,
    inputSchema: schema({ contactId: ID, userId: { type: ['string', 'null'], maxLength: 180 }, ...controls({ idempotency: true }) }, requiredWith(['contactId'], { idempotency: true })),
    params: (args) => ({ id: args.contactId }), body: (args) => ({ userId: args.userId })
  }),
  controllerSpec({
    name: 'contacts_update_tags',
    description: 'Agrega o quita etiquetas en hasta 1000 contactos y dispara los eventos de automatización correspondientes.',
    module: 'contacts', access: 'write', scope: 'ristak.write', risk: 'medium',
    handler: contactsController.bulkUpdateContactTags, method: 'POST', idempotencyRequired: true,
    inputSchema: schema({
      contactIds: { type: 'array', minItems: 1, maxItems: 1000, items: ID },
      addTagIds: { type: 'array', maxItems: 200, items: ID },
      removeTagIds: { type: 'array', maxItems: 200, items: ID },
      ...controls({ idempotency: true })
    }, requiredWith(['contactIds'], { idempotency: true })),
    body: cleanRequestObject
  })
]

const chatTools = [
  controllerSpec({
    name: 'chat_list_inbox',
    description: 'Lista conversaciones del inbox, incluidos no leídos y último mensaje. Sirve para consultar mensajes recibidos.',
    module: 'chat', access: 'read', scope: 'ristak.read', risk: 'low',
    handler: contactsController.getChatContacts,
    inputSchema: schema({
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 1200 },
      search: { type: 'string', maxLength: 200 }, unreadOnly: { type: 'boolean' }, channel: { type: 'string', maxLength: 40 }
    }),
    query: cleanRequestObject
  }),
  controllerSpec({
    name: 'chat_get_conversation',
    description: 'Lee mensajes de una conversación unificada por contacto con paginación hacia atrás.',
    module: 'chat', additionalModules: ['contacts'], access: 'read', scope: 'ristak.read', risk: 'low',
    handler: contactsController.getContactConversation,
    inputSchema: schema({
      contactId: ID, limit: { type: 'integer', minimum: 1, maximum: 200 },
      beforeMessageDate: { type: 'string', maxLength: 80 }, beforeMessageCursor: { type: 'string', maxLength: 1200 }
    }, ['contactId']),
    params: (args) => ({ id: args.contactId }),
    query: (args) => ({ messageLimit: args.limit, beforeMessageDate: args.beforeMessageDate, beforeMessageCursor: args.beforeMessageCursor })
  }),
  controllerSpec({
    name: 'chat_mark_read',
    description: 'Marca la conversación de un contacto como leída.',
    module: 'chat', access: 'write', scope: 'ristak.write', risk: 'medium',
    handler: contactsController.markChatContactRead, method: 'POST', idempotencyRequired: true,
    inputSchema: schema({ contactId: ID, ...controls({ idempotency: true }) }, requiredWith(['contactId'], { idempotency: true })),
    params: (args) => ({ id: args.contactId })
  }),
  controllerSpec({
    name: 'chat_send_whatsapp',
    description: 'Envía un mensaje de WhatsApp usando el proveedor configurado y registra la toma humana de la conversación.',
    module: 'chat', access: 'write', scope: 'ristak.execute', risk: 'high',
    featureKeys: ['whatsapp'],
    handler: whatsappController.sendWhatsAppApiTextMessageView, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({
      contactId: ID, to: { type: 'string', maxLength: 80 }, from: { type: 'string', maxLength: 80 },
      text: TEXT, transport: { type: 'string', enum: ['api', 'qr'] }, phoneNumberId: ID,
      replyToMessageId: ID, replyToProviderMessageId: ID,
      ...controls({ confirm: true, idempotency: true })
    }, requiredWith(['text'], { confirm: true, idempotency: true })),
    body: (args) => ({ ...cleanRequestObject(args), externalId: args.idempotencyKey, messageOrigin: 'manual_chat' })
  }),
  controllerSpec({
    name: 'chat_send_meta',
    description: 'Responde por Messenger o Instagram en una conversación enlazada.',
    module: 'chat', access: 'write', scope: 'ristak.execute', risk: 'high',
    featureKeys: ['meta_ads'],
    handler: whatsappController.sendMetaSocialTextMessageView, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({
      contactId: ID, platform: { type: 'string', enum: ['messenger', 'instagram'] }, message: TEXT,
      replyToMessageId: ID, replyToProviderMessageId: ID,
      ...controls({ confirm: true, idempotency: true })
    }, requiredWith(['contactId', 'platform', 'message'], { confirm: true, idempotency: true })),
    body: (args) => ({ ...cleanRequestObject(args), externalId: args.idempotencyKey })
  }),
  controllerSpec({
    name: 'chat_send_email',
    description: 'Envía un correo al contacto con la cuenta de email conectada en Ristak.',
    module: 'chat', access: 'write', scope: 'ristak.execute', risk: 'high',
    featureKeys: ['email'],
    handler: emailController.sendEmailView, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({
      contactId: ID, to: { type: 'string', maxLength: 320 }, subject: { type: 'string', minLength: 1, maxLength: 998 },
      text: TEXT, html: { type: 'string', maxLength: 200000 }, replyTo: { type: 'string', maxLength: 320 }, includeSignature: { type: 'boolean' },
      ...controls({ confirm: true, idempotency: true })
    }, requiredWith(['subject'], { confirm: true, idempotency: true })),
    body: (args) => ({ ...cleanRequestObject(args), externalId: args.idempotencyKey })
  }),
  controllerSpec({
    name: 'chat_send_highlevel',
    description: 'Envía un mensaje por un canal de conversación administrado por HighLevel.',
    module: 'chat', access: 'write', scope: 'ristak.execute', risk: 'high',
    featureKeys: ['highlevel_integration'],
    handler: highLevelController.sendConversationMessage, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({
      contactId: ID, channel: { type: 'string', enum: ['SMS', 'WhatsApp', 'Email', 'IG', 'FB'] },
      message: TEXT, subject: SHORT_TEXT, html: { type: 'string', maxLength: 200000 },
      ...controls({ confirm: true, idempotency: true })
    }, requiredWith(['contactId', 'channel'], { confirm: true, idempotency: true })),
    body: (args) => ({ ...cleanRequestObject(args), externalId: args.idempotencyKey })
  }),
  controllerSpec({
    name: 'chat_list_scheduled',
    description: 'Lista mensajes programados de un contacto.',
    module: 'chat', access: 'read', scope: 'ristak.read', risk: 'low',
    handler: whatsappController.listScheduledChatMessagesView,
    inputSchema: schema({ contactId: ID }), query: cleanRequestObject
  }),
  controllerSpec({
    name: 'chat_schedule_message',
    description: 'Programa un mensaje para una fecha/hora ISO. La zona horaria se resuelve por las reglas de la cuenta.',
    module: 'chat', access: 'write', scope: 'ristak.execute', risk: 'high',
    handler: whatsappController.scheduleChatMessageView, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({
      contactId: ID, provider: SHORT_TEXT, channel: SHORT_TEXT, transport: SHORT_TEXT,
      messageType: { type: 'string', enum: ['text', 'template'] }, text: TEXT,
      templateId: ID, templateName: SHORT_TEXT, templateLanguage: SHORT_TEXT,
      templateComponents: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: true } },
      templateVariables: { type: 'object', additionalProperties: true }, toPhone: SHORT_TEXT, fromPhone: SHORT_TEXT,
      businessPhoneNumberId: ID, scheduledAt: { type: 'string', minLength: 10, maxLength: 80 },
      ...controls({ confirm: true, idempotency: true })
    }, requiredWith(['contactId', 'scheduledAt'], { confirm: true, idempotency: true })),
    body: (args) => ({ ...cleanRequestObject(args), id: `mcp_${args.idempotencyKey}`, externalId: args.idempotencyKey })
  }),
  controllerSpec({
    name: 'chat_cancel_scheduled',
    description: 'Cancela un mensaje programado antes de su envío.',
    module: 'chat', access: 'write', scope: 'ristak.destructive', risk: 'high',
    handler: whatsappController.cancelScheduledChatMessageView, method: 'DELETE',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ messageId: ID, contactId: ID, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['messageId'], { confirm: true, idempotency: true })),
    params: (args) => ({ id: args.messageId }), body: (args) => ({ contactId: args.contactId })
  })
]

const agentTools = [
  controllerSpec({
    name: 'chatbot_get_config', description: 'Lee la configuración general no secreta del agente conversacional.',
    module: 'ai_agent', access: 'read', scope: 'ristak.read', risk: 'low', handler: agentController.getConfig, inputSchema: schema()
  }),
  controllerSpec({
    name: 'chatbot_list_agents', description: 'Lista chatbots/agentes conversacionales con su estado y configuración funcional.',
    module: 'ai_agent', access: 'read', scope: 'ristak.read', risk: 'low', handler: agentController.listAgents,
    inputSchema: schema({ status: SHORT_TEXT, channel: SHORT_TEXT, search: { type: 'string', maxLength: 200 } }), query: cleanRequestObject
  }),
  controllerSpec({
    name: 'chatbot_metrics', description: 'Consulta métricas del agente conversacional.',
    module: 'ai_agent', access: 'read', scope: 'ristak.read', risk: 'low', handler: agentController.getMetrics,
    inputSchema: schema({ agentId: ID, from: { type: 'string', maxLength: 40 }, to: { type: 'string', maxLength: 40 } }), query: cleanRequestObject
  }),
  controllerSpec({
    name: 'chatbot_create', description: 'Crea un chatbot con reglas, objetivo, canales y comportamiento validados por Ristak.',
    module: 'ai_agent', access: 'write', scope: 'ristak.write', risk: 'medium', handler: agentController.createAgent, method: 'POST',
    idempotencyRequired: true,
    inputSchema: schema({ config: { type: 'object', additionalProperties: true }, ...controls({ idempotency: true }) }, requiredWith(['config'], { idempotency: true })),
    body: (args) => args.config
  }),
  controllerSpec({
    name: 'chatbot_update', description: 'Actualiza reglas, prompts, canales, estado y configuración de un chatbot.',
    module: 'ai_agent', access: 'write', scope: 'ristak.write', risk: 'medium', handler: agentController.updateAgent, method: 'PUT',
    idempotencyRequired: true,
    inputSchema: schema({ agentId: ID, config: { type: 'object', additionalProperties: true }, ...controls({ idempotency: true }) }, requiredWith(['agentId', 'config'], { idempotency: true })),
    params: (args) => ({ agentId: args.agentId }), body: (args) => args.config
  }),
  controllerSpec({
    name: 'chatbot_delete', description: 'Elimina un chatbot. Esta acción no se puede deshacer.',
    module: 'ai_agent', access: 'write', scope: 'ristak.destructive', risk: 'critical', handler: agentController.deleteAgent, method: 'DELETE',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ agentId: ID, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['agentId'], { confirm: true, idempotency: true })),
    params: (args) => ({ agentId: args.agentId })
  }),
  controllerSpec({
    name: 'chatbot_test', description: 'Ejecuta una prueba aislada del chatbot; no envía el mensaje al contacto real.',
    module: 'ai_agent', access: 'write', scope: 'ristak.execute', risk: 'medium', handler: agentController.testAgent, method: 'POST',
    idempotencyRequired: true,
    inputSchema: schema({ request: { type: 'object', additionalProperties: true }, ...controls({ idempotency: true }) }, requiredWith(['request'], { idempotency: true })),
    body: (args) => args.request
  }),
  controllerSpec({
    name: 'chatbot_list_states', description: 'Lista estados de conversaciones gestionadas por los chatbots.',
    module: 'ai_agent', access: 'read', scope: 'ristak.read', risk: 'low', handler: agentController.listStates,
    inputSchema: schema({ agentId: ID, status: SHORT_TEXT, limit: { type: 'integer', minimum: 1, maximum: 200 }, cursor: { type: 'string', maxLength: 1200 } }), query: cleanRequestObject
  }),
  controllerSpec({
    name: 'chatbot_get_state', description: 'Obtiene el estado conversacional de un contacto.',
    module: 'ai_agent', access: 'read', scope: 'ristak.read', risk: 'low', handler: agentController.getState,
    inputSchema: schema({ contactId: ID }, ['contactId']), params: (args) => ({ contactId: args.contactId })
  }),
  controllerSpec({
    name: 'chatbot_update_state', description: 'Pausa, reanuda o corrige el estado conversacional de un contacto.',
    module: 'ai_agent', access: 'write', scope: 'ristak.write', risk: 'medium', handler: agentController.updateState, method: 'POST',
    idempotencyRequired: true,
    inputSchema: schema({ contactId: ID, state: { type: 'object', additionalProperties: true }, ...controls({ idempotency: true }) }, requiredWith(['contactId', 'state'], { idempotency: true })),
    params: (args) => ({ contactId: args.contactId }), body: (args) => args.state
  }),
  controllerSpec({
    name: 'chatbot_events', description: 'Consulta eventos recientes de los chatbots por contacto o tipo.',
    module: 'ai_agent', access: 'read', scope: 'ristak.read', risk: 'low', handler: agentController.listEvents,
    inputSchema: schema({ contactId: ID, kind: SHORT_TEXT, limit: { type: 'integer', minimum: 1, maximum: 500 } }), query: cleanRequestObject
  })
]

const calendarTools = [
  controllerSpec({
    name: 'appointments_list_calendars', description: 'Lista calendarios locales y conectados con sus URLs públicas.',
    module: 'appointments', access: 'read', scope: 'ristak.read', risk: 'low', handler: calendarsController.getCalendars,
    inputSchema: schema({ sourcePreference: { type: 'string', maxLength: 40 } }), query: cleanRequestObject
  }),
  controllerSpec({
    name: 'appointments_get_calendar', description: 'Obtiene la configuración funcional de un calendario.',
    module: 'appointments', access: 'read', scope: 'ristak.read', risk: 'low', handler: calendarsController.getCalendar,
    inputSchema: schema({ calendarId: ID }, ['calendarId']), params: (args) => ({ id: args.calendarId })
  }),
  controllerSpec({
    name: 'appointments_get_free_slots',
    description: 'Calcula disponibilidad real en la zona horaria del negocio para un rango de fechas de calendario.',
    module: 'appointments', access: 'read', scope: 'ristak.read', risk: 'low', handler: calendarsController.getFreeSlots,
    inputSchema: schema({ calendarId: ID, startDate: { type: 'string', maxLength: 10 }, endDate: { type: 'string', maxLength: 10 } }, ['calendarId', 'startDate', 'endDate']),
    params: (args) => ({ id: args.calendarId }), query: (args) => ({ startDate: args.startDate, endDate: args.endDate })
  }),
  controllerSpec({
    name: 'appointments_list', description: 'Lista citas dentro de un rango de instantes ISO/epoch, opcionalmente por calendario.',
    module: 'appointments', access: 'read', scope: 'ristak.read', risk: 'low', handler: calendarsController.getEvents,
    inputSchema: schema({ startTime: { type: ['string', 'number'] }, endTime: { type: ['string', 'number'] }, calendarId: ID }, ['startTime', 'endTime']),
    query: cleanRequestObject
  }),
  controllerSpec({
    name: 'appointments_get', description: 'Obtiene los detalles completos de una cita.',
    module: 'appointments', access: 'read', scope: 'ristak.read', risk: 'low', handler: calendarsController.getAppointment,
    inputSchema: schema({ appointmentId: ID }, ['appointmentId']), params: (args) => ({ eventId: args.appointmentId })
  }),
  controllerSpec({
    name: 'appointments_create',
    description: 'Crea una cita con las validaciones de disponibilidad, contacto, calendario y zona horaria de Ristak.',
    module: 'appointments', access: 'write', scope: 'ristak.execute', risk: 'high', handler: calendarsController.createAppointment, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({
      calendarId: ID, contactId: ID, title: SHORT_TEXT,
      startTime: { type: 'string', minLength: 10, maxLength: 80 }, endTime: { type: 'string', maxLength: 80 },
      duration: { type: 'integer', minimum: 1, maximum: 1440 }, timezone: { type: 'string', maxLength: 100 },
      appointmentStatus: SHORT_TEXT, assignedUserId: ID, address: SHORT_TEXT, notes: TEXT,
      ...controls({ confirm: true, idempotency: true })
    }, requiredWith(['calendarId', 'contactId', 'startTime'], { confirm: true, idempotency: true })),
    body: cleanRequestObject
  }),
  controllerSpec({
    name: 'appointments_update',
    description: 'Reprograma o actualiza una cita usando las reglas del calendario y de proveedores conectados.',
    module: 'appointments', access: 'write', scope: 'ristak.execute', risk: 'high', handler: calendarsController.updateAppointment, method: 'PUT',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ appointmentId: ID, changes: { type: 'object', additionalProperties: true }, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['appointmentId', 'changes'], { confirm: true, idempotency: true })),
    params: (args) => ({ id: args.appointmentId }), body: (args) => args.changes
  }),
  controllerSpec({
    name: 'appointments_cancel', description: 'Cancela y elimina una cita según las reglas del proveedor. Requiere confirmación explícita.',
    module: 'appointments', access: 'write', scope: 'ristak.destructive', risk: 'critical', handler: calendarsController.deleteEvent, method: 'DELETE',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ appointmentId: ID, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['appointmentId'], { confirm: true, idempotency: true })),
    params: (args) => ({ id: args.appointmentId })
  }),
  controllerSpec({
    name: 'appointments_create_calendar', description: 'Crea un calendario local y sincroniza con el proveedor conectado cuando corresponde.',
    module: 'appointments', access: 'write', scope: 'ristak.write', risk: 'medium', handler: calendarsController.createCalendar, method: 'POST',
    idempotencyRequired: true,
    inputSchema: schema({ calendar: { type: 'object', additionalProperties: true }, ...controls({ idempotency: true }) }, requiredWith(['calendar'], { idempotency: true })),
    body: (args) => args.calendar
  }),
  controllerSpec({
    name: 'appointments_update_calendar', description: 'Actualiza horarios, disponibilidad, formularios y políticas de un calendario.',
    module: 'appointments', access: 'write', scope: 'ristak.write', risk: 'medium', handler: calendarsController.updateCalendar, method: 'PUT',
    idempotencyRequired: true,
    inputSchema: schema({ calendarId: ID, changes: { type: 'object', additionalProperties: true }, ...controls({ idempotency: true }) }, requiredWith(['calendarId', 'changes'], { idempotency: true })),
    params: (args) => ({ id: args.calendarId }), body: (args) => args.changes
  }),
  controllerSpec({
    name: 'appointments_delete_calendar', description: 'Elimina un calendario local. Puede afectar enlaces y disponibilidad publicados.',
    module: 'appointments', access: 'write', scope: 'ristak.destructive', risk: 'critical', handler: calendarsController.deleteCalendar, method: 'DELETE',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ calendarId: ID, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['calendarId'], { confirm: true, idempotency: true })),
    params: (args) => ({ id: args.calendarId })
  }),
  controllerSpec({
    name: 'appointments_list_blocks', description: 'Lista bloqueos de agenda en un rango de instantes.',
    module: 'appointments', access: 'read', scope: 'ristak.read', risk: 'low', handler: calendarsController.getBlockedSlots,
    inputSchema: schema({ calendarId: ID, startTime: { type: ['string', 'number'] }, endTime: { type: ['string', 'number'] } }, ['calendarId', 'startTime', 'endTime']),
    params: (args) => ({ calendarId: args.calendarId }), query: (args) => ({ startTime: args.startTime, endTime: args.endTime })
  }),
  controllerSpec({
    name: 'appointments_create_block', description: 'Bloquea un intervalo en un calendario.',
    module: 'appointments', access: 'write', scope: 'ristak.execute', risk: 'high', handler: calendarsController.createBlockedSlot, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ calendarId: ID, startTime: { type: 'string', maxLength: 80 }, endTime: { type: 'string', maxLength: 80 }, title: SHORT_TEXT, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['calendarId', 'startTime', 'endTime'], { confirm: true, idempotency: true })),
    body: cleanRequestObject
  }),
  controllerSpec({
    name: 'appointments_delete_block', description: 'Elimina un bloqueo de agenda.',
    module: 'appointments', access: 'write', scope: 'ristak.destructive', risk: 'high', handler: calendarsController.deleteBlockedSlot, method: 'DELETE',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ blockId: ID, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['blockId'], { confirm: true, idempotency: true })),
    params: (args) => ({ id: args.blockId })
  })
]

const paymentTools = [
  controllerSpec({
    name: 'payments_list', description: 'Lista pagos con filtros, búsqueda y paginación; respeta la moneda y fechas de la cuenta.',
    module: 'payments', access: 'read', scope: 'ristak.read', risk: 'low', handler: transactionsController.getTransactions,
    inputSchema: schema({
      limit: { type: 'integer', minimum: 1, maximum: 100 }, page: { type: 'integer', minimum: 1, maximum: 100000 },
      cursor: { type: 'string', maxLength: 1200 }, status: { type: 'string', maxLength: 80 }, search: { type: 'string', maxLength: 200 },
      startDate: { type: 'string', maxLength: 10 }, endDate: { type: 'string', maxLength: 10 },
      sortBy: { type: 'string', maxLength: 40 }, sortOrder: { type: 'string', enum: ['ASC', 'DESC'] }
    }), query: cleanRequestObject
  }),
  controllerSpec({
    name: 'payments_get', description: 'Obtiene un pago con su contacto, proveedor y estado.',
    module: 'payments', access: 'read', scope: 'ristak.read', risk: 'low', handler: transactionsController.getTransactionById,
    inputSchema: schema({ paymentId: ID }, ['paymentId']), params: (args) => ({ id: args.paymentId })
  }),
  controllerSpec({
    name: 'payments_create',
    description: 'Registra una transacción local usando la moneda configurada en la cuenta. Reintentos con la misma clave no duplican el pago.',
    module: 'payments', access: 'write', scope: 'ristak.execute', risk: 'high', handler: transactionsController.createTransaction, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({
      amount: { type: 'number', exclusiveMinimum: 0 }, method: SHORT_TEXT, paymentMethod: SHORT_TEXT, status: SHORT_TEXT,
      reference: SHORT_TEXT, title: SHORT_TEXT, description: TEXT, date: { type: 'string', maxLength: 80 }, dueDate: { type: 'string', maxLength: 80 },
      contactId: ID, contactName: SHORT_TEXT, email: { type: 'string', maxLength: 320 }, phone: { type: 'string', maxLength: 80 },
      paymentMode: { type: 'string', enum: ['test', 'live'] }, metadata: { type: 'object', additionalProperties: true },
      ...controls({ confirm: true, idempotency: true })
    }, requiredWith(['amount'], { confirm: true, idempotency: true })),
    body: (args) => ({ ...cleanRequestObject(args), id: `mcp_${args.idempotencyKey}` })
  }),
  controllerSpec({
    name: 'payments_update', description: 'Actualiza datos editables de un pago sin saltarse flujos protegidos de comprobantes.',
    module: 'payments', access: 'write', scope: 'ristak.write', risk: 'medium', handler: transactionsController.updateTransaction, method: 'PUT',
    idempotencyRequired: true,
    inputSchema: schema({ paymentId: ID, changes: paymentEditableChanges, ...controls({ idempotency: true }) }, requiredWith(['paymentId', 'changes'], { idempotency: true })),
    params: (args) => ({ id: args.paymentId }), body: (args) => args.changes
  }),
  controllerSpec({
    name: 'payments_record', description: 'Marca una transacción existente como pagada y ejecuta su reconciliación, estadísticas y automatizaciones.',
    module: 'payments', access: 'write', scope: 'ristak.execute', risk: 'critical', handler: transactionsController.recordPayment, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ paymentId: ID, amount: { type: 'number', exclusiveMinimum: 0 }, paymentDate: { type: 'string', maxLength: 80 }, paymentMethod: SHORT_TEXT, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['paymentId'], { confirm: true, idempotency: true })),
    params: (args) => ({ id: args.paymentId }), body: cleanRequestObject
  }),
  controllerSpec({
    name: 'payments_refund', description: 'Registra el reembolso de un pago completado cuando Ristak es la fuente autorizada.',
    module: 'payments', access: 'write', scope: 'ristak.destructive', risk: 'critical', handler: transactionsController.refundTransaction, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ paymentId: ID, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['paymentId'], { confirm: true, idempotency: true })),
    params: (args) => ({ id: args.paymentId })
  }),
  controllerSpec({
    name: 'payments_void', description: 'Anula una transacción pendiente; nunca convierte un pago completado en borrado.',
    module: 'payments', access: 'write', scope: 'ristak.destructive', risk: 'critical', handler: transactionsController.voidTransaction, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ paymentId: ID, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['paymentId'], { confirm: true, idempotency: true })),
    params: (args) => ({ id: args.paymentId })
  }),
  controllerSpec({
    name: 'payments_get_link', description: 'Obtiene el enlace de cobro disponible para una transacción.',
    module: 'payments', access: 'read', scope: 'ristak.read', risk: 'low', handler: transactionsController.getPaymentLink,
    inputSchema: schema({ paymentId: ID }, ['paymentId']), params: (args) => ({ id: args.paymentId })
  }),
  controllerSpec({
    name: 'payments_send', description: 'Envía el cobro/invoice al contacto mediante el proveedor conectado.',
    module: 'payments', access: 'write', scope: 'ristak.execute', risk: 'high', handler: transactionsController.sendTransaction, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ paymentId: ID, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['paymentId'], { confirm: true, idempotency: true })),
    params: (args) => ({ id: args.paymentId })
  }),
  controllerSpec({
    name: 'payments_list_plans', description: 'Lista planes y calendarios de pagos.',
    module: 'payments', access: 'read', scope: 'ristak.read', risk: 'low', featureKeys: ['payment_plans'], handler: paymentPlansController.listPaymentPlans,
    inputSchema: schema({ contactId: ID, status: SHORT_TEXT, limit: { type: 'integer', minimum: 1, maximum: 200 } }), query: cleanRequestObject
  }),
  controllerSpec({
    name: 'payments_get_plan', description: 'Obtiene un plan de pagos y sus cuotas.',
    module: 'payments', access: 'read', scope: 'ristak.read', risk: 'low', featureKeys: ['payment_plans'], handler: paymentPlansController.getPaymentPlan,
    inputSchema: schema({ planId: ID }, ['planId']), params: (args) => ({ scheduleId: args.planId })
  }),
  controllerSpec({
    name: 'payments_create_plan', description: 'Crea un plan de pagos validado; la moneda predeterminada es la de la cuenta.',
    module: 'payments', access: 'write', scope: 'ristak.execute', risk: 'critical', featureKeys: ['payment_plans'], handler: paymentPlansController.createPaymentPlan, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ plan: { type: 'object', additionalProperties: true }, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['plan'], { confirm: true, idempotency: true })),
    body: (args) => ({ ...args.plan, idempotencyKey: args.idempotencyKey })
  }),
  controllerSpec({
    name: 'payments_update_plan', description: 'Actualiza un plan de pagos existente mediante su servicio canónico.',
    module: 'payments', access: 'write', scope: 'ristak.execute', risk: 'high', featureKeys: ['payment_plans'], handler: paymentPlansController.updatePaymentPlan, method: 'PUT',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ planId: ID, changes: { type: 'object', additionalProperties: true }, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['planId', 'changes'], { confirm: true, idempotency: true })),
    params: (args) => ({ scheduleId: args.planId }), body: (args) => args.changes
  }),
  controllerSpec({
    name: 'payments_plan_action', description: 'Pausa, reanuda o ejecuta una acción no destructiva sobre un plan de pagos.',
    module: 'payments', access: 'write', scope: 'ristak.execute', risk: 'critical', featureKeys: ['payment_plans'], handler: paymentPlansController.actionPaymentPlan, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({
      planId: ID,
      action: { type: 'string', enum: ['activate', 'pause', 'change_card', 'auto-payment'] },
      payload: { type: 'object', additionalProperties: true },
      ...controls({ confirm: true, idempotency: true })
    }, requiredWith(['planId', 'action'], { confirm: true, idempotency: true })),
    params: (args) => ({ scheduleId: args.planId }), body: (args) => ({ action: args.action, payload: args.payload || {} })
  }),
  controllerSpec({
    name: 'payments_plan_terminate', description: 'Cancela o elimina un plan de pagos mediante su flujo canónico.',
    module: 'payments', access: 'write', scope: 'ristak.destructive', risk: 'critical', featureKeys: ['payment_plans'], handler: paymentPlansController.actionPaymentPlan, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({
      planId: ID,
      action: { type: 'string', enum: ['cancel', 'delete'] },
      payload: { type: 'object', additionalProperties: true },
      ...controls({ confirm: true, idempotency: true })
    }, requiredWith(['planId', 'action'], { confirm: true, idempotency: true })),
    params: (args) => ({ scheduleId: args.planId }), body: (args) => ({ action: args.action, payload: args.payload || {} })
  })
]

const automationTools = [
  controllerSpec({
    name: 'automations_list', description: 'Lista automatizaciones, carpetas, estado y revisión del flujo.',
    module: 'automations', access: 'read', scope: 'ristak.read', risk: 'low', handler: automationsController.getAutomationsHandler,
    inputSchema: schema({ limit: { type: 'integer', minimum: 1, maximum: 200 }, cursor: { type: 'string', maxLength: 1200 }, search: { type: 'string', maxLength: 200 }, folderId: ID, status: { type: 'string', enum: ['draft', 'published', 'paused', 'archived'] }, includeReview: { type: 'boolean' } }),
    query: (args) => ({ ...cleanRequestObject(args), includeReview: args.includeReview ? 'true' : 'false' })
  }),
  controllerSpec({
    name: 'automations_get', description: 'Obtiene una automatización completa con su grafo editable y estado publicado.',
    module: 'automations', access: 'read', scope: 'ristak.read', risk: 'low', handler: automationsController.getAutomationHandler,
    inputSchema: schema({ automationId: ID }, ['automationId']), params: (args) => ({ automationId: args.automationId })
  }),
  controllerSpec({
    name: 'automations_create', description: 'Crea una automatización en borrador y valida los módulos usados por su flujo.',
    module: 'automations', access: 'write', scope: 'ristak.write', risk: 'medium', handler: automationsController.createAutomationHandler, method: 'POST',
    idempotencyRequired: true,
    inputSchema: schema({ name: SHORT_TEXT, description: TEXT, folderId: ID, flow: { type: 'object', additionalProperties: true }, ...controls({ idempotency: true }) }, requiredWith([], { idempotency: true })),
    body: cleanRequestObject
  }),
  controllerSpec({
    name: 'automations_update_draft', description: 'Edita nombre, carpeta y grafo de una automatización sin publicarla automáticamente.',
    module: 'automations', access: 'write', scope: 'ristak.write', risk: 'medium', handler: automationsController.updateAutomationHandler, method: 'PUT',
    idempotencyRequired: true,
    inputSchema: schema({ automationId: ID, name: SHORT_TEXT, description: TEXT, folderId: { type: ['string', 'null'], maxLength: 180 }, flow: { type: 'object', additionalProperties: true }, ...controls({ idempotency: true }) }, requiredWith(['automationId'], { idempotency: true })),
    params: (args) => ({ automationId: args.automationId }),
    body: (args) => { const bodyValue = cleanRequestObject(args); delete bodyValue.automationId; delete bodyValue.status; return bodyValue }
  }),
  controllerSpec({
    name: 'automations_publish', description: 'Valida y publica el borrador actual de una automatización como flujo vivo.',
    module: 'automations', access: 'write', scope: 'ristak.execute', risk: 'critical', handler: automationsController.updateAutomationHandler, method: 'PUT',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ automationId: ID, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['automationId'], { confirm: true, idempotency: true })),
    params: (args) => ({ automationId: args.automationId }), body: () => ({ status: 'published' })
  }),
  controllerSpec({
    name: 'automations_pause', description: 'Pausa una automatización publicada sin eliminar su configuración.',
    module: 'automations', access: 'write', scope: 'ristak.execute', risk: 'high', handler: automationsController.updateAutomationHandler, method: 'PUT',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ automationId: ID, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['automationId'], { confirm: true, idempotency: true })),
    params: (args) => ({ automationId: args.automationId }), body: () => ({ status: 'paused' })
  }),
  controllerSpec({
    name: 'automations_duplicate', description: 'Duplica una automatización como borrador independiente.',
    module: 'automations', access: 'write', scope: 'ristak.write', risk: 'medium', handler: automationsController.duplicateAutomationHandler, method: 'POST',
    idempotencyRequired: true,
    inputSchema: schema({ automationId: ID, ...controls({ idempotency: true }) }, requiredWith(['automationId'], { idempotency: true })),
    params: (args) => ({ automationId: args.automationId })
  }),
  controllerSpec({
    name: 'automations_delete', description: 'Elimina una automatización y sus ejecuciones internas relacionadas.',
    module: 'automations', access: 'write', scope: 'ristak.destructive', risk: 'critical', handler: automationsController.deleteAutomationHandler, method: 'DELETE',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ automationId: ID, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['automationId'], { confirm: true, idempotency: true })),
    params: (args) => ({ automationId: args.automationId })
  }),
  controllerSpec({
    name: 'automations_list_enrollments', description: 'Lista contactos inscritos y estado de ejecución de una automatización.',
    module: 'automations', access: 'read', scope: 'ristak.read', risk: 'low', handler: automationsController.getEnrollmentsHandler,
    inputSchema: schema({ automationId: ID }, ['automationId']), params: (args) => ({ automationId: args.automationId })
  }),
  controllerSpec({
    name: 'automations_enroll_contact', description: 'Inscribe manualmente un contacto en una automatización.',
    module: 'automations', access: 'write', scope: 'ristak.execute', risk: 'high', handler: automationsController.enrollContactInAutomationHandler, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ automationId: ID, contactId: ID, context: { type: 'object', additionalProperties: true }, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['automationId', 'contactId'], { confirm: true, idempotency: true })),
    params: (args) => ({ automationId: args.automationId }), body: (args) => ({ contactId: args.contactId, ...(args.context || {}) })
  }),
  controllerSpec({
    name: 'automations_control_enrollment', description: 'Pausa, reanuda o cancela una inscripción concreta.',
    module: 'automations', access: 'write', scope: 'ristak.execute', risk: 'high', handler: automationsController.controlEnrollmentHandler, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ automationId: ID, enrollmentId: ID, action: SHORT_TEXT, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['automationId', 'enrollmentId', 'action'], { confirm: true, idempotency: true })),
    params: (args) => ({ automationId: args.automationId, enrollmentId: args.enrollmentId }), body: (args) => ({ action: args.action })
  }),
  controllerSpec({
    name: 'automations_test_run', description: 'Ejecuta una prueba controlada de la automatización con efectos trazables.',
    module: 'automations', access: 'write', scope: 'ristak.execute', risk: 'high', handler: automationsController.testAutomationRunHandler, method: 'POST',
    confirmRequired: true, idempotencyRequired: true,
    inputSchema: schema({ automationId: ID, input: { type: 'object', additionalProperties: true }, ...controls({ confirm: true, idempotency: true }) }, requiredWith(['automationId', 'input'], { confirm: true, idempotency: true })),
    params: (args) => ({ automationId: args.automationId }), body: (args) => args.input
  }),
  controllerSpec({
    name: 'automations_stats', description: 'Obtiene estadísticas de inscripciones y resultados de una automatización.',
    module: 'automations', access: 'read', scope: 'ristak.read', risk: 'low', handler: automationsController.getEnrollmentStatsHandler,
    inputSchema: schema({ automationId: ID }, ['automationId']), params: (args) => ({ automationId: args.automationId })
  })
]

export const domainToolSpecs = Object.freeze([
  ...contactTools,
  ...chatTools,
  ...agentTools,
  ...calendarTools,
  ...paymentTools,
  ...automationTools
])
