import apiClient from './apiClient'

export type MetaCampaignTemplateMode = 'manual_strict' | 'automation_ready' | string

export interface MetaCampaignBuilderCapabilities {
  mcp: {
    serverUrl: string
    serverLabel: string
    executionEnabled: boolean
    hasAuthorization: boolean
    status: 'ready' | 'preview_only' | string
  }
  connection: {
    mcpServerUrl: string
    hasAccessToken: boolean
    adAccountId: string
    pageId: string
    instagramAccountId: string
    pixelId: string
    timezoneName: string
    timezoneId: string | number | null
    timezoneOffsetHoursUtc: string | number | null
    updatedAt: string | null
  }
  templates: Array<{
    id: string
    name: string
    description: string
    category: string
    mode: MetaCampaignTemplateMode
    version: number
  }>
  supportedSections: string[]
  guardrails: {
    defaultCampaignStatus: string
    requiresPreviewBeforeExecution: boolean
    requiresHumanApproval: boolean
    storesEveryPayload: boolean
    manualTemplatesDisableAdvantageByDefault: boolean
  }
}

export interface MetaCampaignTemplate {
  id: string
  name: string
  description: string
  category: string
  mode: MetaCampaignTemplateMode
  version: number
  isSystem: boolean
  isActive: boolean
  template: Record<string, unknown>
}

export interface MetaCampaignDraftValidation {
  readyForPreview: boolean
  readyForExecution: boolean
  blockingIssues: Array<{ field: string; message: string }>
  warnings: Array<{ field: string; message: string }>
  policy: {
    manualStrict: boolean
    lockedOptions: string[]
    editableOptions: string[]
    disabledAutomation: string[]
  }
}

export interface MetaCampaignDraft {
  id: string
  traceId: string
  templateId: string
  name: string
  status: string
  executionStatus: string
  lastError: string | null
  createdAt: string
  updatedAt: string
  executedAt: string | null
  sourceContent: Record<string, unknown>
  configSnapshot: Record<string, unknown>
  templateSnapshot: Record<string, unknown>
  payload: Record<string, unknown>
  validation: MetaCampaignDraftValidation
  preview: Record<string, unknown>
}

export interface CreateMetaCampaignDraftInput {
  templateId?: 'manual_leads_whatsapp' | 'manual_sales_conversion' | 'automated_advantage_leads' | string
  content?: Record<string, unknown>
  account?: Record<string, unknown>
  campaign?: Record<string, unknown>
  adSet?: Record<string, unknown>
  creative?: Record<string, unknown>
  tracking?: Record<string, unknown>
  automation?: Record<string, unknown>
  optionOverrides?: Record<string, unknown>
}

export interface MetaCampaignExecutionResult {
  ok: boolean
  status: string
  message: string
  draft?: MetaCampaignDraft
  validation?: MetaCampaignDraftValidation
  requiresConfirmation?: boolean
  mcp?: Record<string, unknown> | null
}

export interface MetaCampaignDraftLog {
  id: string
  draft_id: string
  trace_id: string
  step: string
  status: string
  mcp_server_url: string
  request_payload_json: string | null
  response_payload_json: string | null
  error_message: string | null
  created_at: string
}

export const metaCampaignBuilderService = {
  getCapabilities() {
    return apiClient.get<MetaCampaignBuilderCapabilities>('/meta/campaign-builder/capabilities')
  },

  listTemplates() {
    return apiClient.get<MetaCampaignTemplate[]>('/meta/campaign-builder/templates')
  },

  getTemplate(templateId: string) {
    return apiClient.get<MetaCampaignTemplate>(`/meta/campaign-builder/templates/${encodeURIComponent(templateId)}`)
  },

  createDraft(input: CreateMetaCampaignDraftInput) {
    return apiClient.post<MetaCampaignDraft>('/meta/campaign-builder/drafts', input)
  },

  getDraft(draftId: string) {
    return apiClient.get<MetaCampaignDraft>(`/meta/campaign-builder/drafts/${encodeURIComponent(draftId)}`)
  },

  previewDraft(draftId: string) {
    return apiClient.post<MetaCampaignDraft>(`/meta/campaign-builder/drafts/${encodeURIComponent(draftId)}/preview`)
  },

  executeDraft(draftId: string, options: { dryRun?: boolean; confirmation?: boolean } = {}) {
    return apiClient.post<MetaCampaignExecutionResult>(
      `/meta/campaign-builder/drafts/${encodeURIComponent(draftId)}/execute`,
      options
    )
  },

  getDraftLogs(draftId: string) {
    return apiClient.get<MetaCampaignDraftLog[]>(`/meta/campaign-builder/drafts/${encodeURIComponent(draftId)}/logs`)
  }
}
