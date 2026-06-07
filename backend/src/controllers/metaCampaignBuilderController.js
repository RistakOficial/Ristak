import {
  createMetaCampaignDraft,
  executeMetaCampaignDraft,
  getMetaCampaignBuilderCapabilities,
  getMetaCampaignDraft,
  getMetaCampaignTemplate,
  listMetaCampaignDraftLogs,
  listMetaCampaignTemplates,
  rebuildMetaCampaignDraftPreview
} from '../services/metaCampaignBuilderService.js'
import { logger } from '../utils/logger.js'

function getRequestUserId(req) {
  return req.user?.userId || req.user?.id || null
}

function handleControllerError(res, error, fallbackMessage = 'No pudimos completar esta acción.') {
  logger.error(error.message || fallbackMessage)
  return res.status(500).json({
    success: false,
    error: error.message || fallbackMessage
  })
}

export async function getCampaignBuilderCapabilities(req, res) {
  try {
    const data = await getMetaCampaignBuilderCapabilities()
    return res.json({ success: true, data })
  } catch (error) {
    return handleControllerError(res, error, 'No pudimos leer las capacidades de campañas Meta.')
  }
}

export async function getCampaignBuilderTemplates(req, res) {
  try {
    const data = await listMetaCampaignTemplates()
    return res.json({ success: true, data })
  } catch (error) {
    return handleControllerError(res, error, 'No pudimos leer las plantillas de campañas Meta.')
  }
}

export async function getCampaignBuilderTemplate(req, res) {
  try {
    const template = await getMetaCampaignTemplate(req.params.templateId)

    if (!template) {
      return res.status(404).json({
        success: false,
        error: 'No encontramos esa plantilla de campaña.'
      })
    }

    return res.json({ success: true, data: template })
  } catch (error) {
    return handleControllerError(res, error, 'No pudimos leer esa plantilla de campaña.')
  }
}

export async function createCampaignBuilderDraft(req, res) {
  try {
    const data = await createMetaCampaignDraft(req.body || {}, {
      userId: getRequestUserId(req)
    })

    return res.status(201).json({
      success: true,
      data
    })
  } catch (error) {
    return handleControllerError(res, error, 'No pudimos crear el borrador de campaña.')
  }
}

export async function getCampaignBuilderDraft(req, res) {
  try {
    const draft = await getMetaCampaignDraft(req.params.draftId)

    if (!draft) {
      return res.status(404).json({
        success: false,
        error: 'No encontramos ese borrador de campaña.'
      })
    }

    return res.json({ success: true, data: draft })
  } catch (error) {
    return handleControllerError(res, error, 'No pudimos leer el borrador de campaña.')
  }
}

export async function previewCampaignBuilderDraft(req, res) {
  try {
    const data = await rebuildMetaCampaignDraftPreview(req.params.draftId)
    return res.json({ success: true, data })
  } catch (error) {
    return handleControllerError(res, error, 'No pudimos generar el preview de campaña.')
  }
}

export async function executeCampaignBuilderDraft(req, res) {
  try {
    const result = await executeMetaCampaignDraft(req.params.draftId, {
      dryRun: Boolean(req.body?.dryRun),
      confirmation: Boolean(req.body?.confirmation)
    })
    const status = result.ok ? 200 : result.status === 'needs_review' ? 422 : 409

    return res.status(status).json({
      success: result.ok,
      data: result
    })
  } catch (error) {
    return handleControllerError(res, error, 'No pudimos ejecutar el borrador de campaña.')
  }
}

export async function getCampaignBuilderDraftLogs(req, res) {
  try {
    const draft = await getMetaCampaignDraft(req.params.draftId)

    if (!draft) {
      return res.status(404).json({
        success: false,
        error: 'No encontramos ese borrador de campaña.'
      })
    }

    const data = await listMetaCampaignDraftLogs(req.params.draftId)
    return res.json({ success: true, data })
  } catch (error) {
    return handleControllerError(res, error, 'No pudimos leer el rastro de campaña.')
  }
}
