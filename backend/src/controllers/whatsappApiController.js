import {
  connectWhatsAppQrForPhone,
  connectWhatsAppApi,
  disconnectWhatsAppQrForPhone,
  disconnectWhatsAppApi,
  getWhatsAppApiStatus,
  getWhatsAppApiTemplates,
  getWhatsAppApiWebhookPath,
  getWhatsAppQrForPhone,
  previewWhatsAppApiPhoneNumbers,
  processYCloudWhatsAppWebhook,
  refreshWhatsAppApi,
  resetWhatsAppApiCredentials,
  sendWhatsAppApiAudioMessage,
  sendWhatsAppApiDocumentMessage,
  sendWhatsAppApiImageMessage,
  sendWhatsAppApiTemplateMessage,
  sendWhatsAppApiTextMessage,
  setWhatsAppApiDefaultPhoneNumber,
  rerouteWhatsAppPhoneNumberContacts,
  restoreWhatsAppPhoneNumberContacts
} from '../services/whatsappApiService.js'
import {
  cancelScheduledChatMessage,
  createScheduledChatMessage,
  listScheduledChatMessages
} from '../services/scheduledChatMessagesService.js'
import { logger } from '../utils/logger.js'
import { markHumanTakeoverByPhone } from '../services/conversationalAgentService.js'

// Un envío manual desde la app significa que un humano tomó la conversación:
// el agente conversacional deja de responder en ese chat (fire-and-forget).
function notifyHumanTakeover(toPhone) {
  markHumanTakeoverByPhone(toPhone).catch(error => {
    logger.warn(`[Agente conversacional] No se pudo marcar toma humana: ${error.message}`)
  })
}

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function normalizeBaseUrl(value = '') {
  return cleanString(value).replace(/\/+$/, '')
}

function getPublicBaseUrl(req) {
  return normalizeBaseUrl(
    process.env.RENDER_EXTERNAL_URL ||
    process.env.PUBLIC_URL ||
    req.body?.baseUrl ||
    `${req.protocol}://${req.get('host')}`
  )
}

function getWebhookUrl(req) {
  return `${getPublicBaseUrl(req)}${getWhatsAppApiWebhookPath()}`
}

export async function getWhatsAppApiConnectionStatus(req, res) {
  try {
    const data = await getWhatsAppApiStatus()
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error obteniendo estado de WhatsApp_API: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo estado de WhatsApp_API'
    })
  }
}

export async function connectWhatsAppApiView(req, res) {
  try {
    const data = await connectWhatsAppApi({
      apiKey: req.body?.apiKey,
      senderPhone: req.body?.senderPhone,
      phoneNumberId: req.body?.phoneNumberId,
      wabaId: req.body?.wabaId,
      webhookUrl: getWebhookUrl(req)
    })

    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error conectando WhatsApp_API: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo conectar WhatsApp_API'
    })
  }
}

export async function refreshWhatsAppApiView(req, res) {
  try {
    const data = await refreshWhatsAppApi()
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error actualizando WhatsApp_API: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo actualizar WhatsApp_API'
    })
  }
}

export async function previewWhatsAppApiPhoneNumbersView(req, res) {
  try {
    const data = await previewWhatsAppApiPhoneNumbers({
      apiKey: req.body?.apiKey
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error leyendo numeros WhatsApp_API: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudieron leer los numeros de WhatsApp Business'
    })
  }
}

export async function setWhatsAppApiDefaultPhoneNumberView(req, res) {
  try {
    const data = await setWhatsAppApiDefaultPhoneNumber({
      phoneNumberId: req.body?.phoneNumberId
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error marcando numero principal WhatsApp_API: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo marcar el numero principal'
    })
  }
}

export async function rerouteWhatsAppPhoneNumberContactsView(req, res) {
  try {
    const data = await rerouteWhatsAppPhoneNumberContacts({
      phoneNumberId: req.params?.id,
      targetPhoneNumberId: req.body?.targetPhoneNumberId,
      reason: req.body?.reason
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error moviendo contactos de numero WhatsApp: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudieron mover los contactos a otro numero'
    })
  }
}

export async function restoreWhatsAppPhoneNumberContactsView(req, res) {
  try {
    const data = await restoreWhatsAppPhoneNumberContacts({
      phoneNumberId: req.params?.id
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error restaurando contactos de numero WhatsApp: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudieron regresar los contactos a su numero original'
    })
  }
}

export async function disconnectWhatsAppApiView(req, res) {
  try {
    const data = await disconnectWhatsAppApi()
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error desconectando WhatsApp_API: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'No se pudo desconectar WhatsApp_API'
    })
  }
}

export async function resetWhatsAppApiCredentialsView(req, res) {
  try {
    const data = await resetWhatsAppApiCredentials()
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error limpiando credenciales WhatsApp_API: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'No se pudieron limpiar las credenciales de WhatsApp_API'
    })
  }
}

export async function connectWhatsAppQrView(req, res) {
  try {
    const data = await connectWhatsAppQrForPhone({
      phoneNumberId: req.body?.phoneNumberId,
      acceptedRisk: req.body?.acceptedRisk,
      acceptedBy: req.user?.username || req.user?.email || 'usuario'
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error conectando WhatsApp QR: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo conectar el QR de WhatsApp'
    })
  }
}

export async function getWhatsAppQrView(req, res) {
  try {
    const data = await getWhatsAppQrForPhone({
      phoneNumberId: req.query?.phoneNumberId
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error leyendo WhatsApp QR: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo leer el QR de WhatsApp'
    })
  }
}

export async function disconnectWhatsAppQrView(req, res) {
  try {
    const data = await disconnectWhatsAppQrForPhone({
      phoneNumberId: req.body?.phoneNumberId
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error desconectando WhatsApp QR: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo desconectar el QR de WhatsApp'
    })
  }
}

export async function sendWhatsAppApiTextMessageView(req, res) {
  try {
    const data = await sendWhatsAppApiTextMessage({
      to: req.body?.to,
      from: req.body?.from,
      text: req.body?.text,
      externalId: req.body?.externalId,
      transport: req.body?.transport,
      phoneNumberId: req.body?.phoneNumberId
    })
    notifyHumanTakeover(req.body?.to)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error enviando WhatsApp_API: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo enviar el mensaje por WhatsApp_API'
    })
  }
}

export async function scheduleChatMessageView(req, res) {
  try {
    const data = await createScheduledChatMessage({
      id: req.body?.id,
      contactId: req.body?.contactId,
      provider: req.body?.provider,
      channel: req.body?.channel,
      transport: req.body?.transport,
      text: req.body?.text,
      toPhone: req.body?.toPhone,
      fromPhone: req.body?.fromPhone,
      businessPhoneNumberId: req.body?.businessPhoneNumberId,
      scheduledAt: req.body?.scheduledAt,
      externalId: req.body?.externalId
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error programando mensaje de chat: ${error.message}`)
    res.status(error.statusCode || 400).json({
      success: false,
      error: error.message || 'No se pudo programar el mensaje'
    })
  }
}

export async function cancelScheduledChatMessageView(req, res) {
  try {
    const data = await cancelScheduledChatMessage({
      id: req.params?.id,
      contactId: req.body?.contactId || req.query?.contactId
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error eliminando mensaje programado: ${error.message}`)
    res.status(error.statusCode || 400).json({
      success: false,
      error: error.message || 'No se pudo eliminar el mensaje programado'
    })
  }
}

export async function listScheduledChatMessagesView(req, res) {
  try {
    const data = await listScheduledChatMessages({
      contactId: req.query?.contactId
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error leyendo mensajes programados: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'No se pudieron leer los mensajes programados'
    })
  }
}

export async function sendWhatsAppApiImageMessageView(req, res) {
  try {
    const data = await sendWhatsAppApiImageMessage({
      to: req.body?.to,
      from: req.body?.from,
      imageDataUrl: req.body?.imageDataUrl,
      imageUrl: req.body?.imageUrl,
      caption: req.body?.caption,
      externalId: req.body?.externalId,
      transport: req.body?.transport,
      phoneNumberId: req.body?.phoneNumberId,
      publicBaseUrl: getPublicBaseUrl(req)
    })
    notifyHumanTakeover(req.body?.to)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error enviando foto WhatsApp_API: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo enviar la foto por WhatsApp_API'
    })
  }
}

export async function sendWhatsAppApiDocumentMessageView(req, res) {
  try {
    const data = await sendWhatsAppApiDocumentMessage({
      to: req.body?.to,
      from: req.body?.from,
      documentDataUrl: req.body?.documentDataUrl,
      documentUrl: req.body?.documentUrl,
      filename: req.body?.filename,
      mimeType: req.body?.mimeType,
      caption: req.body?.caption,
      externalId: req.body?.externalId,
      transport: req.body?.transport,
      phoneNumberId: req.body?.phoneNumberId,
      publicBaseUrl: getPublicBaseUrl(req)
    })
    notifyHumanTakeover(req.body?.to)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error enviando documento WhatsApp_API: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo enviar el documento por WhatsApp_API'
    })
  }
}

export async function sendWhatsAppApiAudioMessageView(req, res) {
  try {
    const data = await sendWhatsAppApiAudioMessage({
      to: req.body?.to,
      from: req.body?.from,
      audioDataUrl: req.body?.audioDataUrl,
      audioUrl: req.body?.audioUrl,
      externalId: req.body?.externalId,
      durationMs: req.body?.durationMs,
      voice: req.body?.voice,
      transport: req.body?.transport,
      phoneNumberId: req.body?.phoneNumberId,
      publicBaseUrl: getPublicBaseUrl(req)
    })
    notifyHumanTakeover(req.body?.to)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error enviando audio WhatsApp_API: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo enviar el audio por WhatsApp_API'
    })
  }
}

export async function getWhatsAppApiTemplatesView(req, res) {
  try {
    const data = await getWhatsAppApiTemplates({
      status: req.query?.status,
      limit: req.query?.limit
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error obteniendo plantillas WhatsApp_API: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'No se pudieron leer las plantillas de WhatsApp_API'
    })
  }
}

export async function sendWhatsAppApiTemplateMessageView(req, res) {
  try {
    const data = await sendWhatsAppApiTemplateMessage({
      to: req.body?.to,
      from: req.body?.from,
      templateId: req.body?.templateId,
      templateName: req.body?.templateName,
      language: req.body?.language,
      components: req.body?.components,
      variables: req.body?.variables,
      externalId: req.body?.externalId,
      phoneNumberId: req.body?.phoneNumberId
    })
    notifyHumanTakeover(req.body?.to)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error enviando plantilla WhatsApp_API: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo enviar la plantilla por WhatsApp_API'
    })
  }
}

export async function handleYCloudWhatsAppApiWebhook(req, res) {
  try {
    await processYCloudWhatsAppWebhook({
      payload: req.body || {},
      rawBody: req.rawBody || JSON.stringify(req.body || {}),
      signatureHeader: req.get('YCloud-Signature') || '',
      endpointId: req.get('X-Webhook-Endpoint-ID') || ''
    })

    res.status(200).json({ success: true })
  } catch (error) {
    logger.error(`Error procesando webhook WhatsApp_API YCloud: ${error.message}`)
    res.status(error.statusCode || 200).json({
      success: error.statusCode ? false : true,
      error: error.statusCode ? error.message : undefined
    })
  }
}
