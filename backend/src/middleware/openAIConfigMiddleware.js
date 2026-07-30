import {
  isAIRuntimeCredentialError,
  isAIRuntimeOpenAIRequiredError,
  requireOpenAIApiKey
} from '../services/aiRuntimeService.js'

export async function requireOpenAIConfigured(req, res, next) {
  try {
    req.openAIApiKey = await requireOpenAIApiKey()
    next()
  } catch (error) {
    if (isAIRuntimeOpenAIRequiredError(error)) {
      return res.status(error.statusCode || 409).json({
        success: false,
        error: error.message,
        code: error.code,
        needsOpenAIConfig: true
      })
    }

    if (isAIRuntimeCredentialError(error)) {
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
