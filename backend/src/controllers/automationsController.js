import { logger } from '../utils/logger.js'
import {
  getAutomationsOverview,
  getAutomation,
  createAutomation,
  updateAutomation,
  duplicateAutomation,
  deleteAutomation,
  recordAutomationWebhookSample,
  testAutomationWebhookAction,
  createFolder,
  updateFolder,
  reorderFolders,
  deleteFolder,
  listEnrollments,
  listContactAutomationActivity,
  enrollContactInAutomation,
  getEnrollmentStats,
  listAttributionCampaigns,
  listAttributionAdsets,
  listAttributionAds,
  listAutomationFormsCatalog,
  listAutomationFormFieldsCatalog,
  listAutomationWhatsAppTemplatesCatalog,
  saveAutomationAsset,
  getAutomationAsset
} from '../services/automationsService.js'

function sendError(res, error, fallback = 'Error procesando la solicitud') {
  const status = error.status || 500
  res.status(status).json({
    success: false,
    error: error.message || fallback,
    ...(error.validationErrors ? { validationErrors: error.validationErrors } : {})
  })
}

export async function getAutomationsHandler(req, res) {
  try {
    res.json({ success: true, data: await getAutomationsOverview() })
  } catch (error) {
    logger.error(`Error listando automatizaciones: ${error.message}`)
    sendError(res, error, 'Error listando automatizaciones')
  }
}

export async function getAutomationHandler(req, res) {
  try {
    res.json({ success: true, data: await getAutomation(req.params.automationId) })
  } catch (error) {
    logger.error(`Error obteniendo automatización: ${error.message}`)
    sendError(res, error, 'Error obteniendo la automatización')
  }
}

export async function createAutomationHandler(req, res) {
  try {
    const automation = await createAutomation(req.body || {})
    res.status(201).json({ success: true, data: automation })
  } catch (error) {
    logger.error(`Error creando automatización: ${error.message}`)
    sendError(res, error, 'Error creando la automatización')
  }
}

export async function updateAutomationHandler(req, res) {
  try {
    const automation = await updateAutomation(req.params.automationId, req.body || {})
    res.json({ success: true, data: automation })
  } catch (error) {
    logger.error(`Error actualizando automatización: ${error.message}`)
    sendError(res, error, 'Error actualizando la automatización')
  }
}

export async function duplicateAutomationHandler(req, res) {
  try {
    const automation = await duplicateAutomation(req.params.automationId)
    res.status(201).json({ success: true, data: automation })
  } catch (error) {
    logger.error(`Error duplicando automatización: ${error.message}`)
    sendError(res, error, 'Error duplicando la automatización')
  }
}

export async function deleteAutomationHandler(req, res) {
  try {
    res.json({ success: true, data: await deleteAutomation(req.params.automationId) })
  } catch (error) {
    logger.error(`Error eliminando automatización: ${error.message}`)
    sendError(res, error, 'Error eliminando la automatización')
  }
}

export async function createFolderHandler(req, res) {
  try {
    const folder = await createFolder(req.body || {})
    res.status(201).json({ success: true, data: folder })
  } catch (error) {
    logger.error(`Error creando carpeta de automatizaciones: ${error.message}`)
    sendError(res, error, 'Error creando la carpeta')
  }
}

export async function updateFolderHandler(req, res) {
  try {
    const folder = await updateFolder(req.params.folderId, req.body || {})
    res.json({ success: true, data: folder })
  } catch (error) {
    logger.error(`Error actualizando carpeta de automatizaciones: ${error.message}`)
    sendError(res, error, 'Error actualizando la carpeta')
  }
}

export async function reorderFoldersHandler(req, res) {
  try {
    const folders = await reorderFolders(req.body?.orderedIds || [])
    res.json({ success: true, data: folders })
  } catch (error) {
    logger.error(`Error reordenando carpetas de automatizaciones: ${error.message}`)
    sendError(res, error, 'Error reordenando las carpetas')
  }
}

export async function deleteFolderHandler(req, res) {
  try {
    res.json({ success: true, data: await deleteFolder(req.params.folderId) })
  } catch (error) {
    logger.error(`Error eliminando carpeta de automatizaciones: ${error.message}`)
    sendError(res, error, 'Error eliminando la carpeta')
  }
}


export async function getCampaignsCatalogHandler(req, res) {
  try {
    res.json({ success: true, data: await listAttributionCampaigns() })
  } catch (error) {
    logger.error(`Error listando campañas de atribución: ${error.message}`)
    sendError(res, error, 'Error listando las campañas')
  }
}

export async function getAdsetsCatalogHandler(req, res) {
  try {
    res.json({ success: true, data: await listAttributionAdsets() })
  } catch (error) {
    logger.error(`Error listando conjuntos de atribución: ${error.message}`)
    sendError(res, error, 'Error listando los conjuntos')
  }
}

export async function getAdsCatalogHandler(req, res) {
  try {
    res.json({ success: true, data: await listAttributionAds() })
  } catch (error) {
    logger.error(`Error listando anuncios de atribución: ${error.message}`)
    sendError(res, error, 'Error listando los anuncios')
  }
}

export async function getFormsCatalogHandler(req, res) {
  try {
    res.json({ success: true, data: await listAutomationFormsCatalog() })
  } catch (error) {
    logger.error(`Error listando formularios de automatización: ${error.message}`)
    sendError(res, error, 'Error listando los formularios')
  }
}

export async function getFormFieldsCatalogHandler(req, res) {
  try {
    res.json({ success: true, data: await listAutomationFormFieldsCatalog(req.query?.formId) })
  } catch (error) {
    logger.error(`Error listando preguntas de formulario: ${error.message}`)
    sendError(res, error, 'Error listando las preguntas del formulario')
  }
}

export async function getWhatsAppTemplatesCatalogHandler(req, res) {
  try {
    const data = await listAutomationWhatsAppTemplatesCatalog({
      status: req.query?.status || 'APPROVED',
      limit: req.query?.limit
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error listando plantillas de WhatsApp para automatizaciones: ${error.message}`)
    sendError(res, error, 'Error listando las plantillas de WhatsApp')
  }
}

export async function getEnrollmentsHandler(req, res) {
  try {
    res.json({ success: true, data: await listEnrollments(req.params.automationId) })
  } catch (error) {
    logger.error(`Error listando inscripciones: ${error.message}`)
    sendError(res, error, 'Error listando inscripciones')
  }
}

export async function getContactAutomationActivityHandler(req, res) {
  try {
    res.json({ success: true, data: await listContactAutomationActivity(req.params.contactId) })
  } catch (error) {
    logger.error(`Error listando automatizaciones del contacto: ${error.message}`)
    sendError(res, error, 'Error listando automatizaciones del contacto')
  }
}

export async function enrollContactInAutomationHandler(req, res) {
  try {
    const result = await enrollContactInAutomation(req.params.automationId, {
      ...(req.body || {}),
      userId: req.user?.userId || req.user?.id || null
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error agregando contacto a automatización: ${error.message}`)
    sendError(res, error, 'Error agregando contacto a automatización')
  }
}

export async function getEnrollmentStatsHandler(req, res) {
  try {
    res.json({ success: true, data: await getEnrollmentStats(req.params.automationId) })
  } catch (error) {
    logger.error(`Error obteniendo estadísticas: ${error.message}`)
    sendError(res, error, 'Error obteniendo estadísticas')
  }
}


export async function uploadAssetHandler(req, res) {
  try {
    const asset = await saveAutomationAsset({
      ...(req.body || {}),
      userId: req.user?.userId || req.user?.id || null
    })
    res.status(201).json({ success: true, data: asset })
  } catch (error) {
    logger.error(`Error subiendo archivo de automatización: ${error.message}`)
    sendError(res, error, 'Error subiendo el archivo')
  }
}

export async function serveAssetHandler(req, res) {
  try {
    const asset = await getAutomationAsset(req.params.assetId)
    const buffer = Buffer.from(asset.content_base64, 'base64')
    res.setHeader('Content-Type', asset.content_type)
    res.setHeader('Content-Length', buffer.length)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')

    // (AUTO-009 / SEC-010) Este endpoint es público (los archivos se incrustan en
    // WhatsApp/Meta sin sesión), así que un asset malicioso (SVG/HTML/XML/JS con
    // <script>) servido inline sería XSS almacenado en el origen del CRM. Mismo
    // endurecimiento que media: nosniff + inline SOLO para tipos seguros (imágenes
    // raster, video, audio, pdf); el resto se fuerza a descarga (attachment) para
    // que el navegador no ejecute scripts. Las imágenes embebidas legítimas (png,
    // jpg, gif, webp...) siguen viéndose inline, así que no rompe los mensajes.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const contentTypeLower = String(asset.content_type || '').toLowerCase()
    const inlineSafe = /^(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/|audio\/|application\/pdf)\b/.test(contentTypeLower)
    const disposition = inlineSafe ? 'inline' : 'attachment'
    if (asset.filename) {
      res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(asset.filename)}"`)
    } else if (!inlineSafe) {
      res.setHeader('Content-Disposition', 'attachment')
    }
    res.end(buffer)
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message })
  }
}

export async function automationWebhookSampleHandler(req, res) {
  try {
    const data = await recordAutomationWebhookSample({
      endpointId: req.params.endpointId,
      method: req.method,
      body: req.body,
      query: req.query
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error capturando muestra de webhook de automatización: ${error.message}`)
    sendError(res, error, 'Error capturando la muestra del webhook')
  }
}

export async function testWebhookActionHandler(req, res) {
  try {
    const data = await testAutomationWebhookAction(req.body || {})
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error probando webhook de automatización: ${error.message}`)
    sendError(res, error, 'Error probando el webhook')
  }
}
