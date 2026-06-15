import {
  isAIAgentCredentialError,
  isAIAgentOpenAIRequiredError,
  requireOpenAIApiKey
} from '../services/aiAgentService.js'

export async function requireOpenAIConfigured(req, res, next) {
  try {
    req.openAIApiKey = await requireOpenAIApiKey()
    next()
  } catch (error) {
    if (isAIAgentOpenAIRequiredError(error)) {
      return res.status(error.statusCode || 409).json({
        success: false,
        error: error.message,
        code: error.code,
        needsOpenAIConfig: true
      })
    }

    if (isAIAgentCredentialError(error)) {
      return res.status(error.statusCode || 409).json({
        success: false,
        error: error.message,
        code: error.code,
        needsReconnect: true
      })
    }

    next(error)
  }
}
