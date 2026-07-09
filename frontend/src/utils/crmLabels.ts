export interface CrmLabels {
  customer: string
  customers: string
  lead: string
  leads: string
}

export const DEFAULT_CRM_LABELS: CrmLabels = {
  customer: 'Cliente',
  customers: 'Clientes',
  lead: 'Interesado',
  leads: 'Interesados'
}

export function cleanCrmLabel(value: string | null | undefined, fallback: string) {
  return String(value || '').trim() || fallback
}

export function normalizeCrmLabels(labels?: Partial<CrmLabels> | null): CrmLabels {
  return {
    customer: cleanCrmLabel(labels?.customer, DEFAULT_CRM_LABELS.customer),
    customers: cleanCrmLabel(labels?.customers, DEFAULT_CRM_LABELS.customers),
    lead: cleanCrmLabel(labels?.lead, DEFAULT_CRM_LABELS.lead),
    leads: cleanCrmLabel(labels?.leads, DEFAULT_CRM_LABELS.leads)
  }
}

export function formatCrmLabelLower(value: string | null | undefined, fallback: string) {
  return cleanCrmLabel(value, fallback).toLocaleLowerCase('es-MX')
}

export function formatCrmLabelSentence(value: string | null | undefined, fallback: string) {
  const label = cleanCrmLabel(value, fallback)
  return label ? `${label.slice(0, 1).toLocaleUpperCase('es-MX')}${label.slice(1)}` : fallback
}

function looksFeminineSingular(label: string) {
  const clean = label.trim().toLocaleLowerCase('es-MX')
  if (!clean || /\s/.test(clean)) return false
  if (/(cion|ción|sion|sión|dad|tad|tud|umbre)$/.test(clean)) return true
  if (/(ista|ante|ente)$/.test(clean)) return false
  return clean.endsWith('a')
}

export function formatCrmLabelWithDefiniteArticle(value: string | null | undefined, fallback: string, preposition: 'de' | 'a' | 'none' = 'de') {
  const label = formatCrmLabelLower(value, fallback)
  const feminine = looksFeminineSingular(label)
  if (preposition === 'none') return `${feminine ? 'la' : 'el'} ${label}`
  if (preposition === 'a') return `${feminine ? 'a la' : 'al'} ${label}`
  return `${feminine ? 'de la' : 'del'} ${label}`
}
