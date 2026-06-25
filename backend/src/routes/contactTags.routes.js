import express from 'express'
import {
  getContactTags,
  getSystemContactTags,
  getContactTagsCatalog,
  createContactTagHandler,
  updateContactTagHandler,
  deleteContactTagHandler,
  createContactTagFolderHandler,
  deleteContactTagFolderHandler
} from '../controllers/contactTagsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.use(requireAuth)
// (ACL-001) Las etiquetas son parte del módulo de Contactos; protegemos la API
// directa con requireModuleAccess('contacts') para respetar el rol fuera de la UI.
router.use(requireModuleAccess('contacts'))

// Las rutas fijas van antes de '/:id'
router.get('/catalog', getContactTagsCatalog)
router.get('/system', getSystemContactTags)
router.post('/folders', createContactTagFolderHandler)
router.delete('/folders/:id', deleteContactTagFolderHandler)

router.get('/', getContactTags)
router.post('/', createContactTagHandler)
router.put('/:id', updateContactTagHandler)
router.delete('/:id', deleteContactTagHandler)

export default router
