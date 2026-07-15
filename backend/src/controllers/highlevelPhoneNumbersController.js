import { logger } from '../utils/logger.js'
import {
  getHighLevelPhoneNumbers,
  isHighLevelPhoneInventoryUnavailable
} from '../services/highlevelPhoneNumbersService.js'

export async function listHighLevelPhoneNumbers(req, res) {
  try {
    const phoneNumbers = await getHighLevelPhoneNumbers({
      forceRefresh: String(req.query?.refresh || '').trim().toLowerCase() === 'true'
    })
    return res.json({
      success: true,
      source: 'lc_phone',
      channels: ['sms'],
      phoneNumbers,
      selectable: phoneNumbers.length > 0,
      fallbackToAccountDefault: phoneNumbers.length === 0,
      reason: phoneNumbers.length === 0 ? 'no_sms_numbers_found' : null
    })
  } catch (error) {
    if (isHighLevelPhoneInventoryUnavailable(error)) {
      logger.warn(`[HighLevel Phone Numbers] Catálogo no disponible para esta conexión: ${error.code || error.status || 'provider_rejected'}`)
      return res.json({
        success: true,
        source: 'lc_phone',
        channels: ['sms'],
        phoneNumbers: [],
        selectable: false,
        fallbackToAccountDefault: true,
        reason: 'phone_number_scope_unavailable'
      })
    }

    logger.error(`[HighLevel Phone Numbers] No se pudo leer el catálogo: ${error.message}`)
    return res.status(502).json({
      success: false,
      source: 'lc_phone',
      channels: ['sms'],
      phoneNumbers: [],
      selectable: false,
      fallbackToAccountDefault: true,
      reason: 'phone_number_catalog_failed',
      error: 'No se pudieron consultar los números SMS de HighLevel.'
    })
  }
}
