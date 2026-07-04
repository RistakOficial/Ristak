import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { KpiCard, Card, Button, Table, TableSelectionToolbar, DateRangePicker, PageContainer, PageHeader, TabList, Badge, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, ContactAvatar, ContactDetailsModal, Loading, CustomSelect, Modal } from '@/components/common'
import type { Column } from '@/components/common'
import {
  Users,
  User,
  DollarSign,
  TrendingUp,
  X,
  Pencil,
  Trash2,
  MoreVertical,
  Eye,
  Mail,
  Plus,
  MessageSquare,
  Workflow,
  Tags,
  ListPlus,
  SlidersHorizontal
} from 'lucide-react'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useUrlDateRangeSync } from '@/hooks'
import { formatCurrency, formatDateToISO, formatEndDateToISO, formatNumber, parseLocalDateString } from '@/utils/format'
import { parseSortableDateValue } from '@/utils/dateSort'
import { contactsService, type Contact, type ContactStats } from '@/services/contactsService'
import { contactTagsService, type ContactTag } from '@/services/contactTagsService'
import { whatsappApiService, type WhatsAppApiPhoneNumber } from '@/services/whatsappApiService'
import { calendarsService, type CalendarEvent } from '@/services/calendarsService'
import type { ContactAppointment, ContactCustomField, ContactCustomFieldDefinition, ContactPayment, ContactPhoneNumber } from '@/types'
import { useNotification } from '@/contexts/NotificationContext'
import { useAuth } from '@/contexts/AuthContext'
import styles from './Contacts.module.css'
import { getContactDisplayName } from '@/utils/contactAvatar'
import { getContactStageBadge, isAttendedAppointmentStatus } from '@/utils/contactStageBadge'
import {
  formatContactCustomFieldDisplayValue,
  getContactCustomFieldDisplayLabel,
  getContactCustomFieldKeys
} from '@/utils/contactCustomFields'
import {
  COUNTRY_OPTIONS,
  composePhoneWithDialCode,
  getCountryDefaults,
  getCountryFlagEmoji,
  getDetectedAccountLocaleDefaults,
  getPhoneInputParts
} from '@/utils/accountLocale'
import { ContactBulkActionModals } from './ContactBulkActionModals'
import { ContactBulkActionProgress } from './ContactBulkActionProgress'
import { ContactBulkPropertyModals } from './ContactBulkPropertyModals'
import { ContactAdvancedFiltersModal } from './ContactAdvancedFiltersModal'
import {
  CONTACT_ADVANCED_FILTERS_URL_PARAM,
  countContactAdvancedRules,
  createDefaultContactAdvancedConfig,
  hasActiveContactAdvancedConfig,
  normalizeContactAdvancedConfig,
  parseContactAdvancedConfig,
  serializeContactAdvancedConfig,
  type ContactAdvancedFilterConfig
} from './contactAdvancedFilters'

const APPOINTMENT_CANCELED_STATUSES = new Set([
  'cancelled',
  'canceled',
  'no_show',
  'noshow',
  'invalid',
  'failed',
  'missed',
  'deleted',
  'void',
  'voided'
])
const REVENUE_PAYMENT_STATUSES = new Set(['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'])
const DELETE_CONFIRMATION_WORD = 'ELIMINAR'
const CONTACTS_PAGE_SIZE = 100
const MAX_CONTACTS_BACKGROUND_PAGES = 100
type ContactViewMode = 'all' | 'by-date'
const contactViewModes: ContactViewMode[] = ['all', 'by-date']
const contactFilters = ['all', 'leads', 'appointments', 'attendances', 'customers']
const isContactViewMode = (value?: string): value is ContactViewMode => contactViewModes.includes(value as ContactViewMode)
const isContactFilter = (value?: string) => Boolean(value && contactFilters.includes(value))
const CUSTOM_FIELD_COLUMN_PREFIX = 'custom-field:'
const LEGACY_TRACKING_FILTERS_URL_PARAM = 'filters'

interface ContactCustomFieldColumnSpec {
  columnKey: string
  label: string
  matchKeySet: Set<string>
}

const parseContactsRoute = (pathname: string) => {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const contactsIndex = segments.indexOf('contacts')
  const routeSegments = contactsIndex >= 0 ? segments.slice(contactsIndex + 1) : []
  const first = routeSegments[0]

  if (first === 'new') {
    return { viewMode: 'all' as ContactViewMode, filter: 'all', contactId: '', editContactId: '', create: true }
  }

  const editIndex = routeSegments.indexOf('edit')
  if (editIndex > 0) {
    return {
      viewMode: 'all' as ContactViewMode,
      filter: 'all',
      contactId: '',
      editContactId: decodeURIComponent(routeSegments[editIndex - 1]),
      create: false
    }
  }

  const viewMode = isContactViewMode(first) ? first : 'all'
  const filter = isContactFilter(routeSegments[1]) ? routeSegments[1] : 'all'
  const contactId = routeSegments[2] ? decodeURIComponent(routeSegments[2]) : ''

  return { viewMode, filter, contactId, editContactId: '', create: false }
}

const buildContactsPath = (viewMode: ContactViewMode, filter: string) => `/contacts/${viewMode}/${filter}`
const buildContactDetailPath = (viewMode: ContactViewMode, filter: string, contactId: string) =>
  `${buildContactsPath(viewMode, filter)}/${encodeURIComponent(contactId)}`

const ContactPhoneField: React.FC<{ defaultValue?: string; autoFocus?: boolean }> = ({ defaultValue = '', autoFocus = false }) => {
  const detected = useMemo(() => getDetectedAccountLocaleDefaults(), [])
  const initialParts = useMemo(() => getPhoneInputParts(defaultValue, detected.countryCode), [defaultValue, detected.countryCode])
  const [countryCode, setCountryCode] = useState(initialParts.countryCode)
  const [phoneNumber, setPhoneNumber] = useState(initialParts.nationalNumber)
  const country = getCountryDefaults(countryCode)
  const composedPhone = composePhoneWithDialCode(phoneNumber, country.dialCode)

  return (
    <div className={styles.phoneCountryField}>
      <input type="hidden" name="phone" value={composedPhone} />
      <CustomSelect
        value={country.value}
        onChange={(event) => setCountryCode(event.target.value)}
        aria-label="País y lada"
      >
        {COUNTRY_OPTIONS.map(option => (
          <option key={option.value} value={option.value}>
            {getCountryFlagEmoji(option.value)} +{option.dialCode} {option.label}
          </option>
        ))}
      </CustomSelect>
      <input
        type="tel"
        inputMode="tel"
        autoFocus={autoFocus}
        placeholder="Número"
        value={phoneNumber}
        onChange={(event) => setPhoneNumber(event.target.value)}
      />
    </div>
  )
}

const getAppointmentStatusValue = (appointment: { appointment_status?: string | null; appointmentStatus?: string | null; status?: string | null }) =>
  String(appointment.appointment_status || appointment.appointmentStatus || appointment.status || '').trim().toLowerCase()

const isActiveAppointment = (appointment: { appointment_status?: string | null; appointmentStatus?: string | null; status?: string | null }) => {
  const statusValue = getAppointmentStatusValue(appointment)
  return !statusValue || !APPOINTMENT_CANCELED_STATUSES.has(statusValue)
}

const isRevenuePayment = (payment: ContactPayment) => {
  const status = String(payment.status || '').trim().toLowerCase()
  const paymentMode = payment.paymentMode || payment.payment_mode || 'live'
  return Number(payment.amount || 0) > 0 && paymentMode !== 'test' && REVENUE_PAYMENT_STATUSES.has(status)
}

const summarizeRevenuePayments = (payments: ContactPayment[] = []) => {
  return payments.reduce(
    (summary, payment) => {
      if (!isRevenuePayment(payment)) return summary

      const amount = Number(payment.amount || 0)
      const timestamp = payment.date ? parseSortableDateValue(payment.date) : Number.NaN

      return {
        purchases: summary.purchases + 1,
        ltv: summary.ltv + amount,
        lastPurchase:
          !Number.isNaN(timestamp) && timestamp > summary.lastPurchaseTimestamp
            ? payment.date
            : summary.lastPurchase,
        lastPurchaseTimestamp:
          !Number.isNaN(timestamp) && timestamp > summary.lastPurchaseTimestamp
            ? timestamp
            : summary.lastPurchaseTimestamp
      }
    },
    {
      purchases: 0,
      ltv: 0,
      lastPurchase: null as string | null,
      lastPurchaseTimestamp: Number.NEGATIVE_INFINITY
    }
  )
}

const STATUS_PRIORITY: Record<Contact['status'], number> = {
  lead: 0,
  appointment: 1,
  customer: 2
}

const getCustomFieldIdentity = (field: ContactCustomField, index: number) =>
  field.id || field.key || field.fieldKey || field.label || field.name || `custom-field-${index}`

const cleanColumnValue = (value: unknown) => String(value ?? '').trim()

const renderContactAvatar = (contact: Contact, className: string) => {
  return <ContactAvatar contact={contact} className={className} />
}

const createTagLabelMap = (tags: Array<{ id?: string; name?: string }>) => {
  const labels: Record<string, string> = {}

  tags.forEach((tag) => {
    const id = cleanColumnValue(tag.id)
    const name = cleanColumnValue(tag.name)
    if (!name) return
    if (id) labels[id] = name
    labels[name] = name
  })

  return labels
}

const getContactTagLabels = (tagIds: string[] | undefined, tagLabelMap: Record<string, string>) => {
  if (!Array.isArray(tagIds)) return []

  return tagIds
    .map((tagId) => {
      const cleanTagId = cleanColumnValue(tagId)
      if (!cleanTagId) return ''
      return tagLabelMap[cleanTagId] || contactTagsService.getDisplayName(cleanTagId, {
        fallback: cleanTagId,
        includeSystem: true
      })
    })
    .filter(Boolean)
}

const getCustomFieldColumnLabel = (
  field: ContactCustomField | ContactCustomFieldDefinition,
  index: number
) => {
  const baseLabel = getContactCustomFieldDisplayLabel(field, index)
  const folderName = cleanColumnValue((field as ContactCustomFieldDefinition).folderName)
  return folderName ? `${baseLabel} · ${folderName}` : baseLabel
}

const shouldExposeCustomFieldColumn = (field: ContactCustomField | ContactCustomFieldDefinition) =>
  !Boolean((field as ContactCustomFieldDefinition).archived) &&
  (field.sourceType || '') !== 'system'

const findContactCustomField = (contact: Contact, matchKeySet: Set<string>) =>
  (contact.customFields || []).find((field) =>
    getContactCustomFieldKeys(field).some((key) => matchKeySet.has(key))
  )

const mergeCustomFields = (baseFields: ContactCustomField[] = [], nextFields: ContactCustomField[] = []) => {
  const fieldMap = new Map<string, ContactCustomField>()

  baseFields.forEach((field, index) => {
    fieldMap.set(getCustomFieldIdentity(field, index), field)
  })

  nextFields.forEach((field, index) => {
    const identity = getCustomFieldIdentity(field, index)
    fieldMap.set(identity, {
      ...(fieldMap.get(identity) || {}),
      ...field
    })
  })

  return Array.from(fieldMap.values())
}

const mergeContactPhoneNumbers = (contacts: Contact[], primaryPhone?: string | null): ContactPhoneNumber[] => {
  const byPhone = new Map<string, ContactPhoneNumber>()
  const normalizedPrimaryPhone = String(primaryPhone || '').trim()

  const addPhone = (entry?: ContactPhoneNumber | null) => {
    const phone = String(entry?.phone || '').trim()
    if (!phone) return

    const existing = byPhone.get(phone)
    const entryIsPrimary = Boolean(entry?.isPrimary || entry?.is_primary)
    const nextIsPrimary = Boolean(existing?.isPrimary || existing?.is_primary || entryIsPrimary)

    byPhone.set(phone, {
      ...(existing || {}),
      ...(entry || {}),
      id: entry?.id || existing?.id || phone,
      phone,
      label: entry?.label || existing?.label,
      isPrimary: nextIsPrimary,
      is_primary: nextIsPrimary
    })
  }

  contacts.forEach(contact => {
    if (contact.phone) {
      addPhone({
        id: `${contact.id}-primary-phone`,
        phone: contact.phone,
        label: 'Principal',
        isPrimary: contact.phone === normalizedPrimaryPhone
      })
    }
    contact.phones?.forEach(addPhone)
    contact.phoneNumbers?.forEach(addPhone)
  })

  let fallbackPrimaryAssigned = false
  return Array.from(byPhone.values())
    .map((phoneEntry) => {
      const isPrimary = normalizedPrimaryPhone
        ? phoneEntry.phone === normalizedPrimaryPhone
        : !fallbackPrimaryAssigned && Boolean(phoneEntry.isPrimary || phoneEntry.is_primary)
      if (isPrimary) fallbackPrimaryAssigned = true
      const label = isPrimary
        ? 'Principal'
        : phoneEntry.label && phoneEntry.label !== 'Principal'
          ? phoneEntry.label
          : 'Adicional'

      return {
        ...phoneEntry,
        label,
        isPrimary,
        is_primary: isPrimary
      }
    })
    .sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1
      return parseSortableDateValue(left.createdAt) - parseSortableDateValue(right.createdAt)
    })
}

const mergeContactDetailRecords = (
  baseContact: Contact | null,
  detailContacts: Contact[],
  primaryId: string | null
): Contact => {
  const allContacts = baseContact ? [baseContact, ...detailContacts] : [...detailContacts]
  const template = allContacts[0]
  const hasAuthoritativeDetails = detailContacts.length > 0
  const authoritativeContactIds = new Set(detailContacts.map(contact => contact.id).filter(Boolean))

  const merged: Contact = {
    ...(template ?? {} as Contact),
    id: primaryId ?? template?.id ?? '',
    firstAppointmentDate: template?.firstAppointmentDate ?? null,
    nextAppointmentDate: template?.nextAppointmentDate ?? null,
    purchases: template?.purchases ?? 0,
    ltv: template?.ltv ?? 0,
    appointments: template?.appointments ? [...template.appointments] : [],
    payments: template?.payments ? [...template.payments] : undefined
  }

  const mergedIds = new Set<string>()
  if (primaryId) mergedIds.add(primaryId)
  if (baseContact?.mergedContactIds) {
    baseContact.mergedContactIds.forEach(id => id && mergedIds.add(id))
  }
  if (template?.mergedContactIds) {
    template.mergedContactIds.forEach(id => id && mergedIds.add(id))
  }

  let latestPurchaseTimestamp = merged.lastPurchase ? parseSortableDateValue(merged.lastPurchase) : Number.NEGATIVE_INFINITY

  const paymentMap = new Map<string, ContactPayment>()
  merged.payments?.forEach(payment => {
    if (!payment) return
    const key = payment.id ?? `${payment.date}-${payment.amount}-${payment.status ?? ''}`
    paymentMap.set(key, payment)
  })

  const appointmentMap = new Map<string, ContactAppointment>()
  merged.appointments?.forEach(appointment => {
    if (!appointment) return
    const key = appointment.id ?? `${appointment.start_time}-${appointment.title ?? ''}`
    appointmentMap.set(key, appointment)
    if (isAttendedAppointmentStatus(appointment.appointment_status || appointment.status)) {
      merged.hasShowedAppointment = true
      merged.hasAttendedAppointment = true
    }
  })

  const getStatusPriority = (status?: Contact['status']) => status ? STATUS_PRIORITY[status] ?? 0 : 0

  for (const contact of allContacts) {
    if (!contact) continue

    if (contact.id) mergedIds.add(contact.id)
    contact.mergedContactIds?.forEach(id => id && mergedIds.add(id))

    if (!merged.name && contact.name) merged.name = contact.name
    if (!merged.email && contact.email) merged.email = contact.email
    if (!merged.phone && contact.phone) merged.phone = contact.phone
    if (!merged.profilePhotoUrl && contact.profilePhotoUrl) merged.profilePhotoUrl = contact.profilePhotoUrl
    if (!merged.avatarUrl && contact.avatarUrl) merged.avatarUrl = contact.avatarUrl
    if (!merged.photoUrl && contact.photoUrl) merged.photoUrl = contact.photoUrl
    if (!merged.pictureUrl && contact.pictureUrl) merged.pictureUrl = contact.pictureUrl
    if (!merged.profile_picture_url && contact.profile_picture_url) merged.profile_picture_url = contact.profile_picture_url
    if (!merged.source && contact.source) merged.source = contact.source
    if (!merged.attribution_session_source && contact.attribution_session_source) merged.attribution_session_source = contact.attribution_session_source
    if (!merged.whatsappAttributionPlatform && contact.whatsappAttributionPlatform) merged.whatsappAttributionPlatform = contact.whatsappAttributionPlatform
    if (!merged.attribution_medium && contact.attribution_medium) merged.attribution_medium = contact.attribution_medium
    if (!merged.firstSession && contact.firstSession) merged.firstSession = contact.firstSession
    if (!merged.metaAttribution && contact.metaAttribution) merged.metaAttribution = contact.metaAttribution
    if (contact.metaAttribution?.adName) merged.ad_name = contact.metaAttribution.adName
    if (!merged.ad_name && contact.ad_name) merged.ad_name = contact.ad_name
    if (contact.metaAttribution?.adId) merged.ad_id = contact.metaAttribution.adId
    if (!merged.ad_id && contact.ad_id) merged.ad_id = contact.ad_id
    merged.customFields = mergeCustomFields(merged.customFields, contact.customFields)

    if (!hasAuthoritativeDetails) {
      merged.purchases = Math.max(merged.purchases ?? 0, contact.purchases ?? 0)
      merged.ltv = Math.max(merged.ltv ?? 0, contact.ltv ?? 0)
    }

    merged.hasShowedAppointment = Boolean(merged.hasShowedAppointment || contact.hasShowedAppointment)
    merged.hasAttendedAppointment = Boolean(merged.hasAttendedAppointment || contact.hasAttendedAppointment)

    const canUseContactStatus = !hasAuthoritativeDetails || authoritativeContactIds.has(contact.id)
    if (canUseContactStatus && getStatusPriority(contact.status) > getStatusPriority(merged.status)) {
      merged.status = contact.status ?? merged.status
    }

    if ((!hasAuthoritativeDetails || authoritativeContactIds.has(contact.id)) && contact.lastPurchase) {
      const ts = parseSortableDateValue(contact.lastPurchase)
      if (ts > latestPurchaseTimestamp) {
        latestPurchaseTimestamp = ts
        merged.lastPurchase = contact.lastPurchase
      }
    }

    contact.payments?.forEach(payment => {
      if (!payment) return
      const key = payment.id ?? `${payment.date}-${payment.amount}-${payment.status ?? ''}`
      if (!paymentMap.has(key)) {
        paymentMap.set(key, payment)
      }
    })

    contact.appointments?.forEach(appointment => {
      if (!appointment) return
      const key = appointment.id ?? `${appointment.start_time}-${appointment.title ?? ''}`
      if (!appointmentMap.has(key)) {
        appointmentMap.set(key, appointment)
      }
      if (isAttendedAppointmentStatus(appointment.appointment_status || appointment.status)) {
        merged.hasShowedAppointment = true
        merged.hasAttendedAppointment = true
      }
    })
  }

  const appointments = Array.from(appointmentMap.values()).sort((a, b) =>
    parseSortableDateValue(a.start_time) - parseSortableDateValue(b.start_time)
  )
  const activeAppointments = appointments.filter(isActiveAppointment)

  merged.appointments = appointments
  if (activeAppointments.length > 0) {
    merged.firstAppointmentDate = activeAppointments[0].start_time
  } else {
    merged.firstAppointmentDate = appointments.length > 0 ? null : (baseContact?.firstAppointmentDate ?? merged.firstAppointmentDate ?? null)
  }

  const now = Date.now()
  const upcomingAppointment = appointments.find(appointment => {
    const start = parseSortableDateValue(appointment.start_time)
    if (!start || start < now) {
      return false
    }
    return isActiveAppointment(appointment)
  })

  merged.nextAppointmentDate = upcomingAppointment
    ? upcomingAppointment.start_time
    : baseContact?.nextAppointmentDate ?? null

  const payments = Array.from(paymentMap.values()).filter(payment =>
    String(payment.status || '').trim().toLowerCase() !== 'deleted'
  )
  merged.payments = payments.length > 0 ? payments : undefined

  if (hasAuthoritativeDetails) {
    const paymentSummary = summarizeRevenuePayments(payments)
    merged.purchases = paymentSummary.purchases
    merged.ltv = paymentSummary.ltv
    merged.lastPurchase = paymentSummary.lastPurchase ?? undefined
    merged.status = paymentSummary.purchases > 0
      ? 'customer'
      : activeAppointments.length > 0
        ? 'appointment'
        : 'lead'
  }

  merged.mergedContactIds = Array.from(mergedIds).filter(id => id && id !== merged.id)
  const mergedPhones = mergeContactPhoneNumbers(allContacts, merged.phone)
  if (mergedPhones.length > 0) {
    merged.phone = merged.phone || mergedPhones[0].phone
    merged.phones = mergedPhones
    merged.phoneNumbers = mergedPhones
  }

  return merged
}

const ContactsTable: React.FC = () => {
  const { dateRange, setDateRange } = useDateRange()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const routeState = useMemo(() => parseContactsRoute(location.pathname), [location.pathname])
  const { showToast, showConfirm } = useNotification()
  const { labels } = useLabels()
  const { formatLocalDateShort } = useTimezone()
  const { locationId, accessToken } = useAuth()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [stats, setStats] = useState<ContactStats | null>(null)
  const [filter, setFilter] = useState(routeState.filter)
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [selectedContactDetails, setSelectedContactDetails] = useState<Contact | null>(null)
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [contactDetailsLoading, setContactDetailsLoading] = useState(false)
  const [showNewContactModal, setShowNewContactModal] = useState(false)
  const [editingContact, setEditingContact] = useState<Contact | null>(null)
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([])
  const [contactsPendingDeletion, setContactsPendingDeletion] = useState<Contact[]>([])
  const [whatsappPhoneNumbers, setWhatsappPhoneNumbers] = useState<WhatsAppApiPhoneNumber[]>([])
  const [contactDeleteConfirmation, setContactDeleteConfirmation] = useState('')
  // (CNT-001) Confirmación de fusión cuando al editar el teléfono/email choca con otro contacto.
  const [mergeConfirm, setMergeConfirm] = useState<{
    contactId: string
    updates: { full_name: string; email: string; phone: string; source: string }
    conflict: { field: string; contact: { id: string; full_name?: string | null; phone?: string | null; email?: string | null } }
  } | null>(null)
  const [mergeSaving, setMergeSaving] = useState(false)
  // (CNT-007) Papelera de contactos.
  const [trashOpen, setTrashOpen] = useState(false)
  const [trashedContacts, setTrashedContacts] = useState<Array<{ id: string; full_name?: string | null; email?: string | null; phone?: string | null; total_paid?: number }>>([])
  const [trashLoading, setTrashLoading] = useState(false)
  const [trashActingId, setTrashActingId] = useState<string | null>(null)
  const [showBulkTagsModal, setShowBulkTagsModal] = useState(false)
  const [showBulkCustomFieldsModal, setShowBulkCustomFieldsModal] = useState(false)
  const [showBulkWhatsAppModal, setShowBulkWhatsAppModal] = useState(false)
  const [showBulkAutomationModal, setShowBulkAutomationModal] = useState(false)
  const [deletingContacts, setDeletingContacts] = useState(false)
  // (CNT-011) Progreso (X de N) y cancelación del borrado masivo secuencial.
  const [deleteProgress, setDeleteProgress] = useState(0)
  const deleteCancelRef = useRef(false)
  const [loading, setLoading] = useState(false)
  const [loadingEvents, setLoadingEvents] = useState(false) // Loading específico para eventos de calendarios
  const [viewMode, setViewMode] = useState<ContactViewMode>(routeState.viewMode)
  const [isClient, setIsClient] = useState(false)
  const [allEvents, setAllEvents] = useState<CalendarEvent[]>([]) // Eventos de calendarios
  const [contactTagLabels, setContactTagLabels] = useState<Record<string, string>>(() => {
    const cachedTags = contactTagsService.getCachedTags({ includeSystem: true }) || contactTagsService.getCachedTags()
    return cachedTags ? createTagLabelMap(cachedTags) : {}
  })
  const [contactTags, setContactTags] = useState<ContactTag[]>(() => {
    return contactTagsService.getCachedTags({ includeSystem: true }) || contactTagsService.getCachedTags() || []
  })
  const [customFieldDefinitions, setCustomFieldDefinitions] = useState<ContactCustomFieldDefinition[]>([])
  const [hasLoadedContacts, setHasLoadedContacts] = useState(false)
  const [contactSearchTerm, setContactSearchTerm] = useState('')
  const [debouncedContactSearch, setDebouncedContactSearch] = useState('')
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false)
  const [advancedFilterConfig, setAdvancedFilterConfig] = useState<ContactAdvancedFilterConfig>(() =>
    parseContactAdvancedConfig(searchParams.get(CONTACT_ADVANCED_FILTERS_URL_PARAM))
  )
  const handledOpenContactRef = useRef<string | null>(null)
  const fetchRequestRef = useRef(0)

  const navigateContactsPath = useCallback((pathname: string, options?: { replace?: boolean }) => {
    navigate({ pathname, search: location.search }, options)
  }, [location.search, navigate])

  const advancedFilterRuleCount = useMemo(
    () => countContactAdvancedRules(advancedFilterConfig),
    [advancedFilterConfig]
  )
  const advancedFiltersActive = useMemo(
    () => hasActiveContactAdvancedConfig(advancedFilterConfig),
    [advancedFilterConfig]
  )

  const writeAdvancedFiltersToUrl = useCallback((nextConfig: ContactAdvancedFilterConfig) => {
    const normalized = normalizeContactAdvancedConfig(nextConfig)
    setAdvancedFilterConfig(normalized)

    const nextParams = new URLSearchParams(searchParams)
    const serialized = serializeContactAdvancedConfig(normalized)
    if (serialized) {
      nextParams.set(CONTACT_ADVANCED_FILTERS_URL_PARAM, serialized)
    } else {
      nextParams.delete(CONTACT_ADVANCED_FILTERS_URL_PARAM)
    }
    setSearchParams(nextParams, { replace: true })
  }, [searchParams, setSearchParams])

  const applyAdvancedFilters = useCallback((nextConfig: ContactAdvancedFilterConfig) => {
    writeAdvancedFiltersToUrl(nextConfig)
    setAdvancedFiltersOpen(false)
  }, [writeAdvancedFiltersToUrl])

  const resetAdvancedFilters = useCallback(() => {
    writeAdvancedFiltersToUrl(createDefaultContactAdvancedConfig())
  }, [writeAdvancedFiltersToUrl])

  useEffect(() => {
    if (!searchParams.has(LEGACY_TRACKING_FILTERS_URL_PARAM)) return
    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete(LEGACY_TRACKING_FILTERS_URL_PARAM)
    setSearchParams(nextParams, { replace: true })
  }, [searchParams, setSearchParams])

  useUrlDateRangeSync({
    dateRange,
    setDateRange,
    enabled: viewMode === 'by-date'
  })

  const openContactModal = (contact: Contact) => {
    setSelectedContact(contact)
    setSelectedContactDetails(null)
    setSelectedContactId(contact.id)
    setContactDetailsLoading(true)
    navigateContactsPath(buildContactDetailPath(viewMode, filter, contact.id))
  }

  const closeContactModal = () => {
    setSelectedContact(null)
    setSelectedContactId(null)
    setContactDetailsLoading(false)
    setSelectedContactDetails(null)
    navigateContactsPath(buildContactsPath(viewMode, filter), { replace: true })
  }

  useEffect(() => {
    const openType = searchParams.get('open')
    const legacyContactId = openType === 'contact' ? searchParams.get('id') : ''
    const contactId = routeState.contactId || legacyContactId

    if (!contactId) {
      handledOpenContactRef.current = null
      return
    }

    if (handledOpenContactRef.current === contactId) {
      return
    }

    let isMounted = true

    const clearOpenParams = () => {
      if (!legacyContactId) return
      const nextParams = new URLSearchParams(searchParams)
      nextParams.delete('open')
      nextParams.delete('id')
      setSearchParams(nextParams, { replace: true })
    }

    const openContactFromSearch = async () => {
      try {
        const contact = contacts.find((item) => item.id === contactId) ?? await contactsService.getContactDetails(contactId)

        if (!isMounted) return

        handledOpenContactRef.current = contactId
        setSelectedContact(contact)
        setSelectedContactDetails(null)
        setSelectedContactId(contact.id)
        setContactDetailsLoading(true)
      } catch {
        if (isMounted) {
          showToast('error', 'No se pudo abrir el contacto', 'El resultado existe, pero no se pudo cargar el detalle.')
        }
      } finally {
        if (isMounted) {
          clearOpenParams()
        }
      }
    }

    openContactFromSearch()

    return () => {
      isMounted = false
    }
  }, [contacts, routeState.contactId, searchParams, setSearchParams, showToast])

  useEffect(() => {
    setViewMode(current => current === routeState.viewMode ? current : routeState.viewMode)
    setFilter(current => current === routeState.filter ? current : routeState.filter)

    if (!routeState.contactId && selectedContact) {
      setSelectedContact(null)
      setSelectedContactId(null)
      setContactDetailsLoading(false)
      setSelectedContactDetails(null)
    }
  }, [routeState.contactId, routeState.filter, routeState.viewMode, selectedContact])

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedContactSearch(contactSearchTerm.trim())
    }, 300)
    return () => window.clearTimeout(handle)
  }, [contactSearchTerm])

  useEffect(() => {
    fetchData()
  }, [dateRange, viewMode, debouncedContactSearch, filter, advancedFilterConfig])

  useEffect(() => {
    setShowNewContactModal(routeState.create)
  }, [routeState.create])

  useEffect(() => {
    const contactId = routeState.editContactId
    if (!contactId) {
      if (editingContact) setEditingContact(null)
      return
    }

    let mounted = true
    const existingContact = contacts.find(contact => contact.id === contactId)
    if (existingContact) {
      setEditingContact(existingContact)
      return () => {
        mounted = false
      }
    }

    contactsService.getContactDetails(contactId)
      .then(contact => {
        if (mounted) setEditingContact(contact)
      })
      .catch(() => {
        if (mounted) showToast('error', 'No se pudo abrir el contacto', 'No se pudo cargar la información para editar.')
      })

    return () => {
      mounted = false
    }
  }, [contacts, editingContact, routeState.editContactId, showToast])

  useEffect(() => {
    let cancelled = false

    whatsappApiService.getStatus()
      .then((status) => {
        if (!cancelled) {
          setWhatsappPhoneNumbers(status.connected ? status.phoneNumbers || [] : [])
        }
      })
      .catch(() => {
        if (!cancelled) setWhatsappPhoneNumbers([])
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setIsClient(true)
  }, [])

  useEffect(() => {
    let cancelled = false

    contactTagsService.getTags({ includeSystem: true })
      .then((tags) => {
        if (!cancelled) {
          const list = Array.isArray(tags) ? tags : []
          setContactTags(list)
          setContactTagLabels(createTagLabelMap(list))
        }
      })
      .catch(() => {
        // Las etiquetas siguen mostrándose con el valor guardado si el catálogo no carga.
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const nextConfig = parseContactAdvancedConfig(searchParams.get(CONTACT_ADVANCED_FILTERS_URL_PARAM))
    setAdvancedFilterConfig(current => {
      const currentSerialized = serializeContactAdvancedConfig(current)
      const nextSerialized = serializeContactAdvancedConfig(nextConfig)
      return currentSerialized === nextSerialized ? current : nextConfig
    })
  }, [searchParams])

  useEffect(() => {
    let cancelled = false

    contactsService.getCustomFieldDefinitions()
      .then((definitions) => {
        if (cancelled) return
        const activeDefinitions = Array.isArray(definitions)
          ? definitions.filter((field) => !field.archived && field.sourceType !== 'system')
          : []
        setCustomFieldDefinitions(activeDefinitions)
      })
      .catch(() => {
        if (!cancelled) setCustomFieldDefinitions([])
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (selectedContactIds.length === 0) return

    const availableIds = new Set(contacts.map(contact => contact.id))
    const nextSelectedIds = selectedContactIds.filter(id => availableIds.has(id))

    if (nextSelectedIds.length !== selectedContactIds.length) {
      setSelectedContactIds(nextSelectedIds)
    }
  }, [contacts, selectedContactIds])

  // Cargar eventos de calendarios cuando se activa el filtro "Citados" o "Asistencias".
  // No depende de HighLevel: el backend sirve las citas locales aunque no haya GHL.
  useEffect(() => {
    if (!['appointments', 'attendances'].includes(filter)) {
      setAllEvents([])
      setLoadingEvents(false)
      return
    }

    let cancelled = false

    const loadAllEvents = async () => {
      setLoadingEvents(true)
      try {
        const now = new Date()
        const past = new Date(now)
        past.setFullYear(now.getFullYear() - 1)
        const future = new Date(now)
        future.setFullYear(now.getFullYear() + 1)

        // Mantener estos rangos acotados evita que el filtro de contactos intente
        // cargar décadas de citas cuando solo necesita apoyo reciente/futuro.
        const [calendars, pastEvents, futureEvents] = await Promise.all([
          calendarsService.getCalendars(locationId, accessToken),
          calendarsService.getEvents(
            locationId || '',
            past.getTime(),
            now.getTime(),
            accessToken || undefined
          ),
          calendarsService.getEvents(
            locationId || '',
            now.getTime(),
            future.getTime(),
            accessToken || undefined
          )
        ])

        if (cancelled) return

        const events = Array.from(
          new Map([...pastEvents, ...futureEvents].map((event, index) => [event.id || `event-${index}`, event])).values()
        )

        const inactiveCalendarIds = new Set(
          calendars.filter(calendar => !calendar.isActive).map(calendar => calendar.id)
        )
        setAllEvents(events.filter(event => !inactiveCalendarIds.has(event.calendarId)))
      } catch (error) {
        // Error silencioso - el filtro seguirá funcionando con datos locales
      } finally {
        if (!cancelled) setLoadingEvents(false)
      }
    }

    loadAllEvents()

    return () => {
      cancelled = true
    }
  }, [filter, locationId, accessToken])

  useEffect(() => {
    if (!selectedContactId) return

    let isMounted = true

    const targetIds = Array.from(
      new Set(
        [selectedContactId, ...(selectedContact?.mergedContactIds ?? [])].filter(
          (id): id is string => Boolean(id)
        )
      )
    )

    const loadContactDetails = async () => {
      try {
        const results = await Promise.all(
          targetIds.map(async (id) => {
            try {
              return await contactsService.getContactDetails(id)
            } catch (error) {
              if (id === selectedContactId) {
                throw error
              }
              return null
            }
          })
        )

        if (!isMounted) {
          return
        }

        const validResults = results.filter((contact): contact is Contact => Boolean(contact))

        if (validResults.length === 0) {
          setSelectedContactDetails(selectedContact ?? null)
          return
        }

        const mergedDetails = mergeContactDetailRecords(selectedContact ?? null, validResults, selectedContactId)
        setSelectedContactDetails(mergedDetails)
      } catch (error) {
        if (isMounted) {
          setSelectedContactDetails(selectedContact ?? null)
          showToast('error', 'No se pudieron cargar los detalles del contacto', 'Intenta nuevamente.')
        }
      } finally {
        if (isMounted) {
          setContactDetailsLoading(false)
        }
      }
    }

    loadContactDetails()

    return () => {
      isMounted = false
    }
  }, [selectedContactId, selectedContact, showToast])

  const contactData = selectedContactDetails ?? selectedContact

  const contactAppointments = useMemo(() => {
    if (!contactData?.appointments) return []
    return [...contactData.appointments].sort((a, b) =>
      parseSortableDateValue(a.start_time) - parseSortableDateValue(b.start_time)
    )
  }, [contactData?.appointments])

  const contactPayments = useMemo(() => {
    if (!contactData?.payments) return []
    return [...contactData.payments].sort((a, b) => {
      const dateA = parseSortableDateValue(a?.date)
      const dateB = parseSortableDateValue(b?.date)
      return dateB - dateA
    })
  }, [contactData?.payments])

  const modalSubtitle = useMemo(() => {
    if (!contactData) return undefined
    const parts: string[] = []
    if (contactData.email) parts.push(contactData.email)
    if (contactData.phone) parts.push(contactData.phone)
    return parts.length > 0 ? parts.join(' · ') : undefined
  }, [contactData?.email, contactData?.phone])

  const modalData = useMemo(() => {
    if (!contactData) return []

    const createdAt = contactData.createdAt ?? new Date().toISOString()

    const payments = contactPayments.length > 0
      ? contactPayments.map((payment, index) => ({
        id: String(payment.id ?? `${contactData.id}-payment-${index}`),
        amount: Number(payment.amount ?? 0),
        status: payment.status ?? undefined,
        date: payment.date ?? createdAt
      }))
      : undefined

    const appointments = contactAppointments.length > 0
      ? contactAppointments.map((appointment, index) => ({
        id: String(appointment.id ?? `${contactData.id}-appointment-${index}`),
        title: appointment.title ?? null,
        status: appointment.appointment_status ?? appointment.status ?? null,
        start_time: appointment.start_time
      }))
      : undefined

    return [{
      id: contactData.id,
      name: contactData.name,
      email: contactData.email,
      phone: contactData.phone,
      profilePhotoUrl: contactData.profilePhotoUrl,
      avatarUrl: contactData.avatarUrl,
      photoUrl: contactData.photoUrl,
      pictureUrl: contactData.pictureUrl,
      profile_picture_url: contactData.profile_picture_url,
      created_at: createdAt,
      phones: contactData.phones || contactData.phoneNumbers || [],
      phoneNumbers: contactData.phoneNumbers || contactData.phones || [],
      ltv: contactData.ltv,
      purchases: contactData.purchases,
      payments,
      appointments,
      firstAppointmentDate: contactData.firstAppointmentDate,
      nextAppointmentDate: contactData.nextAppointmentDate,
      hasAppointments: contactData.hasAppointments ?? contactAppointments.length > 0,
      hasShowedAppointment: contactData.hasShowedAppointment,
      hasAttendedAppointment: contactData.hasAttendedAppointment,
      status: contactData.status,
      source: contactData.source,
      attribution_session_source: contactData.attribution_session_source,
      whatsappAttributionPlatform: contactData.whatsappAttributionPlatform,
      attribution_medium: contactData.attribution_medium,
      firstSession: contactData.firstSession || null,
      metaAttribution: contactData.metaAttribution || null,
      ad_name: contactData.ad_name,
      ad_id: contactData.ad_id,
      preferredWhatsAppPhoneNumberId: contactData.preferredWhatsAppPhoneNumberId || contactData.preferred_whatsapp_phone_number_id || '',
      preferred_whatsapp_phone_number_id: contactData.preferred_whatsapp_phone_number_id || contactData.preferredWhatsAppPhoneNumberId || '',
      customFields: contactData.customFields || [],
      tags: contactData.tags || []
    }]
  }, [contactAppointments, contactData, contactPayments])

  const handleUpdateContactCustomFields = async (contactId: string, customFields: ContactCustomField[]) => {
    try {
      const updatedContact = await contactsService.updateContact(contactId, { customFields } as Partial<Contact>)
      const nextCustomFields = Array.isArray(updatedContact.customFields)
        ? updatedContact.customFields
        : mergeCustomFields(contactData?.customFields, customFields)

      setSelectedContactDetails(prev => prev?.id === contactId
        ? { ...prev, customFields: nextCustomFields }
        : prev
      )
      setSelectedContact(prev => prev?.id === contactId
        ? { ...prev, customFields: nextCustomFields }
        : prev
      )
      setContacts(prev => prev.map(contact => contact.id === contactId
        ? { ...contact, customFields: nextCustomFields }
        : contact
      ))

      showToast('success', 'Campo actualizado', 'El cambio quedó guardado en Ristak.')
      return nextCustomFields
    } catch (error) {
      showToast('error', 'No se pudo actualizar', 'Revisa el valor e intenta de nuevo.')
      throw error
    }
  }

  const handleUpdateContactIdentity = async (
    contactId: string,
    updates: Partial<Record<'name' | 'email' | 'phone', string | null>>
  ): Promise<Partial<Contact>> => {
    try {
      const updatedContact = await contactsService.updateContact(contactId, updates as Partial<Contact>)
      const identityPatch: Partial<Record<'name' | 'email' | 'phone', string | null>> = {}

      if (Object.prototype.hasOwnProperty.call(updates, 'name')) {
        identityPatch.name = updatedContact.name ?? (updatedContact as any).full_name ?? updates.name ?? ''
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'email')) {
        identityPatch.email = updatedContact.email ?? updates.email ?? ''
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'phone')) {
        identityPatch.phone = updatedContact.phone ?? updates.phone ?? ''
      }

      const nextPatch: Partial<Contact> = { ...updatedContact }
      if (identityPatch.name !== undefined) nextPatch.name = identityPatch.name ?? ''
      if (identityPatch.email !== undefined) nextPatch.email = identityPatch.email ?? ''
      if (identityPatch.phone !== undefined) nextPatch.phone = identityPatch.phone ?? ''

      setSelectedContactDetails(prev => prev?.id === contactId ? { ...prev, ...nextPatch } : prev)
      setSelectedContact(prev => prev?.id === contactId ? { ...prev, ...nextPatch } : prev)
      setContacts(prev => prev.map(contact => contact.id === contactId ? { ...contact, ...nextPatch } : contact))

      return nextPatch
    } catch (error) {
      showToast('error', 'No se pudo guardar', error instanceof Error ? error.message : 'Intenta editar el contacto otra vez.')
      throw error
    }
  }

  const handleUpdateContactTags = async (contactId: string, tagIds: string[]) => {
    const updatedContact = await contactsService.updateContact(contactId, { tags: tagIds } as Partial<Contact>)
    const nextTags = Array.isArray(updatedContact.tags) ? updatedContact.tags : tagIds

    setSelectedContactDetails(prev => prev?.id === contactId ? { ...prev, tags: nextTags } : prev)
    setSelectedContact(prev => prev?.id === contactId ? { ...prev, tags: nextTags } : prev)
    setContacts(prev => prev.map(contact => contact.id === contactId ? { ...contact, tags: nextTags } : contact))

    return nextTags
  }

  const handleBulkTagsApplied = ({ mode, tagIds }: { mode: 'add' | 'remove'; tagIds: string[] }) => {
    const targetIds = new Set(selectedContactIds)
    const tagSet = new Set(tagIds)

    setContacts(prev => prev.map(contact => {
      if (!targetIds.has(contact.id)) return contact
      const current = contact.tags || []
      const next = mode === 'add'
        ? [...new Set([...current, ...tagIds])]
        : current.filter(tagId => !tagSet.has(tagId))
      return { ...contact, tags: next }
    }))
  }

  const handleBulkCustomFieldsApplied = ({ customFields }: { customFields: ContactCustomField[] }) => {
    const targetIds = new Set(selectedContactIds)

    setContacts(prev => prev.map(contact => {
      if (!targetIds.has(contact.id)) return contact
      return {
        ...contact,
        customFields: mergeCustomFields(contact.customFields || [], customFields)
      }
    }))
  }

  const handleUpdatePreferredWhatsAppPhoneNumber = async (contactId: string, phoneNumberId: string) => {
    try {
      const updatedContact = await contactsService.updateContact(contactId, {
        preferredWhatsAppPhoneNumberId: phoneNumberId
      } as Partial<Contact>)
      const nextPhoneNumberId = updatedContact.preferredWhatsAppPhoneNumberId ||
        updatedContact.preferred_whatsapp_phone_number_id ||
        phoneNumberId ||
        ''
      const nextContactPatch = {
        preferredWhatsAppPhoneNumberId: nextPhoneNumberId,
        preferred_whatsapp_phone_number_id: nextPhoneNumberId
      }

      setSelectedContactDetails(prev => prev?.id === contactId ? { ...prev, ...nextContactPatch } : prev)
      setSelectedContact(prev => prev?.id === contactId ? { ...prev, ...nextContactPatch } : prev)
      setContacts(prev => prev.map(contact => contact.id === contactId ? { ...contact, ...nextContactPatch } : contact))

      showToast(
        'success',
        nextPhoneNumberId ? 'Número guardado' : 'Respuesta automática activada',
        nextPhoneNumberId
          ? 'Este contacto se responderá desde el número elegido.'
          : 'Ristak usará el número por donde llegó el contacto.'
      )

      return { ...updatedContact, ...nextContactPatch }
    } catch (error) {
      showToast('error', 'No se pudo guardar', error instanceof Error ? error.message : 'Intenta cambiar el número otra vez.')
      throw error
    }
  }

  const fetchData = async () => {
    const requestId = fetchRequestRef.current + 1
    fetchRequestRef.current = requestId
    const normalizedSearch = debouncedContactSearch.trim()
    const serializedAdvancedFilters = serializeContactAdvancedConfig(advancedFilterConfig)
    const activeAdvancedFilters = serializedAdvancedFilters
      ? normalizeContactAdvancedConfig(advancedFilterConfig)
      : undefined
    const activeSort = activeAdvancedFilters?.sort || null
    const contactsQueryOptions = {
      filter,
      advancedFilters: activeAdvancedFilters,
      sortBy: activeSort?.by || 'created_at',
      sortOrder: activeSort?.order || 'DESC' as const
    }
    setLoading(true)
    try {
      let startDate: string | undefined
      let endDate: string | undefined

      // Solo usar fechas si está en modo 'by-date'
      if (viewMode === 'by-date') {
        startDate = formatDateToISO(dateRange.start)
        endDate = formatEndDateToISO(dateRange.end) // Incluir día completo
      }
      // Si viewMode === 'all', no enviamos fechas para obtener TODOS los contactos

      const statsPromise = contactsService.getStats(startDate, endDate)
        .then((statsData) => {
          if (fetchRequestRef.current === requestId) {
            setStats(statsData)
          }
        })
        .catch(() => {
          if (!hasLoadedContacts && fetchRequestRef.current === requestId) {
            setStats(null)
          }
        })

      const firstPage = await contactsService.getContactsPage({
        startDate,
        endDate,
        page: 1,
        limit: CONTACTS_PAGE_SIZE,
        ...contactsQueryOptions,
        ...(normalizedSearch ? { search: normalizedSearch } : {})
      })

      if (fetchRequestRef.current !== requestId) {
        return
      }

      setContacts(firstPage.contacts)
      setHasLoadedContacts(true)
      setLoading(false)

      void statsPromise

      if (firstPage.pagination.hasNext) {
        const loadRemainingPages = async () => {
          let page = firstPage.pagination.page + 1
          let hasMore = true
          let loadedContacts = firstPage.contacts

          while (
            hasMore &&
            (normalizedSearch || page <= MAX_CONTACTS_BACKGROUND_PAGES) &&
            fetchRequestRef.current === requestId
          ) {
            const nextPage = await contactsService.getContactsPage({
              startDate,
              endDate,
              page,
              limit: CONTACTS_PAGE_SIZE,
              ...contactsQueryOptions,
              ...(normalizedSearch ? { search: normalizedSearch } : {})
            })

            if (fetchRequestRef.current !== requestId) {
              return
            }

            loadedContacts = [
              ...loadedContacts,
              ...nextPage.contacts
            ]
            setContacts(loadedContacts)

            hasMore = nextPage.pagination.hasNext && nextPage.contacts.length > 0
            page = nextPage.pagination.page + 1
          }
        }

        loadRemainingPages().catch(() => {
          // La primera página ya está visible; si el relleno falla, no bloqueamos al usuario.
        })
      }
    } catch (error) {
      // Error already shown to user via toast
      if (fetchRequestRef.current === requestId) {
        showToast('error', 'No se pudieron cargar los contactos', 'Hubo un problema al obtener la información de contactos. Intenta refrescar la página.')
      }
    } finally {
      if (fetchRequestRef.current === requestId) {
        setLoading(false)
        setHasLoadedContacts(true)
      }
    }
  }

  const filteredContacts = useMemo(() => {
    return contacts
  }, [contacts])

  const selectedContacts = useMemo(() => {
    if (selectedContactIds.length === 0) return []

    const selectedIds = new Set(selectedContactIds)
    return contacts.filter(contact => selectedIds.has(contact.id))
  }, [contacts, selectedContactIds])

  const filterOptions = [
    { label: 'Todos', value: 'all' },
    { label: labels.leads, value: 'leads' },
    { label: 'Citados', value: 'appointments' },
    { label: 'Asistencias', value: 'attendances' },
    { label: labels.customers, value: 'customers' }
  ]

  const customFieldColumnSpecs = useMemo(() => {
    const specs: ContactCustomFieldColumnSpec[] = []

    const upsertCustomFieldColumn = (
      field: ContactCustomField | ContactCustomFieldDefinition,
      index: number
    ) => {
      if (!shouldExposeCustomFieldColumn(field)) return

      const keys = getContactCustomFieldKeys(field)
      if (keys.length === 0) return

      const existingSpec = specs.find((spec) => keys.some((key) => spec.matchKeySet.has(key)))
      if (existingSpec) {
        keys.forEach((key) => existingSpec.matchKeySet.add(key))
        return
      }

      specs.push({
        columnKey: `${CUSTOM_FIELD_COLUMN_PREFIX}${keys[0]}`,
        label: getCustomFieldColumnLabel(field, index),
        matchKeySet: new Set(keys)
      })
    }

    customFieldDefinitions.forEach(upsertCustomFieldColumn)
    contacts.forEach((contact) => {
      const fields = contact.customFields || []
      fields.forEach(upsertCustomFieldColumn)
    })

    return specs.sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }))
  }, [contacts, customFieldDefinitions])

  const hasAttendedAppointment = (contact: Contact) =>
    Boolean(contact.hasShowedAppointment || contact.hasAttendedAppointment) ||
    Boolean(allEvents.some(event =>
      event.contactId === contact.id &&
      isAttendedAppointmentStatus(event.appointmentStatus || (event as any).status)
    )) ||
    Boolean(contact.appointments?.some(appointment =>
      isAttendedAppointmentStatus(appointment.appointment_status || appointment.status)
    ))

  const getStatusBadge = (contact: Contact) => {
    const badge = getContactStageBadge({
      ...contact,
      hasAttendedAppointment: hasAttendedAppointment(contact)
    }, labels)

    return badge ? <Badge variant={badge.variant}>{badge.text}</Badge> : null
  }

  const openContactDeleteModal = (targetContacts: Contact[]) => {
    if (targetContacts.length === 0) return

    setContactsPendingDeletion(targetContacts)
    setContactDeleteConfirmation('')
  }

  // (CNT-001) Guarda la edición del contacto. Si el teléfono/email ya pertenece a otro
  // contacto, el backend responde 409 'merge_confirmation_required': en vez de mostrar un
  // error genérico, abrimos un diálogo para confirmar la fusión y reintentamos con
  // confirmMerge=true (el backend conserva toda la información de ambos contactos).
  const persistContactEdit = async (
    contactId: string,
    updates: { full_name: string; email: string; phone: string; source: string },
    confirmMerge: boolean
  ) => {
    try {
      if (confirmMerge) setMergeSaving(true)
      await contactsService.updateContact(contactId, updates, confirmMerge ? { confirmMerge: true } : undefined)
      setMergeConfirm(null)
      setEditingContact(null)
      navigateContactsPath(buildContactsPath(viewMode, filter), { replace: true })
      showToast('success', '¡Contacto actualizado!', 'Los cambios se guardaron correctamente')
      fetchData()
    } catch (error) {
      const apiError = error as { status?: number; body?: { code?: string; conflict?: { field: string; contact: { id: string; full_name?: string | null; phone?: string | null; email?: string | null } } } }
      if (apiError?.status === 409 && apiError.body?.code === 'merge_confirmation_required' && apiError.body.conflict) {
        setMergeConfirm({ contactId, updates, conflict: apiError.body.conflict })
        return
      }
      showToast('error', 'Error al actualizar', 'No se pudo actualizar el contacto')
    } finally {
      setMergeSaving(false)
    }
  }

  // (CNT-007) Papelera: abrir y cargar, restaurar, borrar permanentemente.
  const openTrash = async () => {
    setTrashOpen(true)
    setTrashLoading(true)
    try {
      setTrashedContacts(await contactsService.getTrashedContacts())
    } catch {
      showToast('error', 'Error', 'No se pudo cargar la papelera')
    } finally {
      setTrashLoading(false)
    }
  }

  const handleRestoreContact = async (id: string) => {
    setTrashActingId(id)
    try {
      await contactsService.restoreContact(id)
      setTrashedContacts((cur) => cur.filter((c) => c.id !== id))
      showToast('success', 'Contacto restaurado', 'Volvió a tu lista de contactos.')
      fetchData()
    } catch {
      showToast('error', 'Error', 'No se pudo restaurar el contacto')
    } finally {
      setTrashActingId(null)
    }
  }

  const handlePermanentDeleteContact = (id: string) => {
    const contact = trashedContacts.find((c) => c.id === id)
    const label = contact?.full_name || contact?.email || contact?.phone || 'este contacto'

    showConfirm(
      'Eliminar permanentemente',
      `Vas a eliminar permanentemente a ${label}. El contacto se borra de la base (sus pagos se conservan en el historial). Esta acción no se puede deshacer.`,
      async () => {
        setTrashActingId(id)
        try {
          await contactsService.permanentlyDeleteContact(id)
          setTrashedContacts((cur) => cur.filter((c) => c.id !== id))
          showToast('success', 'Eliminado permanentemente', 'El contacto se borró. Sus pagos se conservaron en el historial.')
        } catch {
          showToast('error', 'Error', 'No se pudo borrar el contacto')
          return false
        } finally {
          setTrashActingId(null)
        }
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const closeContactDeleteModal = () => {
    if (deletingContacts) return

    setContactsPendingDeletion([])
    setContactDeleteConfirmation('')
    setDeleteProgress(0)
  }

  // (CNT-011) Marca la cancelación; el bucle de borrado se detiene tras el
  // contacto en curso (no se puede abortar una petición ya enviada).
  const handleCancelBulkDelete = () => {
    deleteCancelRef.current = true
  }

  const handleConfirmDeleteContacts = async () => {
    if (contactsPendingDeletion.length === 0) return
    if (contactDeleteConfirmation.trim().toUpperCase() !== DELETE_CONFIRMATION_WORD) return

    setDeletingContacts(true)
    // (CNT-011) Reinicia el progreso y la bandera de cancelación al arrancar.
    deleteCancelRef.current = false
    setDeleteProgress(0)
    const totalToDelete = contactsPendingDeletion.length
    const deletingIds = contactsPendingDeletion.map(contact => contact.id)
    const failedContacts: Contact[] = []
    let cancelled = false
    let processedCount = 0

    for (const contact of contactsPendingDeletion) {
      // (CNT-011) Si el usuario canceló, dejamos de procesar los restantes.
      if (deleteCancelRef.current) {
        cancelled = true
        break
      }
      try {
        await contactsService.deleteContact(contact.id)
      } catch {
        failedContacts.push(contact)
      }
      processedCount += 1
      setDeleteProgress(processedCount)
    }

    // (CNT-011) Solo se borraron de verdad los ya procesados que no fallaron.
    const processedIds = deletingIds.slice(0, processedCount)
    const deletedIds = new Set(
      processedIds.filter(id => !failedContacts.some(contact => contact.id === id))
    )

    if (deletedIds.size > 0) {
      setContacts(prev => prev.filter(contact => !deletedIds.has(contact.id)))
      setSelectedContactIds(prev => prev.filter(id => !deletedIds.has(id)))
    }

    setDeletingContacts(false)
    setContactsPendingDeletion([])
    setContactDeleteConfirmation('')
    setDeleteProgress(0)
    deleteCancelRef.current = false

    if (cancelled) {
      // (CNT-011) Resumen al cancelar: cuántos alcanzaron a borrarse.
      showToast(
        'warning',
        'Borrado cancelado',
        `Se eliminaron ${deletedIds.size} de ${totalToDelete} antes de cancelar.`
      )
    } else if (failedContacts.length > 0) {
      showToast(
        'error',
        'No se pudieron eliminar todos',
        `Se eliminaron ${deletedIds.size} y fallaron ${failedContacts.length}. Intenta otra vez con los pendientes.`
      )
    } else {
      showToast(
        'success',
        totalToDelete === 1 ? 'Contacto eliminado' : 'Contactos eliminados',
        totalToDelete === 1
          ? 'El contacto se eliminó correctamente.'
          : `Se eliminaron ${totalToDelete} contactos correctamente.`
      )
    }

    fetchData()
  }

  const columns: Column<Contact>[] = [
    {
      key: 'createdAt',
      header: 'Fecha de creación',
      render: (value) => formatLocalDateShort(value),
      sortable: true
    },
    {
      key: 'name',
      header: 'Nombre',
      render: (value, item) => (
        <button
          className={styles.nameLink}
          onClick={() => openContactModal(item)}
        >
          {renderContactAvatar(item, styles.contactTableAvatar)}
          <span className={styles.nameLinkText}>{value || getContactDisplayName(item)}</span>
        </button>
      ),
      sortable: true
    },
    {
      key: 'status',
      header: 'Estado',
      render: (_value, item) => getStatusBadge(item),
      searchValue: (value, item) => [
        value,
        getContactStageBadge({
          ...item,
          hasAttendedAppointment: hasAttendedAppointment(item)
        }, labels)?.text
      ],
      sortable: true
    },
    {
      key: 'tags',
      header: 'Etiquetas',
      render: (_value, item) => {
        const tagLabels = getContactTagLabels(item.tags, contactTagLabels)
        return tagLabels.length > 0 ? tagLabels.join(', ') : '-'
      },
      searchValue: (_value, item) => getContactTagLabels(item.tags, contactTagLabels),
      sortable: false,
      visible: false
    },
    {
      key: 'phone',
      header: 'Teléfono',
      sortable: true
    },
    {
      key: 'email',
      header: 'Email',
      sortable: true,
      visible: false
    },
    {
      key: 'ltv',
      header: 'Pagos totales',
      render: (value) => value > 0 ? formatCurrency(value) : '-',
      sortable: true
    },
    ...customFieldColumnSpecs.map((fieldColumn): Column<Contact> => ({
      key: fieldColumn.columnKey,
      header: fieldColumn.label,
      render: (_value, item) => {
        const field = findContactCustomField(item, fieldColumn.matchKeySet)
        const displayValue = formatContactCustomFieldDisplayValue(field?.value)
        return displayValue || '-'
      },
      searchValue: (_value, item) => {
        const field = findContactCustomField(item, fieldColumn.matchKeySet)
        const displayValue = formatContactCustomFieldDisplayValue(field?.value)
        return displayValue ? [displayValue] : []
      },
      sortable: false,
      visible: false
    })),
    {
      key: 'id',
      header: 'Acciones',
      searchable: false,
      render: (_, item) => {
        // Contar acciones disponibles
        const actions = []
        actions.push('view') // Ver detalles siempre disponible
        if (item.email) actions.push('email') // Enviar email si tiene email
        actions.push('edit') // Editar siempre disponible
        actions.push('delete') // Eliminar siempre disponible

        // Si solo hay una acción (eliminar), mostrar botón directo
        // Esto solo pasa si el contacto no tiene email y es la única acción
        if (actions.length === 1 && actions[0] === 'delete') {
          return (
            <div className={styles.actions}>
              <button
                className={`${styles.actionButton} ${styles.deleteButton}`}
                onClick={() => openContactDeleteModal([item])}
                title="Eliminar contacto"
              >
                <Trash2 size={16} />
              </button>
            </div>
          )
        }

        // Si hay múltiples acciones, mostrar dropdown
        return (
          <div className={styles.actions}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className={styles.actionButton} title="Más acciones">
                  <MoreVertical size={16} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* Ver detalles */}
                <DropdownMenuItem onClick={() => openContactModal(item)}>
                  <Eye size={16} />
                  <span style={{ marginLeft: '8px' }}>Ver detalles</span>
                </DropdownMenuItem>

                {/* Enviar email (si tiene email) */}
                {item.email && (
                  <DropdownMenuItem onClick={() => window.location.href = `mailto:${item.email}`}>
                    <Mail size={16} />
                    <span style={{ marginLeft: '8px' }}>Enviar email</span>
                  </DropdownMenuItem>
                )}

                {/* Editar */}
                <DropdownMenuItem onClick={() => {
                  setEditingContact(item)
                  navigateContactsPath(`/contacts/${encodeURIComponent(item.id)}/edit`)
                }}>
                  <Pencil size={16} />
                  <span style={{ marginLeft: '8px' }}>Editar contacto</span>
                </DropdownMenuItem>

                {/* Separador antes de acción destructiva */}
                <DropdownMenuSeparator />

                {/* Eliminar */}
                <DropdownMenuItem
                  onClick={() => openContactDeleteModal([item])}
                  className={styles.destructive}
                >
                  <Trash2 size={16} />
                  <span style={{ marginLeft: '8px' }}>Eliminar contacto</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      },
      sortable: false
    }
  ]

  const statsData = {
    total: stats?.total || 0,
    withAppointments: stats?.withAppointments || 0,
    customers: stats?.customers || 0,
    ltvTotal: stats?.ltvTotal || 0,
    ltvPromedio: stats?.avgLtv || 0,
    totalChange: stats ? contactsService.calculateDelta(stats.total, stats.totalPrev) : 0,
    appointmentsChange: stats ? contactsService.calculateDelta(stats.withAppointments, stats.withAppointmentsPrev) : 0,
    customersChange: stats ? contactsService.calculateDelta(stats.customers, stats.customersPrev) : 0,
    ltvTotalChange: stats ? contactsService.calculateDelta(stats.ltvTotal, stats.ltvTotalPrev) : 0,
    ltvPromedioChange: stats ? contactsService.calculateDelta(stats.avgLtv, stats.avgLtvPrev) : 0
  }

  const handleCreateContact = async (contact: Omit<Contact, 'id' | 'createdAt' | 'ltv' | 'purchases'>) => {
    try {
      const newContact = await contactsService.createContact(contact)
      setContacts(prev => [...prev, newContact])
      setShowNewContactModal(false)
      openContactModal(newContact)
      showToast('success', '¡Contacto creado exitosamente!', `${contact.name} se agregó a tu lista de contactos`)
      fetchData()
    } catch (error) {
      // (CNT-003) Cuando ya existe un contacto duplicado (por teléfono/email) el
      // backend responde 409 con { error: "<mensaje real>" }. El apiClient conserva
      // status y body, y deja ese mensaje en error.message. Mostramos el mensaje
      // real en vez del genérico para que el usuario sepa por qué falló.
      const apiError = error as { status?: number; body?: { error?: unknown }; message?: unknown }
      const duplicateMessage =
        (apiError?.body && typeof apiError.body === 'object' && apiError.body.error)
          ? String(apiError.body.error)
          : (typeof apiError?.message === 'string' ? apiError.message : '')
      if (apiError?.status === 409 && duplicateMessage) {
        showToast('error', 'Contacto duplicado', duplicateMessage)
        return
      }
      showToast('error', 'No se pudo crear el contacto', 'Hubo un problema al guardar el contacto. Verifica los datos e intenta nuevamente.')
    }
  }

  const contactSelectionToolbar = selectedContacts.length > 0 ? (
    <TableSelectionToolbar
      count={selectedContacts.length}
      onClearSelection={() => setSelectedContactIds([])}
    >
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setShowBulkTagsModal(true)}
      >
        <Tags size={16} />
        Etiquetas
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setShowBulkCustomFieldsModal(true)}
      >
        <ListPlus size={16} />
        Campos personalizados
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setShowBulkWhatsAppModal(true)}
      >
        <MessageSquare size={16} />
        Mandar WhatsApp
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setShowBulkAutomationModal(true)}
      >
        <Workflow size={16} />
        Añadir a automatización
      </Button>
      <Button
        type="button"
        variant="danger"
        size="sm"
        onClick={() => openContactDeleteModal(selectedContacts)}
      >
        <Trash2 size={16} />
        Eliminar
      </Button>
    </TableSelectionToolbar>
  ) : null

  const contactsRefreshing = loading && hasLoadedContacts

  if (loading && !hasLoadedContacts) {
    return <Loading message="Cargando contactos..." page="contacts" />
  }

  return (
    <PageContainer>
      <div className={styles.container}>
        <PageHeader
          title="Contactos"
          subtitle="Visualiza tus contactos, clientes y su valor acumulado en el tiempo."
        />

        <div className={styles.controlsRow}>
          <div className={styles.dateFilters}>
            <TabList
              tabs={[
                {
                  value: 'all',
                  label: 'Todos',
                  description: 'Muestra todos los contactos guardados, sin limitar por el rango de fechas.'
                },
                {
                  value: 'by-date',
                  label: 'Por fecha',
                  description: 'Activa el calendario para ver solo contactos creados dentro de un periodo.'
                }
              ]}
              activeTab={viewMode}
              onTabChange={(value) => {
                if (isContactViewMode(value)) {
                  setViewMode(value)
                  navigateContactsPath(buildContactsPath(value, filter))
                }
              }}
              variant="compact"
            />
            {viewMode === 'by-date' && (
              <DateRangePicker
                startDate={formatDateToISO(dateRange.start)}
                endDate={formatDateToISO(dateRange.end)}
                onChange={(start, end) => setDateRange({
                  start: parseLocalDateString(start),
                  end: parseLocalDateString(end),
                  preset: 'custom'
                })}
              />
            )}
          </div>
          <div className={styles.headerActions}>
            <Button
              type="button"
              variant="ghost"
              onClick={openTrash}
            >
              <Trash2 size={16} />
              Papelera
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setShowNewContactModal(true)
                navigateContactsPath('/contacts/new')
              }}
            >
              <Plus size={16} />
              Nuevo contacto
            </Button>
          </div>
        </div>

        <div className={styles.kpiRow}>
          <KpiCard
            title="Total Contactos"
            value={formatNumber(statsData.total)}
            delta={statsData.totalChange}
            deltaLabel="vs periodo anterior"
            loading={contactsRefreshing}
            icon={<Users className="text-[var(--color-text-tertiary)]" />}
          />
          <KpiCard
            title={labels.customers}
            value={formatNumber(statsData.customers)}
            delta={statsData.customersChange}
            deltaLabel="vs periodo anterior"
            loading={contactsRefreshing}
            icon={<User className="text-[var(--color-text-tertiary)]" />}
          />
          <KpiCard
            title="Pagos totales"
            value={formatCurrency(statsData.ltvTotal)}
            delta={statsData.ltvTotalChange}
            deltaLabel="vs periodo anterior"
            loading={contactsRefreshing}
            icon={<DollarSign className="text-[var(--color-text-tertiary)]" />}
          />
          <KpiCard
            title="Pagos totales promedio"
            value={formatCurrency(statsData.ltvPromedio)}
            delta={statsData.ltvPromedioChange}
            deltaLabel="vs periodo anterior"
            loading={contactsRefreshing}
            icon={<TrendingUp className="text-[var(--color-text-tertiary)]" />}
          />
        </div>

      <Card padding="none">
        <Table
          key="contacts_table_v2"
          initialColumns={columns}
          data={filteredContacts}
          keyExtractor={(item) => item.id}
          emptyMessage="No hay contactos disponibles"
          loading={contactsRefreshing || loadingEvents}
          searchable={true}
          searchPlaceholder="Buscar contactos..."
          serverSideSearch={true}
          searchTerm={contactSearchTerm}
          onSearchTermChange={setContactSearchTerm}
          paginated={true}
          pageSize={20}
          filters={filterOptions}
          activeFilter={filter}
          onFilterChange={(value) => {
            setFilter(value)
            navigateContactsPath(buildContactsPath(viewMode, value))
          }}
          toolbarStart={
            <div className={styles.contactConditionsToolbar}>
              <Button
                type="button"
                variant={advancedFiltersActive ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setAdvancedFiltersOpen(true)}
                aria-label={advancedFilterRuleCount > 0
                  ? `Abrir filtros, ${advancedFilterRuleCount} condiciones activas`
                  : 'Abrir filtros'
                }
              >
                <SlidersHorizontal size={16} />
                Todos
              </Button>
              {advancedFiltersActive && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Limpiar condiciones"
                  onClick={resetAdvancedFilters}
                >
                  <X size={16} />
                </Button>
              )}
            </div>
          }
          tableId="contacts_v2"
          selectionActions={contactSelectionToolbar}
          rowSelection={{
            selectedKeys: selectedContactIds,
            onChange: setSelectedContactIds,
            getRowLabel: (item) => item.name || item.email || item.phone || 'contacto',
            selectAllLabel: 'Seleccionar todos los contactos'
          }}
        />
      </Card>

      <ContactAdvancedFiltersModal
        isOpen={advancedFiltersOpen}
        value={advancedFilterConfig}
        tags={contactTags}
        customFieldDefinitions={customFieldDefinitions}
        onClose={() => setAdvancedFiltersOpen(false)}
        onApply={applyAdvancedFilters}
      />

      {isClient && (
        <ContactBulkPropertyModals
          selectedContacts={selectedContacts}
          tagsOpen={showBulkTagsModal}
          customFieldsOpen={showBulkCustomFieldsModal}
          onCloseTags={() => setShowBulkTagsModal(false)}
          onCloseCustomFields={() => setShowBulkCustomFieldsModal(false)}
          onTagsApplied={handleBulkTagsApplied}
          onCustomFieldsApplied={handleBulkCustomFieldsApplied}
        />
      )}

      {isClient && (
        <ContactBulkActionModals
          selectedContacts={selectedContacts}
          whatsappPhoneNumbers={whatsappPhoneNumbers}
          whatsappOpen={showBulkWhatsAppModal}
          automationOpen={showBulkAutomationModal}
          onCloseWhatsApp={() => setShowBulkWhatsAppModal(false)}
          onCloseAutomation={() => setShowBulkAutomationModal(false)}
          onCreated={() => setSelectedContactIds([])}
        />
      )}

      {isClient && (
        <ContactDetailsModal
          isOpen={Boolean(selectedContact)}
          onClose={closeContactModal}
          title="Ficha de Contacto"
          subtitle={modalSubtitle}
          data={modalData}
          loading={contactDetailsLoading}
          type={null}
          onUpdateCustomFields={handleUpdateContactCustomFields}
          onUpdateContact={handleUpdateContactIdentity}
          onUpdateTags={handleUpdateContactTags}
          whatsappPhoneNumbers={whatsappPhoneNumbers}
          onUpdatePreferredWhatsAppPhoneNumber={handleUpdatePreferredWhatsAppPhoneNumber}
        />
      )}

      {mergeConfirm && (
        <Modal
          isOpen
          onClose={() => { if (!mergeSaving) setMergeConfirm(null) }}
          title="Confirmar fusión de contactos"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p style={{ color: 'var(--text-dim)', lineHeight: 1.5, margin: 0 }}>
              El {mergeConfirm.conflict.field === 'email' ? 'correo' : 'teléfono'} que ingresaste ya pertenece a otro contacto
              {mergeConfirm.conflict.contact.full_name ? <> (<strong>{mergeConfirm.conflict.contact.full_name}</strong>)</> : null}.
              {' '}Si continúas, ambos contactos se <strong>fusionarán en uno</strong> y se conservará toda la información de los dos
              (etiquetas, campos personalizados e historial). Esta acción no se puede deshacer.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button type="button" variant="secondary" onClick={() => setMergeConfirm(null)} disabled={mergeSaving}>
                Cancelar
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => persistContactEdit(mergeConfirm.contactId, mergeConfirm.updates, true)}
                disabled={mergeSaving}
              >
                {mergeSaving ? 'Fusionando…' : 'Sí, fusionar'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {trashOpen && (
        <Modal isOpen onClose={() => setTrashOpen(false)} title="Papelera de contactos">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ color: 'var(--text-dim)', margin: 0, lineHeight: 1.5 }}>
              Los contactos eliminados se conservan aquí con su historial y pagos. Puedes restaurarlos o borrarlos de forma permanente (sus pagos se conservan).
            </p>
            {trashLoading ? (
              <p style={{ color: 'var(--text-mute)', margin: 0 }}>Cargando…</p>
            ) : trashedContacts.length === 0 ? (
              <p style={{ color: 'var(--text-mute)', margin: 0 }}>La papelera está vacía.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
                {trashedContacts.map((c) => (
                  <div
                    key={c.id}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-ctl)' }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: 'var(--text)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c.full_name || 'Sin nombre'}
                      </div>
                      <div style={{ color: 'var(--text-mute)', fontSize: 12 }}>{c.email || c.phone || '—'}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                      <Button type="button" variant="secondary" onClick={() => handleRestoreContact(c.id)} disabled={trashActingId === c.id}>
                        Restaurar
                      </Button>
                      <Button type="button" variant="danger" onClick={() => handlePermanentDeleteContact(c.id)} disabled={trashActingId === c.id}>
                        Borrar
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}

      {isClient && showNewContactModal && createPortal(
        <div className={styles.modalOverlay} data-overlay="">
          <div
            className={styles.modal}
            data-modal=""
            data-modal-shell="legacy"
            data-modal-size="md"
            data-modal-type="custom"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader} data-modal-header="">
              <div>
                <h2>Nuevo contacto</h2>
                <p className={styles.modalSubtitle}>Guarda a la persona para verla en tu lista y usarla en pagos o seguimiento.</p>
              </div>
	              <button
	                className={styles.closeButton}
	                onClick={() => {
                    setShowNewContactModal(false)
                    navigateContactsPath(buildContactsPath(viewMode, filter), { replace: true })
                  }}
	                type="button"
	              >
                <X size={20} />
              </button>
            </div>
            <form className={styles.form} data-modal-form="" onSubmit={(e) => {
              e.preventDefault()
              const formData = new FormData(e.currentTarget)
              const contact = {
                name: String(formData.get('name') || '').trim(),
                email: String(formData.get('email') || '').trim(),
                phone: String(formData.get('phone') || '').trim(),
                source: String(formData.get('source') || '').trim() || 'Manual',
                status: 'lead' as const
              }
              handleCreateContact(contact)
            }}>
              <div className={styles.formGroup}>
                <label>Nombre completo</label>
                <input name="name" type="text" autoFocus required />
              </div>
              <div className={styles.formGroup}>
                <label>Correo</label>
                <input name="email" type="email" />
              </div>
              <div className={styles.formGroup}>
                <label>Teléfono</label>
                <ContactPhoneField />
              </div>
              <div className={styles.formGroup}>
                <label>Fuente</label>
                <input name="source" type="text" placeholder="Manual, WhatsApp, referido..." />
              </div>
              <div className={styles.formActions} data-modal-footer="">
	                <Button type="button" variant="ghost" onClick={() => {
                    setShowNewContactModal(false)
                    navigateContactsPath(buildContactsPath(viewMode, filter), { replace: true })
                  }}>
                  Cancelar
                </Button>
                <Button type="submit">
                  Crear contacto
                </Button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {isClient && editingContact && createPortal(
        <div className={styles.modalOverlay} data-overlay="" onClick={() => {
          setEditingContact(null)
          navigateContactsPath(buildContactsPath(viewMode, filter), { replace: true })
        }}>
          <div
            className={styles.modal}
            data-modal=""
            data-modal-shell="legacy"
            data-modal-size="md"
            data-modal-type="custom"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader} data-modal-header="">
              <h2>Editar Contacto</h2>
	              <button
	                className={styles.closeButton}
	                onClick={() => {
                    setEditingContact(null)
                    navigateContactsPath(buildContactsPath(viewMode, filter), { replace: true })
                  }}
	              >
                <X size={20} />
              </button>
            </div>
            <form className={styles.form} data-modal-form="" onSubmit={async (e) => {
              e.preventDefault()
              const formData = new FormData(e.currentTarget)
              const updatedContact = {
                full_name: formData.get('name') as string,
                email: formData.get('email') as string,
                phone: formData.get('phone') as string,
                source: formData.get('source') as string
              }

              await persistContactEdit(editingContact.id, updatedContact, false)
            }}>
              <div className={styles.formGroup}>
                <label>Nombre completo</label>
                <input
                  name="name"
                  type="text"
                  defaultValue={editingContact.name}
                  required
                />
              </div>
              <div className={styles.formGroup}>
                <label>Email</label>
                <input
                  name="email"
                  type="email"
                  defaultValue={editingContact.email}
                />
              </div>
              <div className={styles.formGroup}>
                <label>Teléfono</label>
                <ContactPhoneField defaultValue={editingContact.phone} />
              </div>
              <div className={styles.formGroup}>
                <label>Fuente</label>
                <input
                  name="source"
                  type="text"
                  defaultValue={editingContact.source || ''}
                />
              </div>
              <div className={styles.formActions} data-modal-footer="">
	                <Button type="button" variant="ghost" onClick={() => {
                    setEditingContact(null)
                    navigateContactsPath(buildContactsPath(viewMode, filter), { replace: true })
                  }}>
                  Cancelar
                </Button>
                <Button type="submit">
                  Guardar cambios
                </Button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      <Modal
        isOpen={contactsPendingDeletion.length > 0}
        onClose={closeContactDeleteModal}
        title={`Eliminar contacto${contactsPendingDeletion.length === 1 ? '' : 's'}`}
        size="sm"
        showCloseButton={!deletingContacts}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {deletingContacts ? (
            /* (CNT-011) Durante el borrado mostramos progreso (X de N) y barra + opción de cancelar. */
            <>
              <p style={{ margin: 0, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Eliminando <strong>{deleteProgress}</strong> de <strong>{contactsPendingDeletion.length}</strong> contacto{contactsPendingDeletion.length === 1 ? '' : 's'}…
              </p>
              <div
                className={styles.bulkProgressTrack}
                aria-label={`Progreso ${deleteProgress} de ${contactsPendingDeletion.length}`}
              >
                <span
                  style={{
                    width: `${contactsPendingDeletion.length > 0 ? Math.round((deleteProgress / contactsPendingDeletion.length) * 100) : 0}%`
                  }}
                />
              </div>
              <div className={styles.formActions}>
                <Button type="button" variant="secondary" onClick={handleCancelBulkDelete}>
                  Cancelar borrado
                </Button>
              </div>
            </>
          ) : (
            <>
              <p style={{ margin: 0, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Vas a eliminar <strong>{contactsPendingDeletion.length}</strong> contacto{contactsPendingDeletion.length === 1 ? '' : 's'}. Esta acción borra la información seleccionada y no se puede deshacer.
              </p>
              <div className={styles.formGroup}>
                <label>Escribe <strong>{DELETE_CONFIRMATION_WORD}</strong> para confirmar:</label>
                <input
                  value={contactDeleteConfirmation}
                  onChange={(event) => setContactDeleteConfirmation(event.target.value)}
                  placeholder={DELETE_CONFIRMATION_WORD}
                  disabled={deletingContacts}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className={styles.formActions}>
                <Button type="button" variant="ghost" onClick={closeContactDeleteModal}>
                  Cancelar
                </Button>
                <Button
                  variant="danger"
                  onClick={handleConfirmDeleteContacts}
                  disabled={contactDeleteConfirmation.trim().toUpperCase() !== DELETE_CONFIRMATION_WORD}
                >
                  Eliminar
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
      </div>
    </PageContainer>
  )
}

const getBulkActionIdFromPath = (pathname: string) => {
  const match = pathname.match(/^\/contacts\/bulk-actions\/([^/]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : ''
}

export const Contacts: React.FC = () => {
  const location = useLocation()
  const bulkActionId = getBulkActionIdFromPath(location.pathname)

  if (bulkActionId) {
    return <ContactBulkActionProgress actionId={bulkActionId} />
  }

  return <ContactsTable />
}
