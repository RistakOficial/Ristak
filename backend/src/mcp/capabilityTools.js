import * as contactsController from '../controllers/contactsController.js'
import * as contactSocialProfileController from '../controllers/contactSocialProfileController.js'
import * as whatsappController from '../controllers/whatsappApiController.js'
import * as subscriptionsController from '../controllers/subscriptionsController.js'
import * as transactionsController from '../controllers/transactionsController.js'
import * as calendarsController from '../controllers/calendarsController.js'
import * as appointmentRemindersController from '../controllers/appointmentRemindersController.js'
import * as automationsController from '../controllers/automationsController.js'
import * as sitesController from '../controllers/sitesController.js'
import * as mediaController from '../controllers/mediaController.js'
import * as trackingController from '../controllers/trackingController.js'
import * as settingsController from '../controllers/settingsController.js'
import * as variableFieldsController from '../controllers/variableFieldsController.js'
import * as notificationsController from '../controllers/notificationsController.js'
import * as conversationalAgentController from '../controllers/conversationalAgentController.js'
import * as configController from '../controllers/configController.js'
import * as authController from '../controllers/authController.js'
import * as userAccessController from '../controllers/userAccessController.js'
import * as emailController from '../controllers/emailController.js'
import * as highlevelController from '../controllers/highlevelController.js'
import * as bunnyController from '../controllers/bunnyAccountIntegrationController.js'
import { listSiteSubmissions } from '../services/sitesService.js'
import {
  getAutomation,
  testAutomationWebhookAction
} from '../services/automationsService.js'

const ID = { type: 'string', minLength: 1, maxLength: 300 }
const SHORT_TEXT = { type: 'string', maxLength: 500 }
const REQUIRED_SHORT_TEXT = { type: 'string', minLength: 1, maxLength: 500 }
const LONG_TEXT = { type: 'string', maxLength: 50000 }
const URL = { type: 'string', minLength: 1, maxLength: 2048 }
const DATE_TIME = {
  type: 'string',
  minLength: 10,
  maxLength: 80,
  description: 'Fecha o instante que Ristak interpreta con la zona horaria de la cuenta.'
}
const OBJECT = { type: 'object', maxProperties: 150, additionalProperties: true }
const ARRAY_OF_IDS = { type: 'array', minItems: 1, maxItems: 1000, items: ID }
const IDEMPOTENCY_KEY = {
  type: 'string',
  minLength: 8,
  maxLength: 180,
  pattern: '^[A-Za-z0-9._:-]+$'
}
const CONFIRM = {
  type: 'boolean',
  description: 'Debe ser true después de que la persona apruebe la solicitud en Ristak.'
}
const APPROVAL_TICKET = {
  type: 'string',
  minLength: 32,
  maxLength: 4096,
  description: 'Pase firmado y de un solo uso emitido por mcp_prepare_action_confirmation.'
}

function schema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function mutationSchema(inputSchema = schema()) {
  return {
    ...inputSchema,
    properties: {
      ...(inputSchema.properties || {}),
      confirm: CONFIRM,
      approvalTicket: APPROVAL_TICKET,
      idempotencyKey: IDEMPOTENCY_KEY
    },
    required: [...new Set([
      ...(inputSchema.required || []),
      'confirm',
      'approvalTicket',
      'idempotencyKey'
    ])]
  }
}

function cleanControls(args = {}) {
  const cleaned = { ...args }
  delete cleaned.confirm
  delete cleaned.approvalTicket
  delete cleaned.idempotencyKey
  return cleaned
}

function compactDefined(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function baseSpec(definition) {
  return Object.freeze({
    featureKeys: [],
    additionalModules: [],
    connectionPrerequisites: [],
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
  mapResponse,
  ...definition
}) {
  if (typeof handler !== 'function') {
    throw new Error(`Controller inválido para ${definition.name || 'una herramienta MCP'}`)
  }
  const mutation = definition.access === 'write'
  return baseSpec({
    ...definition,
    inputSchema: mutation
      ? mutationSchema(definition.inputSchema || schema())
      : (definition.inputSchema || schema()),
    confirmRequired: mutation,
    idempotencyRequired: mutation,
    async execute(context, args = {}) {
      const response = await context.invoke(handler, {
        method,
        params: params(args),
        query: query(args),
        body: body(args),
        ...(mutation ? { headers: { 'idempotency-key': args.idempotencyKey } } : {})
      })
      return mapResponse ? mapResponse(response) : response
    }
  })
}

function readTool(definition) {
  return controllerSpec({ access: 'read', scope: 'ristak.read', risk: 'low', ...definition })
}

function mutationTool(definition) {
  return controllerSpec({
    access: 'write',
    scope: 'ristak.write',
    risk: 'medium',
    method: 'POST',
    ...definition
  })
}

function executeTool(definition) {
  return mutationTool({ scope: 'ristak.execute', risk: 'high', openWorld: true, ...definition })
}

function destructiveTool(definition) {
  return mutationTool({ scope: 'ristak.destructive', risk: 'critical', ...definition })
}

const contactTools = [
  readTool({
    name: 'contacts_get_journey',
    description: 'Obtiene el recorrido cronológico de un contacto con mensajes, citas, pagos y atribución, paginado y protegido por los filtros de visibilidad.',
    module: 'contacts',
    handler: contactsController.getContactJourney,
    inputSchema: schema({
      contactId: ID,
      includeBusinessMessages: { type: 'boolean' },
      messageLimit: { type: 'integer', minimum: 1, maximum: 500 },
      beforeMessageDate: DATE_TIME,
      beforeMessageCursor: { type: 'string', maxLength: 1200 }
    }, ['contactId']),
    params: args => ({ id: args.contactId }),
    query: args => compactDefined({
      includeBusinessMessages: args.includeBusinessMessages ? 'true' : undefined,
      messageLimit: args.messageLimit,
      beforeMessageDate: args.beforeMessageDate,
      beforeMessageCursor: args.beforeMessageCursor
    })
  }),
  executeTool({
    name: 'contacts_refresh_external',
    description: 'Programa una actualización segura del perfil, citas o estados externos del contacto sin exponer credenciales del proveedor.',
    module: 'contacts',
    handler: contactsController.refreshContactExternalData,
    inputSchema: schema({
      contactId: ID,
      sections: {
        type: 'array',
        maxItems: 3,
        items: { type: 'string', enum: ['profile', 'appointments', 'conversationStatuses'] }
      }
    }, ['contactId']),
    params: args => ({ id: args.contactId }),
    body: args => ({ sections: args.sections })
  }),
  mutationTool({
    name: 'contacts_bulk_update_custom_fields',
    description: 'Actualiza campos personalizados de hasta 1000 contactos y dispara los eventos de automatización canónicos.',
    module: 'contacts',
    handler: contactsController.bulkUpdateContactCustomFields,
    inputSchema: schema({
      contactIds: ARRAY_OF_IDS,
      customFields: { type: 'array', minItems: 1, maxItems: 100, items: OBJECT }
    }, ['contactIds', 'customFields']),
    body: cleanControls
  }),
  executeTool({
    name: 'contacts_bulk_whatsapp_template',
    description: 'Crea un lote persistente de plantillas WhatsApp; el backend lo procesa aunque termine la conversación con la IA.',
    module: 'contacts',
    additionalModules: [{ module: 'chat', access: 'write' }],
    featureKeys: ['whatsapp_templates'],
    connectionPrerequisites: ['whatsapp'],
    handler: contactsController.createBulkWhatsAppTemplateAction,
    inputSchema: schema({ payload: OBJECT }, ['payload']),
    body: args => args.payload
  }),
  executeTool({
    name: 'contacts_bulk_automation',
    description: 'Crea un lote persistente para inscribir contactos en una automatización publicada.',
    module: 'contacts',
    additionalModules: [{ module: 'automations', access: 'write' }],
    featureKeys: ['automations'],
    handler: contactsController.createBulkAutomationAction,
    inputSchema: schema({ payload: OBJECT }, ['payload']),
    body: args => args.payload
  }),
  mutationTool({
    name: 'chat_mark_many_read',
    description: 'Marca varios chats como leídos para el usuario conectado y encola recibos del proveedor cuando corresponda.',
    module: 'chat',
    additionalModules: ['contacts'],
    handler: contactsController.markChatContactsRead,
    inputSchema: schema({ contactIds: ARRAY_OF_IDS }, ['contactIds']),
    body: args => ({ contactIds: args.contactIds })
  }),
  readTool({
    name: 'chat_get_channel_preference',
    description: 'Obtiene el canal preferido para responder a un contacto.',
    module: 'chat',
    additionalModules: ['contacts'],
    handler: contactsController.getContactConversationalChannelPreference,
    inputSchema: schema({ contactId: ID }, ['contactId']),
    params: args => ({ id: args.contactId })
  }),
  mutationTool({
    name: 'chat_set_channel_preference',
    description: 'Fija el canal y ruta preferidos para responder al contacto mediante el flujo manual auditado.',
    module: 'chat',
    additionalModules: [{ module: 'contacts', access: 'write' }],
    handler: contactsController.updateContactConversationalChannelPreference,
    method: 'PUT',
    inputSchema: schema({
      contactId: ID,
      channel: { type: 'string', minLength: 1, maxLength: 80 },
      routeId: ID,
      routeLabel: SHORT_TEXT
    }, ['contactId', 'channel']),
    params: args => ({ id: args.contactId }),
    body: args => compactDefined({ channel: args.channel, routeId: args.routeId, routeLabel: args.routeLabel })
  }),
  readTool({
    name: 'chat_get_linked_social',
    description: 'Obtiene perfiles sociales ligados al contacto sin consultar ni administrar campañas publicitarias.',
    module: 'chat',
    additionalModules: ['contacts'],
    handler: contactSocialProfileController.getContactLinkedSocial,
    inputSchema: schema({ contactId: ID }, ['contactId']),
    params: args => ({ id: args.contactId })
  }),
  readTool({
    name: 'chat_get_whatsapp_routing_events',
    description: 'Lista los cambios de número o ruta WhatsApp que afectaron a un contacto.',
    module: 'chat',
    additionalModules: ['contacts'],
    handler: contactsController.getContactWhatsAppRoutingEvents,
    inputSchema: schema({ contactId: ID }, ['contactId']),
    params: args => ({ id: args.contactId })
  })
]

const whatsappBaseProperties = {
  contactId: ID,
  to: { type: 'string', minLength: 3, maxLength: 80 },
  from: { type: 'string', maxLength: 80 },
  phoneNumberId: ID,
  transport: { type: 'string', maxLength: 40 }
}

const whatsAppTools = [
  ...[
    ['image', whatsappController.sendWhatsAppApiImageMessageView, 'imagen', { caption: LONG_TEXT }],
    ['document', whatsappController.sendWhatsAppApiDocumentMessageView, 'documento', { caption: LONG_TEXT, filename: SHORT_TEXT, mimeType: SHORT_TEXT }],
    ['video', whatsappController.sendWhatsAppApiVideoMessageView, 'video', { caption: LONG_TEXT }],
    ['audio', whatsappController.sendWhatsAppApiAudioMessageView, 'audio', { durationMs: { type: 'integer', minimum: 0, maximum: 86400000 }, voice: { type: 'boolean' } }]
  ].map(([kind, handler, label, extra]) => executeTool({
    name: `chat_send_whatsapp_${kind}`,
    description: `Envía ${label} por WhatsApp usando un asset de Media ya autorizado; no acepta bytes ni credenciales en la llamada.`,
    module: 'chat',
    featureKeys: ['whatsapp_api'],
    connectionPrerequisites: ['whatsapp'],
    handler,
    inputSchema: schema({
      ...whatsappBaseProperties,
      mediaAssetId: ID,
      ...extra
    }, ['contactId', 'to', 'mediaAssetId']),
    body: args => ({
      ...cleanControls(args),
      [`${kind}MediaAssetId`]: args.mediaAssetId,
      messageOrigin: 'manual_chat',
      externalId: args.idempotencyKey
    })
  })),
  executeTool({
    name: 'chat_send_whatsapp_location',
    description: 'Envía una ubicación por WhatsApp con coordenadas, nombre y dirección opcionales.',
    module: 'chat',
    featureKeys: ['whatsapp_api'],
    connectionPrerequisites: ['whatsapp'],
    handler: whatsappController.sendWhatsAppApiLocationMessageView,
    inputSchema: schema({
      ...whatsappBaseProperties,
      latitude: { type: 'number', minimum: -90, maximum: 90 },
      longitude: { type: 'number', minimum: -180, maximum: 180 },
      name: SHORT_TEXT,
      address: { type: 'string', maxLength: 1000 }
    }, ['contactId', 'to', 'latitude', 'longitude']),
    body: args => ({ ...cleanControls(args), messageOrigin: 'manual_chat', externalId: args.idempotencyKey })
  }),
  executeTool({
    name: 'chat_send_whatsapp_reaction',
    description: 'Reacciona a un mensaje WhatsApp existente usando su identificador local o del proveedor.',
    module: 'chat',
    featureKeys: ['whatsapp_api'],
    connectionPrerequisites: ['whatsapp'],
    handler: whatsappController.sendWhatsAppApiReactionMessageView,
    inputSchema: {
      ...schema({
        ...whatsappBaseProperties,
        emoji: { type: 'string', minLength: 1, maxLength: 32 },
        targetMessageId: ID,
        targetProviderMessageId: ID
      }, ['contactId', 'to', 'emoji']),
      anyOf: [{ required: ['targetMessageId'] }, { required: ['targetProviderMessageId'] }]
    },
    body: args => ({ ...cleanControls(args), messageOrigin: 'manual_chat', externalId: args.idempotencyKey })
  }),
  executeTool({
    name: 'chat_send_whatsapp_interactive',
    description: 'Envía un mensaje WhatsApp con botones o enlace mediante el transporte conectado.',
    module: 'chat',
    featureKeys: ['whatsapp_api'],
    connectionPrerequisites: ['whatsapp'],
    handler: whatsappController.sendWhatsAppApiInteractiveMessageView,
    inputSchema: schema({
      ...whatsappBaseProperties,
      body: { type: 'string', minLength: 1, maxLength: 4096 },
      buttons: { type: 'array', maxItems: 3, items: OBJECT },
      urlButton: OBJECT
    }, ['contactId', 'to', 'body']),
    body: args => ({ ...cleanControls(args), externalId: args.idempotencyKey })
  }),
  executeTool({
    name: 'chat_send_whatsapp_template',
    description: 'Envía una plantilla WhatsApp aprobada con sus variables y componentes.',
    module: 'chat',
    featureKeys: ['whatsapp_templates'],
    connectionPrerequisites: ['whatsapp'],
    handler: whatsappController.sendWhatsAppApiTemplateMessageView,
    inputSchema: {
      ...schema({
        ...whatsappBaseProperties,
        templateId: ID,
        templateName: SHORT_TEXT,
        language: { type: 'string', maxLength: 30 },
        components: { type: 'array', maxItems: 30, items: OBJECT },
        variables: OBJECT,
        appointmentId: ID
      }, ['contactId', 'to']),
      anyOf: [{ required: ['templateId'] }, { required: ['templateName'] }]
    },
    body: args => ({ ...cleanControls(args), externalId: args.idempotencyKey })
  })
]

const paymentTools = [
  executeTool({
    name: 'payments_create_subscription',
    description: 'Crea una suscripción con la moneda configurada en la cuenta y, cuando aplica, devuelve el enlace para que el cliente autorice el cobro.',
    module: 'payments',
    featureKeys: ['subscriptions'],
    connectionPrerequisites: ['payment_subscriptions'],
    handler: subscriptionsController.createSubscriptionView,
    inputSchema: schema({
      contactId: ID,
      contactName: SHORT_TEXT,
      contactEmail: { type: 'string', maxLength: 320 },
      contactPhone: { type: 'string', maxLength: 80 },
      name: REQUIRED_SHORT_TEXT,
      description: LONG_TEXT,
      amount: { type: 'number', exclusiveMinimum: 0 },
      intervalType: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
      intervalCount: { type: 'integer', minimum: 1, maximum: 365 },
      startDate: DATE_TIME,
      nextRunAt: DATE_TIME,
      cancelAt: DATE_TIME,
      paymentProvider: { type: 'string', enum: ['stripe', 'mercadopago', 'conekta', 'rebill'] },
      paymentMethod: SHORT_TEXT,
      paymentMode: { type: 'string', enum: ['test', 'live'] }
    }, ['name', 'amount', 'intervalType', 'paymentProvider']),
    body: args => ({ ...cleanControls(args), source: 'ristak_mcp' })
  }),
  executeTool({
    name: 'payments_approve_transfer_proof',
    description: 'Aprueba un comprobante de transferencia pendiente usando el monto, moneda y contacto inmutables del registro.',
    module: 'payments',
    handler: transactionsController.approveTransferProof,
    inputSchema: schema({ paymentId: ID, reference: SHORT_TEXT }, ['paymentId']),
    params: args => ({ id: args.paymentId }),
    body: args => ({ reference: args.reference })
  }),
  destructiveTool({
    name: 'payments_reject_transfer_proof',
    description: 'Rechaza un comprobante de transferencia pendiente y conserva el motivo para auditoría.',
    module: 'payments',
    handler: transactionsController.rejectTransferProof,
    inputSchema: schema({ paymentId: ID, reason: REQUIRED_SHORT_TEXT }, ['paymentId', 'reason']),
    params: args => ({ id: args.paymentId }),
    body: args => ({ reason: args.reason })
  })
]

const appointmentTools = [
  readTool({
    name: 'appointments_reminders_list',
    description: 'Lista recordatorios, confirmaciones y canales automáticos de un calendario.',
    module: 'appointments',
    handler: appointmentRemindersController.getAppointmentRemindersHandler,
    inputSchema: schema({ calendarId: ID }, ['calendarId']),
    query: args => ({ calendarId: args.calendarId })
  }),
  mutationTool({
    name: 'appointments_reminder_create',
    description: 'Crea un recordatorio o confirmación persistente que el job de Ristak ejecutará en la zona horaria del negocio.',
    module: 'appointments',
    handler: appointmentRemindersController.createAppointmentReminderHandler,
    inputSchema: schema({ calendarId: ID, reminder: OBJECT }, ['calendarId', 'reminder']),
    body: args => ({ ...args.reminder, calendarId: args.calendarId })
  }),
  mutationTool({
    name: 'appointments_reminder_update',
    description: 'Actualiza la programación, canal o contenido de un recordatorio de citas.',
    module: 'appointments',
    handler: appointmentRemindersController.updateAppointmentReminderHandler,
    method: 'PUT',
    inputSchema: schema({ reminderId: ID, calendarId: ID, changes: OBJECT }, ['reminderId', 'calendarId', 'changes']),
    params: args => ({ reminderId: args.reminderId }),
    body: args => ({ ...args.changes, calendarId: args.calendarId })
  }),
  destructiveTool({
    name: 'appointments_reminder_delete',
    description: 'Elimina un recordatorio de citas y evita sus envíos futuros.',
    module: 'appointments',
    handler: appointmentRemindersController.deleteAppointmentReminderHandler,
    method: 'DELETE',
    inputSchema: schema({ reminderId: ID, calendarId: ID }, ['reminderId', 'calendarId']),
    params: args => ({ reminderId: args.reminderId }),
    query: args => ({ calendarId: args.calendarId })
  }),
  mutationTool({
    name: 'appointments_update_block',
    description: 'Actualiza un bloqueo de agenda respetando la zona horaria y las reglas del calendario.',
    module: 'appointments',
    handler: calendarsController.updateBlockedSlot,
    method: 'PUT',
    inputSchema: schema({ blockId: ID, changes: OBJECT }, ['blockId', 'changes']),
    params: args => ({ id: args.blockId }),
    body: args => args.changes
  }),
  readTool({
    name: 'appointments_google_status',
    description: 'Obtiene el estado funcional de Google Calendar sin devolver refresh tokens ni credenciales.',
    module: 'appointments',
    featureKeys: ['google_calendar'],
    handler: calendarsController.getGoogleCalendarIntegration
  }),
  readTool({
    name: 'appointments_google_calendars',
    description: 'Lista los calendarios disponibles en la cuenta Google conectada.',
    module: 'appointments',
    featureKeys: ['google_calendar'],
    connectionPrerequisites: ['google_calendar'],
    handler: calendarsController.listGoogleCalendarOptions
  }),
  executeTool({
    name: 'appointments_google_test',
    description: 'Prueba lectura, creación, actualización y cancelación en Google Calendar usando el diagnóstico canónico.',
    module: 'appointments',
    featureKeys: ['google_calendar'],
    connectionPrerequisites: ['google_calendar'],
    handler: calendarsController.testGoogleCalendarIntegration,
    inputSchema: schema({ calendarId: ID }),
    body: args => cleanControls(args)
  }),
  executeTool({
    name: 'appointments_google_sync',
    description: 'Sincroniza Google Calendar ahora; el cron futuro sólo queda activo mientras la integración siga conectada.',
    module: 'appointments',
    featureKeys: ['google_calendar'],
    connectionPrerequisites: ['google_calendar'],
    handler: calendarsController.syncGoogleCalendarIntegration,
    inputSchema: schema({ calendarId: ID }),
    body: args => cleanControls(args)
  }),
  readTool({
    name: 'appointments_google_merge_preview',
    description: 'Previsualiza la fusión de calendarios sin modificar citas.',
    module: 'appointments',
    featureKeys: ['google_calendar'],
    connectionPrerequisites: ['google_calendar'],
    handler: calendarsController.getGoogleCalendarMergePreview
  }),
  executeTool({
    name: 'appointments_google_merge',
    description: 'Fusiona las citas locales seleccionadas con Google Calendar mediante el flujo protegido.',
    module: 'appointments',
    featureKeys: ['google_calendar'],
    connectionPrerequisites: ['google_calendar'],
    handler: calendarsController.mergeGoogleCalendarAppointments,
    inputSchema: schema({ payload: OBJECT }, ['payload']),
    body: args => args.payload
  })
]

const automationTools = [
  mutationTool({
    name: 'automations_folder_create',
    description: 'Crea una carpeta para organizar automatizaciones.',
    module: 'automations',
    handler: automationsController.createFolderHandler,
    inputSchema: schema({ name: REQUIRED_SHORT_TEXT, description: LONG_TEXT }, ['name']),
    body: cleanControls
  }),
  mutationTool({
    name: 'automations_folder_update',
    description: 'Renombra o actualiza una carpeta de automatizaciones.',
    module: 'automations',
    handler: automationsController.updateFolderHandler,
    method: 'PUT',
    inputSchema: schema({ folderId: ID, changes: OBJECT }, ['folderId', 'changes']),
    params: args => ({ folderId: args.folderId }),
    body: args => args.changes
  }),
  mutationTool({
    name: 'automations_folders_reorder',
    description: 'Reordena carpetas de automatizaciones de forma determinista.',
    module: 'automations',
    handler: automationsController.reorderFoldersHandler,
    inputSchema: schema({ folderIds: { type: 'array', minItems: 1, maxItems: 500, items: ID } }, ['folderIds']),
    body: args => ({ folderIds: args.folderIds })
  }),
  destructiveTool({
    name: 'automations_folder_delete',
    description: 'Elimina una carpeta de automatizaciones según las reglas de reasignación del servicio.',
    module: 'automations',
    handler: automationsController.deleteFolderHandler,
    method: 'DELETE',
    inputSchema: schema({ folderId: ID }, ['folderId']),
    params: args => ({ folderId: args.folderId })
  }),
  ...[
    ['forms', automationsController.getFormsCatalogHandler, 'formularios'],
    ['form_fields', automationsController.getFormFieldsCatalogHandler, 'campos de formulario'],
    ['whatsapp_templates', automationsController.getWhatsAppTemplatesCatalogHandler, 'plantillas WhatsApp']
  ].map(([suffix, handler, label]) => readTool({
    name: `automations_catalog_${suffix}`,
    description: `Lista el catálogo paginado de ${label} disponible para disparadores y acciones.`,
    module: 'automations',
    handler,
    inputSchema: schema({ search: { type: 'string', maxLength: 200 }, cursor: { type: 'string', maxLength: 1200 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
    query: args => compactDefined(args)
  })),
  executeTool({
    name: 'automations_asset_upload_small',
    description: 'Sube un asset pequeño para una automatización. El payload MCP admite hasta 1.8 MB en base64; para archivos mayores usa Media.',
    module: 'automations',
    handler: automationsController.uploadAssetHandler,
    inputSchema: schema({
      fileBase64: { type: 'string', minLength: 16, maxLength: 1800000 },
      filename: REQUIRED_SHORT_TEXT,
      deliveryMode: { type: 'string', enum: ['image', 'video', 'audio', 'voice', 'document'] }
    }, ['fileBase64', 'filename']),
    body: args => compactDefined({ fileBase64: args.fileBase64, filename: args.filename, deliveryMode: args.deliveryMode })
  }),
  readTool({
    name: 'automations_contact_activity',
    description: 'Obtiene la actividad de automatizaciones de un contacto.',
    module: 'automations',
    additionalModules: ['contacts'],
    handler: automationsController.getContactAutomationActivityHandler,
    inputSchema: schema({ contactId: ID }, ['contactId']),
    params: args => ({ contactId: args.contactId })
  }),
  baseSpec({
    name: 'automations_test_webhook_action',
    description: 'Prueba una acción webhook ya guardada en una automatización, sin pedir ni transportar sus credenciales por el MCP.',
    module: 'automations',
    access: 'write',
    scope: 'ristak.execute',
    risk: 'high',
    openWorld: true,
    confirmRequired: true,
    idempotencyRequired: true,
    inputSchema: mutationSchema(schema({ automationId: ID, nodeId: ID }, ['automationId', 'nodeId'])),
    async execute(_context, args) {
      const automation = await getAutomation(args.automationId)
      const flow = automation?.flow || automation?.publishedFlow || automation?.published_flow
      const nodes = Array.isArray(flow?.nodes) ? flow.nodes : []
      const node = nodes.find(entry => String(entry?.id || '') === String(args.nodeId))
      if (!node) {
        const error = new Error('El nodo webhook no existe en esa automatización.')
        error.code = 'automation_webhook_node_not_found'
        error.status = 404
        throw error
      }
      return {
        success: true,
        data: await testAutomationWebhookAction({ config: node.config || {}, flow, nodeId: args.nodeId })
      }
    }
  })
]

const siteTools = [
  baseSpec({
    name: 'sites_list_submissions',
    description: 'Lista de forma acotada las submissions de un Site o formulario.',
    module: 'sites',
    featureKeys: ['sites'],
    access: 'read',
    scope: 'ristak.read',
    risk: 'low',
    inputSchema: schema({ siteId: ID, limit: { type: 'integer', minimum: 1, maximum: 250 } }, ['siteId']),
    async execute(_context, args) {
      return { success: true, data: await listSiteSubmissions(args.siteId, { limit: args.limit || 100 }) }
    }
  }),
  readTool({
    name: 'sites_selectors',
    description: 'Lista selectores de Sites, formularios y videos para relaciones internas.',
    module: 'sites',
    featureKeys: ['sites'],
    handler: sitesController.getSiteSelectorsHandler
  }),
  readTool({
    name: 'sites_folders_list',
    description: 'Lista carpetas de Sites.',
    module: 'sites',
    featureKeys: ['sites'],
    handler: sitesController.getSiteFoldersHandler
  }),
  mutationTool({
    name: 'sites_folder_create',
    description: 'Crea una carpeta para organizar Sites y formularios.',
    module: 'sites',
    featureKeys: ['sites'],
    handler: sitesController.createSiteFolderHandler,
    inputSchema: schema({ name: REQUIRED_SHORT_TEXT }, ['name']),
    body: cleanControls
  }),
  mutationTool({
    name: 'sites_folder_update',
    description: 'Actualiza el nombre u orden de una carpeta de Sites.',
    module: 'sites',
    featureKeys: ['sites'],
    handler: sitesController.updateSiteFolderHandler,
    method: 'PUT',
    inputSchema: schema({ folderId: ID, changes: OBJECT }, ['folderId', 'changes']),
    params: args => ({ folderId: args.folderId }),
    body: args => args.changes
  }),
  readTool({
    name: 'sites_video_assets',
    description: 'Lista videos disponibles para Sites con paginación.',
    module: 'sites',
    featureKeys: ['sites'],
    handler: sitesController.getSitesVideoAssetsHandler,
    inputSchema: schema({ search: { type: 'string', maxLength: 200 }, cursor: { type: 'string', maxLength: 1200 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
    query: args => compactDefined(args)
  }),
  readTool({
    name: 'sites_video_analytics',
    description: 'Obtiene analítica agregada de un video de Sites.',
    module: 'sites',
    featureKeys: ['sites'],
    handler: sitesController.getSitesVideoAnalyticsHandler,
    inputSchema: schema({ assetId: ID, start: DATE_TIME, end: DATE_TIME }, ['assetId']),
    params: args => ({ assetId: args.assetId }),
    query: args => compactDefined({ start: args.start, end: args.end })
  }),
  readTool({
    name: 'sites_video_viewers',
    description: 'Lista visitantes o contactos que reprodujeron un video de Sites.',
    module: 'sites',
    featureKeys: ['sites'],
    handler: sitesController.getSitesVideoViewersHandler,
    inputSchema: schema({ assetId: ID, cursor: { type: 'string', maxLength: 1200 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['assetId']),
    params: args => ({ assetId: args.assetId }),
    query: args => compactDefined({ cursor: args.cursor, limit: args.limit })
  }),
  readTool({
    name: 'sites_analytics_summary',
    description: 'Obtiene resumen de visitas, conversiones y formularios de Sites para un rango.',
    module: 'sites',
    featureKeys: ['sites'],
    handler: sitesController.getSitesAnalyticsSummaryHandler,
    method: 'POST',
    inputSchema: schema({ filters: OBJECT }),
    body: args => args.filters || {}
  })
]

const mediaTools = [
  mutationTool({
    name: 'media_folder_create',
    description: 'Crea una carpeta en la biblioteca Media.',
    module: 'settings_media',
    featureKeys: ['settings_media'],
    handler: mediaController.createMediaFolderHandler,
    inputSchema: schema({ parentPath: { type: 'string', maxLength: 1000 }, name: REQUIRED_SHORT_TEXT }, ['name']),
    body: cleanControls
  }),
  mutationTool({
    name: 'media_folder_rename',
    description: 'Renombra una carpeta Media y conserva su taxonomía.',
    module: 'settings_media',
    featureKeys: ['settings_media'],
    handler: mediaController.renameMediaFolderHandler,
    method: 'PATCH',
    inputSchema: schema({ folderPath: { type: 'string', minLength: 1, maxLength: 1000 }, name: REQUIRED_SHORT_TEXT }, ['folderPath', 'name']),
    body: cleanControls
  }),
  executeTool({
    name: 'media_folder_sync',
    description: 'Sincroniza una carpeta Media con el almacenamiento conectado.',
    module: 'settings_media',
    featureKeys: ['settings_media'],
    handler: mediaController.syncBunnyStorageFolderHandler,
    inputSchema: schema({ folderPath: { type: 'string', maxLength: 1000 } }),
    body: cleanControls
  }),
  executeTool({
    name: 'media_prepare_bunny_replace',
    description: 'Prepara un reemplazo multipart temporal y firmado para un asset Media específico sin meter los bytes del archivo en el JSON MCP.',
    module: 'settings_media',
    featureKeys: ['settings_media'],
    idempotencyResultMode: 'ephemeral',
    handler: mediaController.prepareMcpBunnyUploadHandler,
    inputSchema: schema({
      assetId: ID,
      filename: { type: 'string', minLength: 1, maxLength: 500 },
      mimeType: { type: 'string', minLength: 3, maxLength: 200 },
      sizeBytes: { type: 'integer', minimum: 1, maximum: mediaController.MEDIA_MAX_UPLOAD_BYTES },
      sha256: { type: 'string', pattern: '^[A-Fa-f0-9]{64}$' }
    }, ['assetId', 'filename', 'mimeType', 'sizeBytes', 'sha256']),
    query: () => ({ module: 'media' }),
    body: args => ({
      module: 'media',
      operation: 'replace',
      assetId: args.assetId,
      filename: args.filename,
      mimeType: args.mimeType,
      sizeBytes: args.sizeBytes,
      sha256: args.sha256
    })
  }),
  mutationTool({
    name: 'media_asset_rename',
    description: 'Renombra un asset Media sin cambiar sus bytes.',
    module: 'settings_media',
    featureKeys: ['settings_media'],
    handler: mediaController.renameMediaAssetHandler,
    method: 'PATCH',
    inputSchema: schema({ assetId: ID, name: REQUIRED_SHORT_TEXT }, ['assetId', 'name']),
    params: args => ({ assetId: args.assetId }),
    body: args => ({ name: args.name })
  }),
  readTool({
    name: 'media_asset_url',
    description: 'Obtiene la URL disponible de un asset Media para usarlo en mensajes, Sites o descargas autorizadas.',
    module: 'settings_media',
    featureKeys: ['settings_media'],
    handler: mediaController.getMediaAssetUrlHandler,
    inputSchema: schema({ assetId: ID }, ['assetId']),
    params: args => ({ assetId: args.assetId })
  }),
  readTool({
    name: 'media_prepare_archive_download',
    description: 'Prepara un enlace ZIP temporal para descargar hasta 50 assets Media autorizados sin devolver sus bytes dentro del resultado MCP.',
    module: 'settings_media',
    featureKeys: ['settings_media'],
    openWorld: true,
    handler: mediaController.prepareMcpMediaArchiveHandler,
    method: 'POST',
    inputSchema: schema({
      assetIds: { type: 'array', minItems: 1, maxItems: 50, items: ID },
      filename: { type: 'string', maxLength: 180 }
    }, ['assetIds']),
    body: args => ({ assetIds: args.assetIds, filename: args.filename })
  })
]

const trackingTools = [
  readTool({
    name: 'tracking_config',
    description: 'Obtiene configuración funcional del tracking sin revelar secretos ni abrir CORS privado.',
    module: 'analytics',
    featureKeys: ['web_analytics'],
    handler: trackingController.getTrackingConfig
  }),
  executeTool({
    name: 'tracking_domain_verify',
    description: 'Verifica el dominio de tracking configurado sin modificar APIs privadas ni instalar el pixel externo sobre Sites.',
    module: 'analytics',
    featureKeys: ['web_analytics'],
    handler: trackingController.verifyTrackingDomainHandler,
    inputSchema: schema({ domain: { type: 'string', minLength: 1, maxLength: 320 } }),
    body: cleanControls
  }),
  mutationTool({
    name: 'tracking_configure',
    description: 'Actualiza opciones permitidas del tracking respetando la separación entre pixel externo y Sites nativo.',
    module: 'analytics',
    featureKeys: ['web_analytics'],
    handler: trackingController.configureTracking,
    inputSchema: schema({ settings: OBJECT }, ['settings']),
    body: args => args.settings
  }),
  destructiveTool({
    name: 'tracking_domain_disconnect',
    description: 'Desconecta el dominio de tracking sin alterar los dominios públicos de Sites.',
    module: 'analytics',
    featureKeys: ['web_analytics'],
    handler: trackingController.disconnectTrackingDomainHandler,
    method: 'DELETE'
  }),
  mutationTool({
    name: 'tracking_session_update',
    description: 'Actualiza datos editables de una sesión de tracking.',
    module: 'analytics',
    featureKeys: ['web_analytics'],
    handler: trackingController.updateSessionHandler,
    method: 'PUT',
    inputSchema: schema({ sessionId: ID, changes: OBJECT }, ['sessionId', 'changes']),
    params: args => ({ id: args.sessionId }),
    body: args => args.changes
  }),
  destructiveTool({
    name: 'tracking_sessions_delete',
    description: 'Elimina las sesiones de tracking seleccionadas mediante el flujo autenticado.',
    module: 'analytics',
    featureKeys: ['web_analytics'],
    handler: trackingController.deleteSessionsHandler,
    method: 'DELETE',
    inputSchema: schema({ sessionIds: ARRAY_OF_IDS }, ['sessionIds']),
    body: args => ({ sessionIds: args.sessionIds })
  })
]

const settingsTools = [
  readTool({
    name: 'settings_variable_fields_list',
    description: 'Lista campos variables y sus carpetas.',
    module: 'settings_custom_fields',
    handler: variableFieldsController.listVariableFieldsHandler,
    inputSchema: schema({ includeArchived: { type: 'boolean' } }),
    query: args => ({ includeArchived: args.includeArchived ? 'true' : 'false' })
  }),
  mutationTool({
    name: 'settings_variable_field_create',
    description: 'Crea un campo variable administrable desde la plataforma.',
    module: 'settings_custom_fields',
    handler: variableFieldsController.createVariableFieldHandler,
    inputSchema: schema({ field: OBJECT }, ['field']),
    body: args => args.field
  }),
  mutationTool({
    name: 'settings_variable_field_update',
    description: 'Actualiza un campo variable existente.',
    module: 'settings_custom_fields',
    handler: variableFieldsController.updateVariableFieldHandler,
    method: 'PUT',
    inputSchema: schema({ variableFieldId: ID, changes: OBJECT }, ['variableFieldId', 'changes']),
    params: args => ({ variableFieldId: args.variableFieldId }),
    body: args => args.changes
  }),
  destructiveTool({
    name: 'settings_variable_field_delete',
    description: 'Elimina un campo variable según sus reglas de uso.',
    module: 'settings_custom_fields',
    handler: variableFieldsController.deleteVariableFieldHandler,
    method: 'DELETE',
    inputSchema: schema({ variableFieldId: ID }, ['variableFieldId']),
    params: args => ({ variableFieldId: args.variableFieldId })
  }),
  readTool({
    name: 'settings_variable_folders_list',
    description: 'Lista carpetas de campos variables.',
    module: 'settings_custom_fields',
    handler: variableFieldsController.listVariableFieldFoldersHandler
  }),
  mutationTool({
    name: 'settings_variable_folder_create',
    description: 'Crea una carpeta de campos variables.',
    module: 'settings_custom_fields',
    handler: variableFieldsController.createVariableFieldFolderHandler,
    inputSchema: schema({ folder: OBJECT }, ['folder']),
    body: args => args.folder
  }),
  mutationTool({
    name: 'settings_variable_folder_update',
    description: 'Actualiza una carpeta de campos variables.',
    module: 'settings_custom_fields',
    handler: variableFieldsController.updateVariableFieldFolderHandler,
    method: 'PUT',
    inputSchema: schema({ folderId: ID, changes: OBJECT }, ['folderId', 'changes']),
    params: args => ({ folderId: args.folderId }),
    body: args => args.changes
  }),
  destructiveTool({
    name: 'settings_variable_folder_delete',
    description: 'Elimina una carpeta de campos variables sin borrar silenciosamente los valores.',
    module: 'settings_custom_fields',
    handler: variableFieldsController.deleteVariableFieldFolderHandler,
    method: 'DELETE',
    inputSchema: schema({ folderId: ID }, ['folderId']),
    params: args => ({ folderId: args.folderId })
  }),
  readTool({
    name: 'settings_notifications_list',
    description: 'Lista notificaciones internas del usuario autenticado.',
    module: 'settings_account',
    handler: notificationsController.getNotificationsView,
    inputSchema: schema({ limit: { type: 'integer', minimum: 1, maximum: 200 }, unreadOnly: { type: 'boolean' } }),
    query: args => compactDefined({ limit: args.limit, unreadOnly: args.unreadOnly ? 'true' : undefined })
  }),
  mutationTool({
    name: 'settings_notifications_mark_read',
    description: 'Marca notificaciones internas seleccionadas como leídas.',
    module: 'settings_account',
    handler: notificationsController.markNotificationsReadView,
    inputSchema: schema({ notificationIds: ARRAY_OF_IDS }, ['notificationIds']),
    body: args => ({ notificationIds: args.notificationIds })
  }),
  mutationTool({
    name: 'settings_notifications_mark_all_read',
    description: 'Marca todas las notificaciones internas como leídas.',
    module: 'settings_account',
    handler: notificationsController.markAllNotificationsReadView
  }),
  readTool({
    name: 'settings_account_timezone',
    description: 'Obtiene la zona horaria efectiva de la cuenta y su fuente.',
    module: 'settings_account',
    handler: settingsController.getTimezone
  }),
  mutationTool({
    name: 'settings_account_timezone_update',
    description: 'Actualiza la zona horaria del negocio; todas las fechas del CRM se resolverán con esta fuente de verdad.',
    module: 'settings_account',
    handler: settingsController.setTimezone,
    inputSchema: schema({ timezone: { type: ['string', 'null'], maxLength: 100 } }, ['timezone']),
    body: args => ({ timezone: args.timezone })
  }),
  readTool({
    name: 'settings_account_locale',
    description: 'Obtiene país, moneda, prefijo telefónico y zona horaria efectivos de la cuenta.',
    module: 'settings_account',
    handler: configController.getConfig,
    query: () => ({ keys: 'account_country,account_currency,account_dial_code,account_timezone' })
  }),
  mutationTool({
    name: 'settings_account_locale_update',
    description: 'Actualiza país, moneda o prefijo de la cuenta. La moneda indicada se vuelve la fuente de verdad para importes futuros.',
    module: 'settings_account',
    handler: configController.saveConfig,
    inputSchema: {
      ...schema({
        country: { type: 'string', minLength: 2, maxLength: 2 },
        currency: { type: 'string', minLength: 3, maxLength: 3 },
        dialCode: { type: 'string', maxLength: 12 }
      }),
      anyOf: [{ required: ['country'] }, { required: ['currency'] }, { required: ['dialCode'] }]
    },
    body: args => ({ config: compactDefined({
      account_country: args.country?.toUpperCase(),
      account_currency: args.currency?.toUpperCase(),
      account_dial_code: args.dialCode
    }) })
  }),
  readTool({
    name: 'settings_contact_labels',
    description: 'Obtiene los nombres configurados para contactos, prospectos y clientes.',
    module: 'settings_account',
    handler: settingsController.getContactLabels
  }),
  mutationTool({
    name: 'settings_contact_labels_update',
    description: 'Actualiza las etiquetas visibles de contactos en toda la cuenta.',
    module: 'settings_account',
    handler: settingsController.setContactLabels,
    inputSchema: schema({ labels: OBJECT }, ['labels']),
    body: args => args.labels
  }),
  readTool({
    name: 'settings_profile_get',
    description: 'Obtiene el perfil del usuario autenticado.',
    module: 'settings_account',
    handler: authController.getMe
  }),
  mutationTool({
    name: 'settings_profile_update',
    description: 'Actualiza únicamente datos visibles del perfil propio; el esquema no admite contraseñas ni credenciales.',
    module: 'settings_account',
    handler: authController.updateProfile,
    method: 'PATCH',
    inputSchema: {
      ...schema({
        firstName: { type: 'string', maxLength: 80 },
        lastName: { type: 'string', maxLength: 80 },
        fullName: { type: 'string', maxLength: 160 },
        phone: { type: 'string', maxLength: 40 },
        businessName: { type: 'string', maxLength: 160 }
      }),
      anyOf: [
        { required: ['firstName'] },
        { required: ['lastName'] },
        { required: ['fullName'] },
        { required: ['phone'] },
        { required: ['businessName'] }
      ]
    },
    body: cleanControls
  }),
  readTool({
    name: 'settings_users_list',
    description: 'Lista usuarios y permisos internos. Sólo está disponible para administradores.',
    module: 'settings_users',
    adminOnly: true,
    handler: userAccessController.listUsers
  }),
  mutationTool({
    name: 'settings_user_update',
    description: 'Actualiza rol, estado, nombre o permisos de un usuario interno sin aceptar contraseñas. Sólo administradores.',
    module: 'settings_users',
    adminOnly: true,
    handler: userAccessController.updateUser,
    method: 'PATCH',
    inputSchema: {
      ...schema({
        userId: ID,
        firstName: { type: 'string', maxLength: 80 },
        lastName: { type: 'string', maxLength: 80 },
        email: { type: 'string', maxLength: 180 },
        phone: { type: 'string', maxLength: 40 },
        role: { type: 'string', enum: ['admin', 'employee'] },
        isActive: { type: 'boolean' },
        accessConfig: OBJECT
      }, ['userId']),
      anyOf: [
        { required: ['firstName'] },
        { required: ['lastName'] },
        { required: ['email'] },
        { required: ['phone'] },
        { required: ['role'] },
        { required: ['isActive'] },
        { required: ['accessConfig'] }
      ]
    },
    params: args => ({ userId: args.userId }),
    body: args => {
      const body = cleanControls(args)
      delete body.userId
      return body
    }
  }),
  destructiveTool({
    name: 'settings_user_delete',
    description: 'Elimina un usuario interno. Sólo administradores y con aprobación humana escrita.',
    module: 'settings_users',
    adminOnly: true,
    handler: userAccessController.deleteUser,
    method: 'DELETE',
    inputSchema: schema({ userId: ID }, ['userId']),
    params: args => ({ userId: args.userId })
  })
]

const chatbotTools = [
  readTool({
    name: 'chatbot_filter_options',
    description: 'Lista opciones disponibles para filtros del agente conversacional.',
    module: 'ai_agent',
    featureKeys: ['conversational_ai'],
    handler: conversationalAgentController.getFilterOptions
  }),
  readTool({
    name: 'chatbot_test_runs',
    description: 'Lista ejecuciones de prueba de un agente conversacional.',
    module: 'ai_agent',
    featureKeys: ['conversational_ai'],
    handler: conversationalAgentController.listAgentTestRuns,
    inputSchema: schema({ agentId: ID, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['agentId']),
    params: args => ({ agentId: args.agentId }),
    query: args => ({ limit: args.limit })
  }),
  readTool({
    name: 'chatbot_test_run_effects',
    description: 'Obtiene los efectos auditables de una prueba del agente.',
    module: 'ai_agent',
    featureKeys: ['conversational_ai'],
    handler: conversationalAgentController.getTestRunEffects,
    inputSchema: schema({ testRunId: ID }, ['testRunId']),
    params: args => ({ testRunId: args.testRunId })
  }),
  mutationTool({
    name: 'chatbot_reset_skipped_contacts',
    description: 'Rehabilita contactos omitidos por un agente para que puedan volver a evaluarse.',
    module: 'ai_agent',
    featureKeys: ['conversational_ai'],
    handler: conversationalAgentController.resetAgentSkippedContacts,
    inputSchema: schema({ agentId: ID, filters: OBJECT }, ['agentId']),
    params: args => ({ agentId: args.agentId }),
    body: args => args.filters || {}
  }),
  destructiveTool({
    name: 'chatbot_test_run_cleanup',
    description: 'Limpia una ejecución de prueba y sus efectos simulados.',
    module: 'ai_agent',
    featureKeys: ['conversational_ai'],
    handler: conversationalAgentController.cleanupTestRun,
    method: 'DELETE',
    inputSchema: schema({ testRunId: ID }, ['testRunId']),
    params: args => ({ testRunId: args.testRunId })
  })
]

const CONNECTION_HANDOFF_PATHS = Object.freeze({
  whatsapp: '/settings/whatsapp',
  email: '/settings/email',
  highlevel: '/settings/highlevel',
  payments: '/settings/payments',
  meta_social: '/settings/meta-ads/redes-sociales',
  bunny: '/settings/bunny',
  openai: '/ai-agent/conversational'
})

const integrationTools = [
  baseSpec({
    name: 'integrations_connection_handoff',
    title: 'Abrir conexión segura',
    description: 'Genera un enlace seguro para conectar una integración dentro de Ristak. Nunca solicita ni devuelve contraseñas, API keys o refresh tokens.',
    module: 'settings_integrations',
    access: 'read',
    scope: 'ristak.write',
    risk: 'low',
    readOnlyHint: false,
    openWorld: true,
    inputSchema: schema({
      provider: { type: 'string', enum: ['google_calendar', ...Object.keys(CONNECTION_HANDOFF_PATHS)] }
    }, ['provider']),
    async execute(context, args) {
      if (args.provider === 'google_calendar') {
        const response = await context.invoke(calendarsController.getGoogleCalendarConnectUrl, {
          method: 'POST',
          body: { returnPath: '/settings/calendars/google' }
        })
        return {
          success: true,
          data: {
            provider: args.provider,
            handoffUrl: response?.data?.url,
            kind: 'oauth',
            instruction: 'La persona debe abrir el enlace y completar Google OAuth. Las credenciales regresan cifradas directamente a Ristak.'
          }
        }
      }
      return {
        success: true,
        data: {
          provider: args.provider,
          handoffUrl: new URL(CONNECTION_HANDOFF_PATHS[args.provider], context.baseUrl).toString(),
          kind: 'ristak_settings',
          instruction: 'La persona debe completar la conexión dentro de Ristak. No pegues credenciales en el chat.'
        }
      }
    }
  }),
  baseSpec({
    name: 'integrations_disconnect',
    description: 'Desconecta una integración compatible usando su controlador canónico. WhatsApp y pagos se desconectan desde su handoff porque pueden tener varias rutas activas.',
    module: 'settings_integrations',
    access: 'write',
    scope: 'ristak.destructive',
    risk: 'critical',
    adminOnly: true,
    confirmRequired: true,
    idempotencyRequired: true,
    inputSchema: mutationSchema(schema({
      provider: { type: 'string', enum: ['google_calendar', 'email', 'highlevel', 'bunny'] }
    }, ['provider'])),
    async execute(context, args) {
      const handlers = {
        google_calendar: { handler: calendarsController.deleteGoogleCalendarIntegration, method: 'DELETE' },
        email: { handler: emailController.disconnectEmailView, method: 'POST' },
        highlevel: { handler: highlevelController.deleteConfig, method: 'DELETE' },
        bunny: { handler: bunnyController.disconnectBunnyAccountHandler, method: 'DELETE' }
      }
      const selected = handlers[args.provider]
      return context.invoke(selected.handler, {
        method: selected.method,
        body: {},
        headers: { 'idempotency-key': args.idempotencyKey }
      })
    }
  }),
  baseSpec({
    name: 'mcp_runtime_continuity',
    title: 'Consultar continuidad autónoma',
    description: 'Explica qué acciones quedan persistidas y continúan ejecutándose en Ristak aunque se cierre la conversación con la IA.',
    module: 'settings_api_access',
    access: 'read',
    scope: 'ristak.read',
    risk: 'low',
    inputSchema: schema(),
    async execute() {
      return {
        success: true,
        data: {
          durableMechanisms: [
            { capability: 'chat_schedule_message', continuesAs: 'job de mensajes programados' },
            { capability: 'automations_publish', continuesAs: 'motor de automatizaciones publicado' },
            { capability: 'automations_enroll_contact', continuesAs: 'inscripción persistente' },
            { capability: 'contacts_bulk_whatsapp_template', continuesAs: 'lote persistente con pausa y reanudación' },
            { capability: 'appointments_reminder_create', continuesAs: 'job de recordatorios en la zona del negocio' }
          ],
          boundary: 'El servidor MCP no mantiene vivo el chat ni puede despertar por sí solo a un cliente de IA cerrado. La continuidad ocurre dentro de jobs y automatizaciones de Ristak.'
        }
      }
    }
  })
]

export const capabilityToolSpecs = Object.freeze([
  ...contactTools,
  ...whatsAppTools,
  ...paymentTools,
  ...appointmentTools,
  ...automationTools,
  ...siteTools,
  ...mediaTools,
  ...trackingTools,
  ...settingsTools,
  ...chatbotTools,
  ...integrationTools
])
