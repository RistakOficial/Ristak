import { logger } from '../utils/logger.js'
import {
  archiveVariableField,
  createVariableField,
  listVariableFields,
  updateVariableField
} from '../services/variableFieldsService.js'

const getRequestUserId = (req) => req.user?.userId || req.user?.id || null

function sendVariableFieldError(res, error, fallback = 'Error al guardar campo variable') {
  res.status(error.status || error.statusCode || 500).json({
    success: false,
    error: error.message || fallback
  })
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
    const field = await updateVariableField(req.params.variableFieldId, req.body || {})
    res.json({ success: true, data: field })
  } catch (error) {
    logger.error(`Error en updateVariableFieldHandler: ${error.message}`)
    sendVariableFieldError(res, error, 'Error al actualizar campo variable')
  }
}

export const deleteVariableFieldHandler = async (req, res) => {
  try {
    const field = await archiveVariableField(req.params.variableFieldId)
    res.json({ success: true, data: field })
  } catch (error) {
    logger.error(`Error en deleteVariableFieldHandler: ${error.message}`)
    sendVariableFieldError(res, error, 'Error al eliminar campo variable')
  }
}
