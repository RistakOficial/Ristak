import {
  connectEmail,
  disconnectEmail,
  getEmailStatus,
  sendTestEmail
} from '../services/emailService.js'
import { logger } from '../utils/logger.js'

function sendError(res, error, fallback) {
  res.status(error.status || 500).json({
    success: false,
    error: error.status ? error.message : fallback
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

export async function sendTestEmailView(req, res) {
  try {
    const data = await sendTestEmail(req.body?.to)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error enviando correo de prueba: ${error.message}`)
    sendError(res, error, 'Error enviando el correo de prueba')
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
