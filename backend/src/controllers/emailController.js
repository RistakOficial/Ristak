import {
  connectEmail,
  detectEmailProvider,
  disconnectEmail,
  getEmailSignature,
  getEmailStatus,
  saveEmailSignature,
  sendEmailToContact,
  sendTestEmail
} from '../services/emailService.js'
import { logger } from '../utils/logger.js'

function sendError(res, error, fallback) {
  const status = error.status || error.statusCode || 500
  res.status(status).json({
    success: false,
    error: status < 500 ? error.message : fallback,
    ...(error.code ? { code: error.code } : {}),
    ...(error.needsReconnect ? { needsReconnect: true } : {})
  })
}

export async function getEmailStatusView(req, res) {
  try {
    const data = await getEmailStatus()
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error obteniendo estado del correo: ${error.message}`)
    sendError(res, error, 'Error obteniendo el estado del correo')
  }
}

export async function connectEmailView(req, res) {
  try {
    const data = await connectEmail(req.body || {})
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error conectando correo: ${error.message}`)
    sendError(res, error, 'Error conectando el correo')
  }
}

export async function detectEmailProviderView(req, res) {
  try {
    const data = await detectEmailProvider(req.body || {})
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error detectando proveedor de correo: ${error.message}`)
    sendError(res, error, 'Error detectando el proveedor de correo')
  }
}

export async function sendTestEmailView(req, res) {
  try {
    const data = await sendTestEmail(req.body?.to)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error enviando correo de prueba: ${error.message}`)
    sendError(res, error, 'Error enviando el correo de prueba')
  }
}

export async function sendEmailView(req, res) {
  try {
    const data = await sendEmailToContact(req.body || {})
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error enviando correo: ${error.message}`)
    sendError(res, error, 'Error enviando el correo')
  }
}

export async function getEmailSignatureView(req, res) {
  try {
    const data = await getEmailSignature()
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error obteniendo firma de correo: ${error.message}`)
    sendError(res, error, 'Error obteniendo la firma de correo')
  }
}

export async function saveEmailSignatureView(req, res) {
  try {
    const data = await saveEmailSignature(req.body || {})
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error guardando firma de correo: ${error.message}`)
    sendError(res, error, 'Error guardando la firma de correo')
  }
}

export async function disconnectEmailView(req, res) {
  try {
    const data = await disconnectEmail()
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error desconectando correo: ${error.message}`)
    sendError(res, error, 'Error desconectando el correo')
  }
}
