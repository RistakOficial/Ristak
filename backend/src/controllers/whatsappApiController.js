import {
  connectWhatsAppApi,
  disconnectWhatsAppApi,
  getWhatsAppApiStatus,
  getWhatsAppApiWebhookPath,
  processYCloudWhatsAppWebhook,
  refreshWhatsAppApi,
  resetWhatsAppApiCredentials,
  sendWhatsAppApiTextMessage
} from '../services/whatsappApiService.js'
import { logger } from '../utils/logger.js'

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

export async function sendWhatsAppApiTextMessageView(req, res) {
  try {
    const data = await sendWhatsAppApiTextMessage({
      to: req.body?.to,
      from: req.body?.from,
      text: req.body?.text,
      externalId: req.body?.externalId
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error enviando WhatsApp_API: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo enviar el mensaje por WhatsApp_API'
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
