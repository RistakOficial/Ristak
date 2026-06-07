import { useState, useMemo, useEffect } from 'react'
import { Modal, Icon, Badge, type BadgeVariant } from '@/components/common'
import { ContactJourney } from '@/components/common/ContactJourney'
import { normalizeTrafficSource } from '@/utils/trafficSourceNormalizer'
import { CONTACT_STAGE_BADGE_VARIANTS, getContactStageBadge } from '@/utils/contactStageBadge'
import { buildSearchIndex, prepareSearchQuery, searchIndexIncludes } from '@/utils/searchText'
import { useLabels } from '@/contexts/LabelsContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import type { ContactCustomField, ContactCustomFieldValue, ContactMetaAttribution } from '@/types'
import styles from './ContactDetailsModal.module.css'

interface ContactPaymentDetail {
  id: string
  amount: number
  status?: string | null
  date: string
  payment_mode?: 'live' | 'test'
  paymentMode?: 'live' | 'test'
}

interface ContactAppointmentDetail {
  id: string
  title?: string | null
  status?: string | null
  start_time: string
}

interface ContactFirstSession {
  started_at?: string | null
  page_url?: string | null
  landing_page?: string | null
  referrer_url?: string | null
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
  utm_content?: string | null
  utm_term?: string | null
  source_platform?: string | null
  site_source_name?: string | null
  campaign_name?: string | null
  adset_name?: string | null
  ad_name?: string | null
  ad_id?: string | null
  device_type?: string | null
  browser?: string | null
  os?: string | null
  placement?: string | null
  geo_city?: string | null
  geo_region?: string | null
  geo_country?: string | null
}

interface ContactDetail {
  id: string
  name?: string | null
  email?: string | null
  phone?: string | null
  created_at: string | Date
  ltv?: number
  purchases?: number
  payments?: ContactPaymentDetail[]
  appointments?: ContactAppointmentDetail[]
  firstAppointmentDate?: string | null
  nextAppointmentDate?: string | null
  source?: string | null
  ad_name?: string | null
  ad_id?: string | null
  campaign_id?: string | null
  campaign_name?: string | null
  adset_id?: string | null
  adset_name?: string | null
  metaAttribution?: ContactMetaAttribution | null
  lifetimeLtv?: number
  lifetimePurchases?: number
  isCustomer?: boolean
  hasAppointments?: boolean
  hasShowedAppointment?: boolean
  hasAttendedAppointment?: boolean
  is_sale?: boolean
  firstSession?: ContactFirstSession | null
  customFields?: ContactCustomField[]
  preferredWhatsAppPhoneNumberId?: string | null
  preferred_whatsapp_phone_number_id?: string | null
}

interface WhatsAppPhoneOption {
  id: string
  phone_number?: string | null
  display_phone_number?: string | null
  verified_name?: string | null
  label?: string | null
  is_default_sender?: boolean
}

interface ContactDetailsModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  subtitle?: string
  data: ContactDetail[]
  loading: boolean
  type?: 'interesados' | 'sales' | 'appointments' | 'attendances' | null
  onUpdateCustomFields?: (contactId: string, customFields: ContactCustomField[]) => Promise<ContactCustomField[]>
  whatsappPhoneNumbers?: WhatsAppPhoneOption[]
  onUpdatePreferredWhatsAppPhoneNumber?: (contactId: string, phoneNumberId: string) => Promise<Partial<ContactDetail> | void>
}

const getCustomFieldIdentity = (field: ContactCustomField, index: number) =>
  field.id || field.key || field.fieldKey || field.label || field.name || `custom-field-${index}`

const getCustomFieldLabel = (field: ContactCustomField, index: number) =>
  field.label || field.name || field.key || field.fieldKey || field.id || `Campo personalizado ${index + 1}`

const getWhatsAppPhoneLabel = (phone: WhatsAppPhoneOption) => {
  const number = phone.display_phone_number || phone.phone_number || phone.id
  const name = phone.label || phone.verified_name || ''
  return name && name !== number ? `${name} · ${number}` : number
}

const getPreferredWhatsAppPhoneNumberId = (contact?: ContactDetail | null) =>
  String(contact?.preferredWhatsAppPhoneNumberId || contact?.preferred_whatsapp_phone_number_id || '')

const getResolvedAttributionDisplay = (contact?: ContactDetail | null) => ({
  campaignName: contact?.metaAttribution?.campaignName || contact?.campaign_name || null,
  adsetName: contact?.metaAttribution?.adsetName || contact?.adset_name || null,
  adName: contact?.metaAttribution?.adName || contact?.ad_name || null,
  adId: contact?.metaAttribution?.adId || contact?.ad_id || null
})

const WHATSAPP_RESERVED_CUSTOM_FIELD_KEYS = new Set([
  'whatsapp_api_provider',
  'whatsapp_api_first_message',
  'whatsapp_api_source_id',
  'whatsapp_api_ctwa_clid',
  'whatsapp_api_source_url'
])

const normalizeCustomFieldToken = (value?: string | null) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

const isWhatsAppReservedCustomField = (field: ContactCustomField) => {
  const tokens = [
    field.id,
    field.key,
    field.fieldKey,
    field.label,
    field.name
  ].map(normalizeCustomFieldToken).filter(Boolean)

  return tokens.some(token =>
    WHATSAPP_RESERVED_CUSTOM_FIELD_KEYS.has(token) ||
    token.startsWith('whatsapp_api_') ||
    token.includes('_ctwa_') ||
    token === 'ctwa' ||
    token === 'ctwa_clid'
  )
}

const isObjectValue = (value: ContactCustomFieldValue | undefined): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const isComplexCustomField = (field: ContactCustomField) =>
  Array.isArray(field.value) || isObjectValue(field.value)

const formatCustomFieldDraft = (value: ContactCustomFieldValue | undefined) => {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value) || isObjectValue(value)) return JSON.stringify(value, null, 2)
  return String(value)
}

const buildCustomFieldDrafts = (fields: ContactCustomField[] = []) =>
  fields.reduce<Record<string, string>>((drafts, field, index) => {
    drafts[getCustomFieldIdentity(field, index)] = formatCustomFieldDraft(field.value)
    return drafts
  }, {})

const parseJsonDraft = (draft: string) => {
  try {
    return JSON.parse(draft)
  } catch {
    throw new Error('Ese campo espera JSON valido.')
  }
}

const parseCustomFieldDraft = (draft: string, field: ContactCustomField): ContactCustomFieldValue => {
  const trimmed = draft.trim()
  const dataType = String(field.dataType || '').toLowerCase()

  if (Array.isArray(field.value) || dataType.includes('multi') || dataType.includes('checkbox')) {
    if (!trimmed) return []
    if (trimmed.startsWith('[')) return parseJsonDraft(trimmed) as ContactCustomFieldValue
    return trimmed.split(',').map(item => item.trim()).filter(Boolean)
  }

  if (isObjectValue(field.value) || dataType.includes('file')) {
    if (!trimmed) return {}
    return parseJsonDraft(trimmed) as ContactCustomFieldValue
  }

  if (typeof field.value === 'boolean' || dataType.includes('bool')) {
    return ['true', '1', 'si', 'sí', 'yes'].includes(trimmed.toLowerCase())
  }

  if (typeof field.value === 'number' || dataType.includes('number') || dataType.includes('numeric') || dataType.includes('monet')) {
    if (!trimmed) return null
    const numericValue = Number(trimmed)
    if (Number.isNaN(numericValue)) {
      throw new Error('Ese campo espera un numero valido.')
    }
    return numericValue
  }

  return draft
}

export function ContactDetailsModal({
  isOpen,
  onClose,
  title,
  subtitle,
  data,
  loading,
  type,
  onUpdateCustomFields,
  whatsappPhoneNumbers = [],
  onUpdatePreferredWhatsAppPhoneNumber
}: ContactDetailsModalProps) {
  const [selectedContact, setSelectedContact] = useState<ContactDetail | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [paymentsExpanded, setPaymentsExpanded] = useState(false)
  const [refundsExpanded, setRefundsExpanded] = useState(false)
  const [appointmentsExpanded, setAppointmentsExpanded] = useState(false)
  const [customFieldsExpanded, setCustomFieldsExpanded] = useState(false)
  const [customFieldDrafts, setCustomFieldDrafts] = useState<Record<string, string>>({})
  const [savingCustomField, setSavingCustomField] = useState<string | null>(null)
  const [customFieldError, setCustomFieldError] = useState<string | null>(null)
  const [savingWhatsAppPreference, setSavingWhatsAppPreference] = useState(false)
  const [whatsappPreferenceError, setWhatsappPreferenceError] = useState<string | null>(null)
  const { labels } = useLabels()
  const { formatLocalDateShort, formatLocalDateTime, timezone } = useTimezone()
  const visibleCustomFields = useMemo(
    () => (selectedContact?.customFields || []).filter(field => !isWhatsAppReservedCustomField(field)),
    [selectedContact?.customFields]
  )

  // Seleccionar automáticamente el primer contacto cuando se abre el modal
  useEffect(() => {
    if (isOpen && data.length > 0) {
      setSelectedContact(data[0])
    } else if (!isOpen) {
      setSelectedContact(null)
      setSearchQuery('')
      setPaymentsExpanded(false)
      setRefundsExpanded(false)
      setAppointmentsExpanded(false)
      setCustomFieldsExpanded(false)
      setCustomFieldDrafts({})
      setSavingCustomField(null)
      setCustomFieldError(null)
      setSavingWhatsAppPreference(false)
      setWhatsappPreferenceError(null)
    }
  }, [isOpen, data])

  useEffect(() => {
    setPaymentsExpanded(false)
    setRefundsExpanded(false)
    setAppointmentsExpanded(false)
    setCustomFieldsExpanded(false)
    setCustomFieldDrafts({})
    setSavingCustomField(null)
    setCustomFieldError(null)
    setSavingWhatsAppPreference(false)
    setWhatsappPreferenceError(null)
  }, [selectedContact?.id])

  useEffect(() => {
    if (!selectedContact) return
    setCustomFieldDrafts(buildCustomFieldDrafts(visibleCustomFields))
  }, [selectedContact?.id, visibleCustomFields])

  const preparedContactSearch = useMemo(() => prepareSearchQuery(searchQuery), [searchQuery])
  const contactSearchIndexes = useMemo(() => {
    return data.map(contact => buildSearchIndex([contact.name, contact.email, contact.phone, contact.id]))
  }, [data])

  // Filtrar contactos según búsqueda
  const filteredData = useMemo(() => {
    if (!preparedContactSearch.normalized) return data

    return data.filter((contact, index) =>
      searchIndexIncludes(
        contactSearchIndexes[index] ?? buildSearchIndex([contact.name, contact.email, contact.phone, contact.id]),
        preparedContactSearch
      )
    )
  }, [contactSearchIndexes, data, preparedContactSearch])

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN'
    }).format(value)
  }

  const formatStatusText = (value: string) =>
    value
      .toLowerCase()
      .split(/[\s_]+/)
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')

  const getStatusLabel = (status?: string | null): { text: string; variant: BadgeVariant } => {
    if (!status) return { text: '', variant: 'neutral' }
    const statusLower = status.toLowerCase()

    if (['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'].includes(statusLower)) {
      return { text: 'Pagado', variant: 'success' }
    }
    if (['refunded', 'refund'].includes(statusLower)) {
      return { text: 'Reembolsado', variant: 'error' }
    }
    if (['pending', 'processing'].includes(statusLower)) {
      return { text: 'Pendiente', variant: 'warning' }
    }
    if (['failed', 'canceled', 'cancelled'].includes(statusLower)) {
      return { text: 'Fallido', variant: 'error' }
    }
    if (['booked', 'confirmed', 'scheduled'].includes(statusLower)) {
      return { text: 'Reservado', variant: 'warning' }
    }

    return { text: formatStatusText(statusLower), variant: 'neutral' }
  }

  const getAppointmentStatusLabel = (status?: string | null): { text: string; variant: BadgeVariant } => {
    if (!status) return { text: 'Reservado', variant: 'warning' }
    const statusLower = status.toLowerCase()

    if (['confirmed', 'booked', 'scheduled'].includes(statusLower)) {
      return { text: 'Reservado', variant: 'warning' }
    }
    if (['completed', 'showed', 'attended'].includes(statusLower)) {
      return { text: 'Asistió', variant: CONTACT_STAGE_BADGE_VARIANTS.attended }
    }
    if (['cancelled', 'canceled', 'no_show', 'noshow'].includes(statusLower)) {
      return { text: 'Cancelado', variant: 'error' }
    }
    if (['pending', 'unconfirmed'].includes(statusLower)) {
      return { text: 'Pendiente', variant: 'warning' }
    }

    return { text: formatStatusText(statusLower), variant: 'neutral' }
  }

  const resolveContactBadge = (contact?: ContactDetail | null) =>
    getContactStageBadge(contact, labels)

  const updateCustomFieldDraft = (field: ContactCustomField, index: number, value: string) => {
    const identity = getCustomFieldIdentity(field, index)
    setCustomFieldDrafts(prev => ({
      ...prev,
      [identity]: value
    }))
    setCustomFieldError(null)
  }

  const saveCustomField = async (field: ContactCustomField, index: number) => {
    if (!selectedContact || !onUpdateCustomFields) return
    if (isWhatsAppReservedCustomField(field)) return

    const identity = getCustomFieldIdentity(field, index)
    const draft = customFieldDrafts[identity] ?? formatCustomFieldDraft(field.value)

    try {
      const value = parseCustomFieldDraft(draft, field)
      const updatedField: ContactCustomField = { ...field, value }

      setSavingCustomField(identity)
      setCustomFieldError(null)

      const customFields = await onUpdateCustomFields(selectedContact.id, [updatedField])
      setSelectedContact(prev => prev?.id === selectedContact.id ? { ...prev, customFields } : prev)
      setCustomFieldDrafts(buildCustomFieldDrafts(customFields.filter(field => !isWhatsAppReservedCustomField(field))))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo guardar el campo personalizado.'
      setCustomFieldError(message)
    } finally {
      setSavingCustomField(null)
    }
  }

  const updatePreferredWhatsAppPhoneNumber = async (phoneNumberId: string) => {
    if (!selectedContact || !onUpdatePreferredWhatsAppPhoneNumber) return

    setSavingWhatsAppPreference(true)
    setWhatsappPreferenceError(null)

    try {
      const updatedContact = await onUpdatePreferredWhatsAppPhoneNumber(selectedContact.id, phoneNumberId)
      setSelectedContact(prev => prev?.id === selectedContact.id
        ? {
            ...prev,
            ...(updatedContact || {}),
            preferredWhatsAppPhoneNumberId: phoneNumberId,
            preferred_whatsapp_phone_number_id: phoneNumberId
          }
        : prev
      )
    } catch (error) {
      setWhatsappPreferenceError(error instanceof Error ? error.message : 'No se pudo guardar el número para responder.')
    } finally {
      setSavingWhatsAppPreference(false)
    }
  }

  // Separar pagos exitosos de reembolsos/cancelados
  // CRÍTICO: Solo pagos con status exitoso, NO incluir refunded/cancelled
  const validPaymentStatuses = ['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success']
  const isTestPayment = (payment: ContactPaymentDetail) => (
    payment.paymentMode === 'test' || payment.payment_mode === 'test'
  )
  const payments = useMemo(() => {
    return selectedContact?.payments?.filter(p =>
      p.amount > 0 && !isTestPayment(p) && validPaymentStatuses.includes(p.status?.toLowerCase() || '')
    ) || []
  }, [selectedContact])

  const refunds = useMemo(() => {
    return selectedContact?.payments?.filter(p =>
      !isTestPayment(p) && (p.amount < 0 || p.status?.toLowerCase() === 'refunded' || p.status?.toLowerCase() === 'cancelled')
    ) || []
  }, [selectedContact])
  const resolvedAttribution = useMemo(
    () => getResolvedAttributionDisplay(selectedContact),
    [selectedContact]
  )

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title=""
      size="lg"
      showCloseButton={false}
    >
      <div className={styles.modalContainer}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerContent}>
            <div className={styles.headerTitleGroup}>
              <div className={styles.titleRow}>
                <h3 className={styles.title}>{title}</h3>
                <div className={styles.stats}>
                  <span className={styles.statItem}>
                    {data.length} {data.length === 1 ? 'elemento' : 'elementos'}
                  </span>
                  {type === 'sales' && data.some(d => (d.ltv || 0) > 0) && (
                    <span className={styles.statValue}>
                      Total: {formatCurrency(data.reduce((sum, d) => sum + (d.ltv || 0), 0))}
                    </span>
                  )}
                </div>
              </div>
              {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
            </div>
            <button onClick={onClose} className={styles.closeButton}>
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        {/* Main content */}
        <div className={styles.mainContent}>
          {/* Left panel - Lista de contactos */}
          <div className={selectedContact ? styles.leftPanel : styles.leftPanelFull}>
            {/* Search bar */}
            <div className={styles.searchContainer}>
              <div className={styles.searchInputWrapper}>
                <Icon name="search" size={16} className={styles.searchIcon} />
                <input
                  type="text"
                  placeholder="Buscar..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={styles.searchInput}
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className={styles.clearButton}
                  >
                    <Icon name="x" size={16} />
                  </button>
                )}
              </div>
            </div>

            {/* Contact list */}
            <div className={styles.contactList}>
              {loading ? (
                <div className={styles.emptyState}>
                  <Icon name="refresh" size={24} className={styles.spinIcon} />
                  <p>Cargando elementos...</p>
                </div>
              ) : filteredData.length === 0 ? (
                <div className={styles.emptyState}>
                  <Icon name="users" size={24} />
                  <p>{searchQuery ? 'No se encontraron resultados' : 'No hay elementos para mostrar'}</p>
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className={styles.clearSearchButton}
                    >
                      Limpiar búsqueda
                    </button>
                  )}
                </div>
              ) : (
                <>
                  {filteredData.map((contact) => (
                    <div
                      key={contact.id}
                      onClick={() => setSelectedContact(contact)}
                      className={`${styles.contactItem} ${selectedContact?.id === contact.id ? styles.contactItemSelected : ''}`}
                    >
                      <div className={styles.contactAvatar}>
                        <Icon name="user" size={16} />
                      </div>

                      <div className={styles.contactInfo}>
                        <p className={styles.contactName}>
                          {contact.name || '—'}
                        </p>
                        {(contact.email || contact.phone) && (
                          <p className={styles.contactDetail}>
                            {contact.email || contact.phone}
                          </p>
                        )}
                      </div>

                      <div className={styles.contactIndicators}>
                        {(() => {
                          const badge = resolveContactBadge(contact)
                          return badge ? (
                            <Badge variant={badge.variant} className={styles.contactBadge}>
                              {badge.text}
                            </Badge>
                          ) : null
                        })()}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* Footer */}
            {data.length > 0 && (
              <div className={styles.footer}>
                <span>
                  Mostrando {filteredData.length} de {data.length}
                </span>
              </div>
            )}
          </div>

          {/* Right panel - Detalles del contacto */}
          {selectedContact && (
            <div className={styles.rightPanel}>
              {/* Contact header */}
              <div className={styles.contactHeader}>
                <div className={styles.contactHeaderAvatar}>
                  <Icon name="user" size={20} />
                </div>
                <div className={styles.contactHeaderInfo}>
                  <div className={styles.contactHeaderNameRow}>
                    <h4 className={styles.contactHeaderName}>
                      {selectedContact.name || '—'}
                    </h4>
                    {(() => {
                      const badge = resolveContactBadge(selectedContact)
                      return badge ? (
                        <Badge variant={badge.variant} className={styles.contactHeaderBadge}>
                          {badge.text}
                        </Badge>
                      ) : null
                    })()}
                  </div>
                  {(selectedContact.email || selectedContact.phone) && (
                    <div className={styles.contactHeaderMeta}>
                      {selectedContact.email && (
                        <span>{selectedContact.email}</span>
                      )}
                      {selectedContact.email && selectedContact.phone && (
                        <span className={styles.metaSeparator}>/</span>
                      )}
                      {selectedContact.phone && (
                        <span>{selectedContact.phone}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Contact details */}
              <div className={styles.contactDetails}>
                {/* Información básica */}
                <div className={styles.detailSection}>
                  <h5 className={styles.detailSectionTitle}>
                    Información de Contacto
                  </h5>
                  <div className={styles.detailSectionContent}>
                    {selectedContact.email && (
                      <div className={styles.detailItem}>
                        <Icon name="mail" size={16} />
                        <span>{selectedContact.email}</span>
                      </div>
                    )}
                    {selectedContact.phone && (
                      <div className={styles.detailItem}>
                        <Icon name="phone" size={16} />
                        <span>{selectedContact.phone}</span>
                      </div>
                    )}
                    <div className={styles.detailItem}>
                      <Icon name="calendar" size={16} />
                      <span>{formatLocalDateShort(selectedContact.created_at)}</span>
                    </div>
                  </div>
                </div>

                {whatsappPhoneNumbers.length > 0 && (
                  <div className={styles.detailSection}>
                    <h5 className={styles.detailSectionTitle}>WhatsApp para responder</h5>
                    <div className={styles.whatsappPreference}>
                      <div className={styles.whatsappPreferenceHeader}>
                        <Icon name="whatsapp" size={16} />
                        <div>
                          <strong>
                            {getPreferredWhatsAppPhoneNumberId(selectedContact)
                              ? 'Número fijo para este contacto'
                              : 'Automático por conversación'}
                          </strong>
                          <span>
                            {getPreferredWhatsAppPhoneNumberId(selectedContact)
                              ? 'Ristak siempre responderá a este contacto desde el número elegido.'
                              : 'Ristak responderá desde el número por donde llegó el mensaje. Si no hay historial, usa el principal.'}
                          </span>
                        </div>
                      </div>
                      <select
                        className={styles.whatsappPreferenceSelect}
                        value={getPreferredWhatsAppPhoneNumberId(selectedContact)}
                        onChange={(event) => updatePreferredWhatsAppPhoneNumber(event.target.value)}
                        disabled={savingWhatsAppPreference || !onUpdatePreferredWhatsAppPhoneNumber}
                      >
                        <option value="">Automático: usar el número por donde llegó</option>
                        {whatsappPhoneNumbers.map((phone) => (
                          <option key={phone.id} value={phone.id}>
                            {getWhatsAppPhoneLabel(phone)}{phone.is_default_sender ? ' · Principal' : ''}
                          </option>
                        ))}
                      </select>
                      {savingWhatsAppPreference && (
                        <p className={styles.whatsappPreferenceHint}>Guardando cambio...</p>
                      )}
                      {whatsappPreferenceError && (
                        <p className={styles.customFieldError}>{whatsappPreferenceError}</p>
                      )}
                    </div>
                  </div>
                )}

                <div className={styles.detailSection}>
                  <button
                    type="button"
                    className={styles.customFieldsToggle}
                    onClick={() => setCustomFieldsExpanded(prev => !prev)}
                    aria-expanded={customFieldsExpanded}
                  >
                    <span className={styles.customFieldsToggleLabel}>
                      <Icon name={customFieldsExpanded ? 'chevron-down' : 'chevron-right'} size={14} />
                      Campos personalizados
                    </span>
                    <span className={styles.customFieldsToggleMeta}>
                      {visibleCustomFields.length}
                    </span>
                  </button>

                  {customFieldsExpanded && (
                    <div className={styles.customFieldsList}>
                      {visibleCustomFields.length === 0 ? (
                        <p className={styles.emptyText}>Sin campos personalizados</p>
                      ) : (
                        visibleCustomFields.map((field, index) => {
                          const identity = getCustomFieldIdentity(field, index)
                          const isSaving = savingCustomField === identity
                          const isComplex = isComplexCustomField(field)
                          const fieldInputId = `custom-field-${selectedContact.id}-${index}`
                          const fieldValue = customFieldDrafts[identity] ?? formatCustomFieldDraft(field.value)
                          const originalValue = formatCustomFieldDraft(field.value)
                          const hasChanges = fieldValue !== originalValue

                          return (
                            <div key={identity} className={styles.customFieldRow}>
                              <label className={styles.customFieldLabel} htmlFor={fieldInputId}>
                                <span>{getCustomFieldLabel(field, index)}</span>
                                {(field.key || field.fieldKey || field.id) && (
                                  <span className={styles.customFieldKey}>
                                    {field.key || field.fieldKey || field.id}
                                  </span>
                                )}
                              </label>

                              <div className={`${styles.customFieldControl} ${isComplex ? styles.customFieldControlMultiline : ''}`}>
                                {isComplex ? (
                                  <textarea
                                    id={fieldInputId}
                                    className={`${styles.customFieldTextarea} ${hasChanges ? styles.customFieldInputWithButton : ''}`}
                                    value={fieldValue}
                                    onChange={(event) => updateCustomFieldDraft(field, index, event.target.value)}
                                    rows={4}
                                    readOnly={!onUpdateCustomFields}
                                  />
                                ) : (
                                  <input
                                    id={fieldInputId}
                                    className={`${styles.customFieldInput} ${hasChanges ? styles.customFieldInputWithButton : ''}`}
                                    value={fieldValue}
                                    onChange={(event) => updateCustomFieldDraft(field, index, event.target.value)}
                                    readOnly={!onUpdateCustomFields}
                                  />
                                )}
                                {onUpdateCustomFields && hasChanges && (
                                  <button
                                    type="button"
                                    className={styles.customFieldSaveButton}
                                    onClick={() => saveCustomField(field, index)}
                                    disabled={isSaving}
                                  >
                                    {isSaving ? 'Guardando...' : 'Guardar'}
                                  </button>
                                )}
                              </div>
                            </div>
                          )
                        })
                      )}
                    </div>
                  )}
                  {customFieldError && (
                    <p className={styles.customFieldError}>{customFieldError}</p>
                  )}
                </div>

                {/* Primera Atribución (Primer Toque) */}
                {selectedContact.firstSession && (
                  <div className={styles.detailSection}>
                    <h5 className={styles.detailSectionTitle}>
                      Primera Atribución (Primer Toque)
                    </h5>
                    <div className={styles.detailSectionContent}>
                      <div className={styles.detailItem}>
                        <Icon name="calendar" size={16} />
                        <div>
                          <span className={styles.detailItemLabel}>Primera visita:</span>
                          <span> {formatLocalDateTime(selectedContact.firstSession.started_at || selectedContact.created_at)}</span>
                        </div>
                      </div>

                      {(() => {
                        const source = normalizeTrafficSource({
                          site_source_name: selectedContact.firstSession.site_source_name,
                          source_platform: selectedContact.firstSession.source_platform,
                          utm_source: selectedContact.firstSession.utm_source,
                          referrer_url: selectedContact.firstSession.referrer_url
                        })
                        return source && source !== 'Desconocido' ? (
                          <div className={styles.detailItem}>
                            <Icon name="globe" size={16} />
                            <div>
                              <span className={styles.detailItemLabel}>Fuente:</span>
                              <span> {source}</span>
                            </div>
                          </div>
                        ) : null
                      })()}

                      {(selectedContact.firstSession.campaign_name || selectedContact.firstSession.utm_campaign) && (
                        <div className={styles.detailItem}>
                          <Icon name="megaphone" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Campaña:</span>
                            <span> {selectedContact.firstSession.campaign_name || selectedContact.firstSession.utm_campaign}</span>
                          </div>
                        </div>
                      )}

                      {(selectedContact.firstSession.ad_name || selectedContact.firstSession.utm_content) && (
                        <div className={styles.detailItem}>
                          <Icon name="file-text" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Anuncio:</span>
                            <span> {selectedContact.firstSession.ad_name || selectedContact.firstSession.utm_content}</span>
                          </div>
                        </div>
                      )}

                      {selectedContact.firstSession.device_type && (
                        <div className={styles.detailItem}>
                          <Icon name="smartphone" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Dispositivo:</span>
                            <span> {selectedContact.firstSession.device_type}{selectedContact.firstSession.browser && ` · ${selectedContact.firstSession.browser}`}</span>
                          </div>
                        </div>
                      )}

                      {(selectedContact.firstSession.geo_city || selectedContact.firstSession.geo_country) && (
                        <div className={styles.detailItem}>
                          <Icon name="map-pin" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Ubicación:</span>
                            <span> {[selectedContact.firstSession.geo_city, selectedContact.firstSession.geo_country].filter(Boolean).join(', ')}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Atribución (solo si NO hay firstSession) */}
                {!selectedContact.firstSession && (selectedContact.source || resolvedAttribution.campaignName || resolvedAttribution.adsetName || resolvedAttribution.adName) && (
                  <div className={styles.detailSection}>
                    <h5 className={styles.detailSectionTitle}>
                      De dónde llegó el contacto:
                    </h5>
                    <div className={styles.detailSectionContent}>
                      {selectedContact.source && (
                        <div className={styles.detailItem}>
                          <Icon name="tag" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Fuente:</span>
                            <span> {selectedContact.source}</span>
                          </div>
                        </div>
                      )}
                      {resolvedAttribution.campaignName && (
                        <div className={styles.detailItem}>
                          <Icon name="megaphone" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Campaña:</span>
                            <span> {resolvedAttribution.campaignName}</span>
                          </div>
                        </div>
                      )}
                      {resolvedAttribution.adsetName && (
                        <div className={styles.detailItem}>
                          <Icon name="layers" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Conjunto de anuncios:</span>
                            <span> {resolvedAttribution.adsetName}</span>
                          </div>
                        </div>
                      )}
                      {resolvedAttribution.adName && (
                        <div className={styles.detailItem}>
                          <Icon name="file-text" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Anuncio:</span>
                            <span> {resolvedAttribution.adName}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Información de Citas */}
                {(selectedContact.firstAppointmentDate || selectedContact.nextAppointmentDate) && (
                  <div className={styles.detailSection}>
                    <h5 className={styles.detailSectionTitle}>Información de Citas</h5>
                    <div className={styles.detailSectionContent}>
                      {selectedContact.firstAppointmentDate && (
                        <div className={styles.detailItem}>
                          <Icon name="calendar" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Primera cita:</span>
                            <span>{formatLocalDateTime(selectedContact.firstAppointmentDate)}</span>
                          </div>
                        </div>
                      )}
                      {selectedContact.nextAppointmentDate && (
                        <div className={styles.detailItem}>
                          <Icon name="clock" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Próxima cita:</span>
                            <span>{formatLocalDateTime(selectedContact.nextAppointmentDate)}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Grid de 2 columnas: Citas y Pagos */}
                <div className={styles.twoColumnGrid}>
                  {/* COLUMNA IZQUIERDA: Citas */}
                  {selectedContact.appointments && selectedContact.appointments.length > 0 && (
                    <div className={styles.detailSection}>
                      <button
                        type="button"
                        className={`${styles.summaryCardButton} ${appointmentsExpanded ? styles.summaryCardButtonOpen : ''}`}
                        onClick={() => setAppointmentsExpanded(prev => !prev)}
                        aria-expanded={appointmentsExpanded}
                        data-contact-summary-trigger="appointments"
                      >
                        <div className={styles.summaryCardContent}>
                          <div>
                            <h5 className={styles.summaryTitle}>Citas</h5>
                            <p className={styles.summaryCount}>{selectedContact.appointments.length}</p>
                          </div>
                          <Icon
                            name={appointmentsExpanded ? 'chevron-down' : 'chevron-right'}
                            size={20}
                            className={styles.summaryCardChevron}
                          />
                        </div>
                      </button>

                      {appointmentsExpanded && (
                        <ul className={styles.paymentList} data-contact-summary-list="appointments">
                          {selectedContact.appointments.map(appointment => {
                            const statusInfo = getAppointmentStatusLabel(appointment.status)
                            const timeStr = new Date(appointment.start_time).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: timezone })

                            return (
                              <li key={appointment.id} className={styles.paymentItem}>
                                <div className={styles.paymentItemContent}>
                                  <div className={styles.paymentItemHeader}>
                                    <p className={styles.paymentAmount}>{appointment.title || 'Cita'}</p>
                                    <Badge variant={statusInfo.variant} className={styles.paymentStatus}>
                                      {statusInfo.text}
                                    </Badge>
                                  </div>
                                  <div className={styles.paymentItemDetails}>
                                    <span className={styles.paymentDetailItem}>
                                      <Icon name="calendar" size={12} />
                                      {formatLocalDateTime(appointment.start_time)}
                                    </span>
                                    <span className={styles.paymentDetailItem}>
                                      <Icon name="clock" size={12} />
                                      {timeStr}
                                    </span>
                                    <span className={styles.paymentDetailItem}>
                                      <Icon name="hash" size={12} />
                                      ID: {appointment.id.substring(0, 8)}...
                                    </span>
                                  </div>
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  )}

                  {/* COLUMNA DERECHA: Pagos */}
                  {payments.length > 0 && (
                    <div className={styles.detailSection}>
                      <button
                        type="button"
                        className={`${styles.summaryCardButton} ${paymentsExpanded ? styles.summaryCardButtonOpen : ''}`}
                        onClick={() => setPaymentsExpanded(prev => !prev)}
                        aria-expanded={paymentsExpanded}
                        data-contact-summary-trigger="payments"
                      >
                        <div className={styles.summaryCardContent}>
                          <div>
                            <h5 className={styles.summaryTitle}>Pagos</h5>
                            <p className={styles.summaryAmount}>{formatCurrency(payments.reduce((sum, payment) => sum + payment.amount, 0))}</p>
                          </div>
                          <Icon
                            name={paymentsExpanded ? 'chevron-down' : 'chevron-right'}
                            size={20}
                            className={styles.summaryCardChevron}
                          />
                        </div>
                      </button>

                      {paymentsExpanded && (
                        <ul className={styles.paymentList} data-contact-summary-list="payments">
                          {payments.map(payment => {
                            const statusInfo = getStatusLabel(payment.status)
                            return (
                              <li key={payment.id} className={styles.paymentItem}>
                                <div className={styles.paymentItemContent}>
                                  <div className={styles.paymentItemHeader}>
                                    <p className={styles.paymentAmount}>{formatCurrency(payment.amount)}</p>
                                    {payment.status && statusInfo.text && (
                                      <Badge variant={statusInfo.variant} className={styles.paymentStatus}>
                                        {statusInfo.text}
                                      </Badge>
                                    )}
                                  </div>
                                  <div className={styles.paymentItemDetails}>
                                    <span className={styles.paymentDetailItem}>
                                      <Icon name="calendar" size={12} />
                                      {formatLocalDateShort(payment.date)}
                                    </span>
                                    <span className={styles.paymentDetailItem}>
                                      <Icon name="hash" size={12} />
                                      ID: {payment.id.substring(0, 8)}...
                                    </span>
                                  </div>
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </div>

                {/* Reembolsos */}
                {refunds.length > 0 && (
                  <div className={styles.detailSection}>
                    <button
                      type="button"
                      className={styles.toggleButton}
                      onClick={() => setRefundsExpanded(prev => !prev)}
                    >
                      <div className={styles.toggleLabel}>
                        <Icon name={refundsExpanded ? 'chevron-down' : 'chevron-right'} size={16} />
                        <span>Reembolsos ({refunds.length})</span>
                      </div>
                      <span className={styles.toggleValue}>
                        {formatCurrency(refunds.reduce((sum, refund) => sum + Math.abs(refund.amount), 0))}
                      </span>
                    </button>

                    {refundsExpanded && (
                      <ul className={styles.paymentList}>
                        {refunds.map(refund => {
                          const statusInfo = getStatusLabel(refund.status)
                          return (
                            <li key={refund.id} className={styles.paymentItem}>
                              <div>
                                <p className={styles.paymentAmount}>{formatCurrency(Math.abs(refund.amount))}</p>
                                {refund.status && statusInfo.text && (
                                  <Badge variant={statusInfo.variant} className={styles.paymentStatus}>
                                    {statusInfo.text}
                                  </Badge>
                                )}
                              </div>
                              <span className={styles.paymentDate}>{formatLocalDateShort(refund.date)}</span>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                )}

                {/* Viaje del Cliente */}
                <div className={styles.detailSection}>
                  <ContactJourney contactId={selectedContact.id} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
