import type { WhatsAppApiTemplateVariableBindings } from '../services/whatsappApiService'

export type WhatsAppTemplateVariableTarget = 'headerText' | 'bodyText'

export function getWhatsAppTemplateVariableLabel(
  bindings: WhatsAppApiTemplateVariableBindings | undefined,
  target: WhatsAppTemplateVariableTarget,
  variableIndex: string
): string {
  const binding = bindings?.[target]?.[variableIndex]
  const configuredLabel = String(binding?.label || '').trim()
  if (configuredLabel) return configuredLabel

  const configuredKey = String(binding?.variableKey || '').trim()
  if (configuredKey) return configuredKey

  const mergeField = String(binding?.mergeField || '').replace(/[{}]/g, '').trim()
  return mergeField || `Variable ${variableIndex}`
}
