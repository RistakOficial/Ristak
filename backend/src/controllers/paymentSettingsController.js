import { getPaymentSettings, savePaymentSettings } from '../services/paymentSettingsService.js'
import { logger } from '../utils/logger.js'

function sendPaymentSettingsError(res, error, fallback = 'No se pudo guardar la configuración de pagos') {
  res.status(error.status || 500).json({
    success: false,
    error: error.message || fallback
  })
}

export async function getPaymentSettingsView(_req, res) {
  try {
    const settings = await getPaymentSettings()
    res.json({ success: true, data: settings })
  } catch (error) {
    logger.error(`Error obteniendo configuración de pagos: ${error.message}`)
    sendPaymentSettingsError(res, error, 'No se pudo obtener la configuración de pagos')
  }
}

export async function savePaymentSettingsView(req, res) {
  try {
    const settings = await savePaymentSettings(req.body || {})
    res.json({ success: true, data: settings })
  } catch (error) {
    logger.error(`Error guardando configuración de pagos: ${error.message}`)
    sendPaymentSettingsError(res, error)
  }
}
