import { logger } from '../utils/logger.js'
import {
  archiveVariableFieldFolder,
  archiveVariableField,
  createVariableFieldFolder,
  createVariableField,
  getVariableFieldById,
  isVariableFieldUsedInSiteHeader,
  listVariableFieldFolders,
  listVariableFields,
  updateVariableFieldFolder,
  updateVariableField
} from '../services/variableFieldsService.js'
import { hasUserAccess } from '../utils/userAccess.js'

const getRequestUserId = (req) => req.user?.userId || req.user?.id || null

function sendVariableFieldError(res, error, fallback = 'Error al guardar campo variable') {
  res.status(error.status || error.statusCode || 500).json({
    success: false,
    error: error.message || fallback
  })
}

async function assertCanChangeSiteHeaderVariable(req, variableFieldId) {
  if (!(await isVariableFieldUsedInSiteHeader(variableFieldId))) return
  if (hasUserAccess(req.user, 'sites', 'write')) return

  const error = new Error('Este campo controla código de tracking en Sites. Necesitas permiso para editar Sites antes de cambiar su valor o archivarlo.')
  error.status = 403
  throw error
}

async function assertCanUpdateVariableValue(req, variableFieldId, input = {}) {
  const hasValue = input.value !== undefined || input.valueText !== undefined || input.value_text !== undefined
  if (!hasValue) return
  const existing = await getVariableFieldById(variableFieldId)
  const nextValue = String(input.value ?? input.valueText ?? input.value_text ?? '').trim()
  if (existing && nextValue === existing.value) return
  await assertCanChangeSiteHeaderVariable(req, variableFieldId)
}

export const listVariableFieldsHandler = async (req, res) => {
  try {
    const includeArchived = String(req.query?.includeArchived || '').toLowerCase() === 'true'
    const fields = await listVariableFields({ includeArchived })
    res.json({ success: true, data: fields })
  } catch (error) {
    logger.error(`Error en listVariableFieldsHandler: ${error.message}`)
    sendVariableFieldError(res, error, 'Error al obtener campos variables')
  }
}

export const listVariableFieldFoldersHandler = async (req, res) => {
  try {
    const includeArchived = String(req.query?.includeArchived || '').toLowerCase() === 'true'
    const folders = await listVariableFieldFolders({ includeArchived })
    res.json({ success: true, data: folders })
  } catch (error) {
    logger.error(`Error en listVariableFieldFoldersHandler: ${error.message}`)
    sendVariableFieldError(res, error, 'Error al obtener carpetas de campos variables')
  }
}

export const createVariableFieldFolderHandler = async (req, res) => {
  try {
    const folder = await createVariableFieldFolder(req.body || {})
    res.status(201).json({ success: true, data: folder })
  } catch (error) {
    logger.error(`Error en createVariableFieldFolderHandler: ${error.message}`)
    sendVariableFieldError(res, error, 'Error al crear carpeta de campos variables')
  }
}

export const updateVariableFieldFolderHandler = async (req, res) => {
  try {
    const folder = await updateVariableFieldFolder(req.params.folderId, req.body || {})
    if (!folder) {
      return res.status(404).json({ success: false, error: 'Carpeta no encontrada' })
    }
    res.json({ success: true, data: folder })
  } catch (error) {
    logger.error(`Error en updateVariableFieldFolderHandler: ${error.message}`)
    sendVariableFieldError(res, error, 'Error al actualizar carpeta de campos variables')
  }
}

export const deleteVariableFieldFolderHandler = async (req, res) => {
  try {
    const folder = await archiveVariableFieldFolder(req.params.folderId)
    if (!folder) {
      return res.status(404).json({ success: false, error: 'Carpeta no encontrada' })
    }
    res.json({ success: true, data: folder })
  } catch (error) {
    logger.error(`Error en deleteVariableFieldFolderHandler: ${error.message}`)
    sendVariableFieldError(res, error, 'Error al eliminar carpeta de campos variables')
  }
}

export const createVariableFieldHandler = async (req, res) => {
  try {
    const field = await createVariableField(req.body || {}, { userId: getRequestUserId(req) })
    res.status(201).json({ success: true, data: field })
  } catch (error) {
    logger.error(`Error en createVariableFieldHandler: ${error.message}`)
    sendVariableFieldError(res, error, 'Error al crear campo variable')
  }
}

export const updateVariableFieldHandler = async (req, res) => {
  try {
    await assertCanUpdateVariableValue(req, req.params.variableFieldId, req.body || {})
    const field = await updateVariableField(req.params.variableFieldId, req.body || {})
    res.json({ success: true, data: field })
  } catch (error) {
    logger.error(`Error en updateVariableFieldHandler: ${error.message}`)
    sendVariableFieldError(res, error, 'Error al actualizar campo variable')
  }
}

export const deleteVariableFieldHandler = async (req, res) => {
  try {
    await assertCanChangeSiteHeaderVariable(req, req.params.variableFieldId)
    const field = await archiveVariableField(req.params.variableFieldId)
    res.json({ success: true, data: field })
  } catch (error) {
    logger.error(`Error en deleteVariableFieldHandler: ${error.message}`)
    sendVariableFieldError(res, error, 'Error al eliminar campo variable')
  }
}
