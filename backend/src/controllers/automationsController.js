import { logger } from '../utils/logger.js'
import {
  getAutomationsOverview,
  getAutomation,
  createAutomation,
  updateAutomation,
  duplicateAutomation,
  deleteAutomation,
  createFolder,
  updateFolder,
  reorderFolders,
  deleteFolder
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
