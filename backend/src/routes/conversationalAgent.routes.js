import express from 'express'
import {
  getConfig,
  saveConfig,
  listStates,
  getState,
  updateState,
  testAgent,
  listEvents,
  listAgents,
  getMetrics,
  getAgentGovernance,
  generateAgentLearning,
  reviewAgentLearning,
  rollbackAgentPolicy,
  createAgent,
  updateAgent,
  deleteAgent,
  resetAgentSkippedContacts,
  getFilterOptions,
  listAIProviders,
  connectAIProvider,
  deleteAIProvider
} from '../controllers/conversationalAgentController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.use(requireAuth)
router.use(requireModuleAccess('ai_agent'))

router.get('/config', getConfig)
router.post('/config', saveConfig)
router.get('/ai-providers', listAIProviders)
router.post('/ai-providers/:providerId', connectAIProvider)
router.delete('/ai-providers/:providerId', deleteAIProvider)
router.get('/agents', listAgents)
router.get('/metrics', getMetrics)
router.get('/filter-options', getFilterOptions)
router.post('/agents', createAgent)
router.put('/agents/:agentId', updateAgent)
router.get('/agents/:agentId/governance', getAgentGovernance)
router.post('/agents/:agentId/learning', generateAgentLearning)
router.post('/agents/:agentId/learning/:learningId/review', reviewAgentLearning)
router.post('/agents/:agentId/policy-versions/:versionId/rollback', rollbackAgentPolicy)
router.post('/agents/:agentId/reset-skipped', resetAgentSkippedContacts)
router.delete('/agents/:agentId', deleteAgent)
router.get('/states', listStates)
router.get('/states/:contactId', getState)
router.post('/states/:contactId', updateState)
router.post('/test', testAgent)
router.get('/events', listEvents)

export default router
