import {
  connectWhatsAppCloudApi,
  disconnectWhatsAppCloudApi,
  getWhatsAppConfig,
  getWhatsAppStorageSummary,
  logWhatsAppServiceError,
  refreshWhatsAppConnectionStatus,
  saveWhatsAppConfig
} from '../services/whatsappApiService.js'

export const getConfig = async (req, res) => {
  try {
    const [config, storage] = await Promise.all([
      getWhatsAppConfig(),
      getWhatsAppStorageSummary()
    ])

    res.json({ success: true, data: { config, storage } })
  } catch (error) {
    logWhatsAppServiceError('getConfig', error)
    res.status(500).json({ success: false, error: error.message })
  }
}

export const saveConfig = async (req, res) => {
  try {
    const config = await saveWhatsAppConfig(req.body || {})
    res.json({ success: true, data: config })
  } catch (error) {
    logWhatsAppServiceError('saveConfig', error)
    res.status(400).json({ success: false, error: error.message })
  }
}

export const connectCloudApi = async (req, res) => {
  try {
    const config = await connectWhatsAppCloudApi(req.body || {})
    const storage = await getWhatsAppStorageSummary()

    res.json({ success: true, data: { config, storage } })
  } catch (error) {
    logWhatsAppServiceError('connectCloudApi', error)
    res.status(400).json({
      success: false,
      error: error.message,
      meta: error.meta || undefined
    })
  }
}

export const refreshStatus = async (req, res) => {
  try {
    const config = await refreshWhatsAppConnectionStatus()
    const storage = await getWhatsAppStorageSummary()
    res.json({ success: true, data: { config, storage } })
  } catch (error) {
    logWhatsAppServiceError('refreshStatus', error)
    res.status(400).json({
      success: false,
      error: error.message,
      meta: error.meta || undefined
    })
  }
}

export const disconnectCloudApi = async (req, res) => {
  try {
    const config = await disconnectWhatsAppCloudApi()
    const storage = await getWhatsAppStorageSummary()

    res.json({ success: true, data: { config, storage } })
  } catch (error) {
    logWhatsAppServiceError('disconnectCloudApi', error)
    res.status(400).json({
      success: false,
      error: error.message,
      meta: error.meta || undefined
    })
  }
}
