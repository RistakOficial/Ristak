import { DEFAULT_CRM_LABELS, type CrmLabels } from './crmLabels'

export type ContactLifecycleStage = 'lead' | 'appointment' | 'attended' | 'customer'

export interface ContactLifecycleStageOption {
  value: ContactLifecycleStage
  label: string
}

export function getContactLifecycleStageOptions(
  labels: Pick<CrmLabels, 'lead' | 'customer'> = DEFAULT_CRM_LABELS
): ContactLifecycleStageOption[] {
  return [
    { value: 'lead', label: labels.lead?.trim() || DEFAULT_CRM_LABELS.lead },
    { value: 'appointment', label: 'Agendó cita' },
    { value: 'attended', label: 'Asistió a cita' },
    { value: 'customer', label: labels.customer?.trim() || DEFAULT_CRM_LABELS.customer }
  ]
}

export const DEFAULT_CONTACT_LIFECYCLE_STAGE_OPTIONS = getContactLifecycleStageOptions()
