import { logger } from '../utils/logger.js'
import {
  createMessageTemplate,
  createTemplateCustomField,
  createTemplateFolder,
  deleteMessageTemplate,
  deleteTemplateCustomField,
  deleteTemplateFolder,
  getMessageTemplateBundle,
  getVariableCatalog,
  previewMessageTemplate,
  repairDefaultMessageTemplatesForCurrentConnection,
  sendMessageTemplateTest,
  submitMessageTemplateToActiveProvider,
  syncAllMessageTemplatesWithActiveProvider,
  syncMessageTemplateStatus,
  updateMessageTemplate,
  updateTemplateFolder
} from '../services/messageTemplatesService.js'

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function getPublicBaseUrl(req) {
  const forwardedHost = cleanString(req.headers?.['x-forwarded-host']).split(',')[0].trim()
  const host = forwardedHost || req.headers?.host || req.get?.('host')
  const forwardedProto = cleanString(req.headers?.['x-forwarded-proto']).split(',')[0].trim()
  const protocol = forwardedProto || req.protocol || 'https'
  const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || (host ? `${protocol}://${host}` : '')
  return cleanString(baseUrl).replace(/\/+$/, '')
}

function sendError(res, error, fallback = 'No se pudo completar la operación') {
  const statusCode = error.statusCode || 400
  res.status(statusCode).json({
    success: false,
    error: error.message || fallback
  })
}

export async function getMessageTemplatesView(req, res) {
  try {
    await repairDefaultMessageTemplatesForCurrentConnection({ publicBaseUrl: getPublicBaseUrl(req) }).catch(error => {
      logger.warn(`No se pudo reparar plantillas default de WhatsApp antes de listar: ${error.message}`)
    })
    const data = await getMessageTemplateBundle()
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error leyendo plantillas de WhatsApp: ${error.message}`)
    sendError(res, error, 'No se pudieron leer las plantillas')
  }
}

export async function getMessageTemplateVariablesView(req, res) {
  try {
    const data = await getVariableCatalog()
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error leyendo variables de plantillas: ${error.message}`)
    sendError(res, error, 'No se pudieron leer las variables')
  }
}

export async function previewMessageTemplateView(req, res) {
  try {
    const data = await previewMessageTemplate(req.body || {})
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error generando preview de plantilla: ${error.message}`)
    sendError(res, error, 'No se pudo generar la vista previa')
  }
}

export async function createMessageTemplateView(req, res) {
  try {
    const data = await createMessageTemplate(req.body || {})
    res.status(201).json({ success: true, data })
  } catch (error) {
    logger.error(`Error creando plantilla de WhatsApp: ${error.message}`)
    sendError(res, error, 'No se pudo crear la plantilla')
  }
}

export async function updateMessageTemplateView(req, res) {
  try {
    const data = await updateMessageTemplate(req.params.id, req.body || {})
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error actualizando plantilla de WhatsApp: ${error.message}`)
    sendError(res, error, 'No se pudo actualizar la plantilla')
  }
}

export async function submitMessageTemplateToActiveProviderView(req, res) {
  try {
    const data = await submitMessageTemplateToActiveProvider(req.params.id)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error enviando plantilla al proveedor oficial activo: ${error.message}`)
    sendError(res, error, 'No se pudo enviar la plantilla a revisión')
  }
}

export async function syncMessageTemplateStatusView(req, res) {
  try {
    const data = await syncMessageTemplateStatus(req.params.id)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error sincronizando plantilla con su proveedor oficial: ${error.message}`)
    sendError(res, error, 'No se pudo sincronizar la plantilla')
  }
}

export async function syncAllMessageTemplatesWithActiveProviderView(req, res) {
  try {
    const data = await syncAllMessageTemplatesWithActiveProvider()
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error sincronizando plantillas con el proveedor oficial activo: ${error.message}`)
    sendError(res, error, 'No se pudieron sincronizar las plantillas')
  }
}

export async function sendMessageTemplateTestView(req, res) {
  try {
    const data = await sendMessageTemplateTest(req.params.id, req.body || {})
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error enviando prueba de plantilla: ${error.message}`)
    sendError(res, error, 'No se pudo enviar la plantilla')
  }
}

export async function deleteMessageTemplateView(req, res) {
  try {
    const data = await deleteMessageTemplate(req.params.id)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error eliminando plantilla de WhatsApp: ${error.message}`)
    sendError(res, error, 'No se pudo eliminar la plantilla')
  }
}

export async function createTemplateFolderView(req, res) {
  try {
    const data = await createTemplateFolder(req.body || {})
    res.status(201).json({ success: true, data })
  } catch (error) {
    logger.error(`Error creando carpeta de plantillas: ${error.message}`)
    sendError(res, error, 'No se pudo crear la carpeta')
  }
}

export async function updateTemplateFolderView(req, res) {
  try {
    const data = await updateTemplateFolder(req.params.id, req.body || {})
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error actualizando carpeta de plantillas: ${error.message}`)
    sendError(res, error, 'No se pudo actualizar la carpeta')
  }
}

export async function deleteTemplateFolderView(req, res) {
  try {
    const data = await deleteTemplateFolder(req.params.id)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error eliminando carpeta de plantillas: ${error.message}`)
    sendError(res, error, 'No se pudo eliminar la carpeta')
  }
}

export async function createTemplateCustomFieldView(req, res) {
  try {
    const data = await createTemplateCustomField(req.body || {})
    res.status(201).json({ success: true, data })
  } catch (error) {
    logger.error(`Error creando variable personalizada: ${error.message}`)
    sendError(res, error, 'No se pudo crear la variable personalizada')
  }
}

export async function deleteTemplateCustomFieldView(req, res) {
  try {
    const data = await deleteTemplateCustomField(req.params.id)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error eliminando variable personalizada: ${error.message}`)
    sendError(res, error, 'No se pudo eliminar la variable personalizada')
  }
}
