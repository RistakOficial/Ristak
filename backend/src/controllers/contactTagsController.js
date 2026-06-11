import {
  listContactTags,
  createContactTag,
  renameContactTag,
  deleteContactTag,
  getContactTagUsage
} from '../services/contactTagsService.js'
import { logger } from '../utils/logger.js'

/** GET /api/contact-tags — catálogo completo (internas + del usuario) */
export const getContactTags = async (req, res) => {
  try {
    const tags = await listContactTags()
    const includeUsage = String(req.query.includeUsage || '') === 'true'
    if (includeUsage) {
      const usage = await getContactTagUsage()
      return res.json({
        success: true,
        data: tags.map((tag) => ({ ...tag, usageCount: usage[tag.id] || 0 }))
      })
    }
    res.json({ success: true, data: tags })
  } catch (error) {
    logger.error(`Error listando etiquetas de contactos: ${error.message}`)
    res.status(500).json({ success: false, error: 'No se pudieron cargar las etiquetas' })
  }
}

/** POST /api/contact-tags — crea (o devuelve la existente con ese nombre) */
export const createContactTagHandler = async (req, res) => {
  try {
    const tag = await createContactTag(req.body?.name)
    res.status(201).json({ success: true, data: tag })
  } catch (error) {
    logger.error(`Error creando etiqueta de contacto: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'No se pudo crear la etiqueta'
    })
  }
}

/** PUT /api/contact-tags/:id — renombra sin cambiar el ID */
export const updateContactTagHandler = async (req, res) => {
  try {
    const tag = await renameContactTag(req.params.id, req.body?.name)
    res.json({ success: true, data: tag })
  } catch (error) {
    logger.error(`Error renombrando etiqueta ${req.params.id}: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'No se pudo actualizar la etiqueta'
    })
  }
}

/** DELETE /api/contact-tags/:id — borra del catálogo y de todos los contactos */
export const deleteContactTagHandler = async (req, res) => {
  try {
    const deleted = await deleteContactTag(req.params.id)
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Etiqueta no encontrada' })
    }
    res.json({ success: true })
  } catch (error) {
    logger.error(`Error eliminando etiqueta ${req.params.id}: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'No se pudo eliminar la etiqueta'
    })
  }
}
