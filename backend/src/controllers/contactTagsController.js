import {
  listContactTags,
  listSystemContactTags,
  createContactTag,
  updateContactTag,
  deleteContactTag,
  getContactTagUsage,
  listContactTagFolders,
  createContactTagFolder,
  deleteContactTagFolder
} from '../services/contactTagsService.js'
import { logger } from '../utils/logger.js'

/** GET /api/contact-tags — etiquetas editables del usuario; internas sólo con includeSystem=true */
export const getContactTags = async (req, res) => {
  try {
    const includeSystem = String(req.query.includeSystem || '') === 'true'
    const tags = await listContactTags({ includeSystem })
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

/** GET /api/contact-tags/system — estados internos calculados por el sistema */
export const getSystemContactTags = async (_req, res) => {
  res.json({ success: true, data: listSystemContactTags() })
}

/** GET /api/contact-tags/catalog — etiquetas (con uso) + carpetas en una llamada */
export const getContactTagsCatalog = async (req, res) => {
  try {
    const includeSystem = String(req.query.includeSystem || '') === 'true'
    const [tags, folders, usage] = await Promise.all([
      listContactTags({ includeSystem }),
      listContactTagFolders(),
      getContactTagUsage()
    ])
    res.json({
      success: true,
      data: {
        tags: tags.map((tag) => ({ ...tag, usageCount: usage[tag.id] || 0 })),
        folders
      }
    })
  } catch (error) {
    logger.error(`Error cargando catálogo de etiquetas: ${error.message}`)
    res.status(500).json({ success: false, error: 'No se pudo cargar el catálogo de etiquetas' })
  }
}

/** POST /api/contact-tags — crea (o devuelve la existente con ese nombre) */
export const createContactTagHandler = async (req, res) => {
  try {
    const tag = await createContactTag(req.body?.name, { folderId: req.body?.folderId })
    res.status(201).json({ success: true, data: tag })
  } catch (error) {
    logger.error(`Error creando etiqueta de contacto: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'No se pudo crear la etiqueta'
    })
  }
}

/** PUT /api/contact-tags/:id — renombra y/o mueve de carpeta sin cambiar el ID */
export const updateContactTagHandler = async (req, res) => {
  try {
    const patch = {}
    if (req.body?.name !== undefined) patch.name = req.body.name
    if (req.body?.folderId !== undefined) patch.folderId = req.body.folderId
    const tag = await updateContactTag(req.params.id, patch)
    res.json({ success: true, data: tag })
  } catch (error) {
    logger.error(`Error actualizando etiqueta ${req.params.id}: ${error.message}`)
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

/** POST /api/contact-tags/folders — crea una carpeta de etiquetas */
export const createContactTagFolderHandler = async (req, res) => {
  try {
    const folder = await createContactTagFolder({
      name: req.body?.name,
      description: req.body?.description
    })
    res.status(201).json({ success: true, data: folder })
  } catch (error) {
    logger.error(`Error creando carpeta de etiquetas: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'No se pudo crear la carpeta'
    })
  }
}

/** DELETE /api/contact-tags/folders/:id — borra la carpeta; las etiquetas quedan sin carpeta */
export const deleteContactTagFolderHandler = async (req, res) => {
  try {
    const deleted = await deleteContactTagFolder(req.params.id)
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Carpeta no encontrada' })
    }
    res.json({ success: true })
  } catch (error) {
    logger.error(`Error eliminando carpeta de etiquetas ${req.params.id}: ${error.message}`)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'No se pudo eliminar la carpeta'
    })
  }
}
