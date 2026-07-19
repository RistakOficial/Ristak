import apiClient from './apiClient'
import type { CrmLabels } from '@/utils/crmLabels'

export const crmLabelsService = {
  get: () => apiClient.get<CrmLabels>('/settings/contact-labels'),
  update: (labels: CrmLabels) => apiClient.post<CrmLabels>('/settings/contact-labels', labels)
}
