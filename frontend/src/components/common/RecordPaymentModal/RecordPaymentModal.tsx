import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { TabList } from '../TabList'
import { CustomSelect } from '../CustomSelect'
import { NumberInput } from '../NumberInput'
import { PhoneDateField } from '@/components/phone/PhoneDateField'
import { PhoneSelect } from '@/components/phone/PhoneSelect'
import { PhoneSegmentedTabs } from '@/components/phone/ui'
import { PaymentPlatformLogo } from '@/components/common/PaymentPlatformLogo'
import { ContactSearchInput, type ContactSearchInputContact } from '../ContactSearchInput/ContactSearchInput'
import { useHideOnScrollDown } from '@/hooks/useHideOnScrollDown'
import {
  Search,
  Loader2,
  X,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Link as LinkIcon,
  Check,
  AlertCircle,
  Send,
  Percent,
  Plus,
  Trash2,
  ShieldCheck,
  User,
  Copy
} from 'lucide-react'
import styles from './RecordPaymentModal.module.css'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAuth } from '@/contexts/AuthContext'
import { useAccountCurrency } from '@/hooks'
import { apiUrl } from '@/services/apiBaseUrl'
import { getIntegrationsStatus } from '@/services/integrationsService'
import { formatCurrency as formatMxCurrency } from '@/utils/format'
import { buildPaymentTimestamp } from '@/utils/paymentDate'
import { todayDateOnlyInTimezone } from '@/utils/timezone'
import { DEFAULT_CRM_LABELS, formatCrmLabelLower } from '@/utils/crmLabels'
import { highLevelService } from '@/services/highLevelService'
import { transactionsService } from '@/services/transactionsService'
import { conektaPaymentsService, type ConektaSavedPaymentSource } from '@/services/conektaPaymentsService'
import { clipPaymentsService } from '@/services/clipPaymentsService'
import { mercadoPagoPaymentsService } from '@/services/mercadoPagoPaymentsService'
import { rebillPaymentsService, type RebillSavedPaymentSource } from '@/services/rebillPaymentsService'
import { stripePaymentsService, type StripeSavedPaymentMethod } from '@/services/stripePaymentsService'
import { suppressContactAutofill } from '@/utils/browserAutofill'
import { resolveStableRequestIntent, type StableRequestIntent } from '@/utils/requestIntent'
import {
  defaultPaymentSettings,
  paymentSettingsService,
  type PaymentTaxSettings
} from '@/services/paymentSettingsService'
import {
  getGigstackUnitName,
  gigstackProductKeyOptions,
  gigstackUnitOptions,
  isValidGigstackProductKey,
  isValidGigstackUnitKey,
  normalizeGigstackProductKeyInput,
  normalizeGigstackUnitKeyInput
} from '@/utils/gigstackFiscalCatalog'
import { PaymentLinkReadyPanel, type PaymentLinkReadyData } from '../PaymentLinkReadyPanel'
import {
  hasPaymentGatewaysAccess,
  hasPaymentLinksAccess,
  hasPaymentPlansAccess,
  hasSavedPaymentMethodsAccess
} from '@/utils/accessControl'

const DEFAULT_INVOICE_TITLE = 'Pago'
const CONTACT_SEARCH_DELAY_MS = 90

const formatCurrency = (value: number, currency = 'MXN'): string => formatMxCurrency(value, currency)
const ZERO_DECIMAL_CURRENCIES = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'])
const toCurrencyMinorUnits = (value: number, currency: string) => (
  Math.round(value * (ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100))
)

const createPaymentPlanRequestKey = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `ristak-plan-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

const normalizeAmount = (value: string | number): number => {
  if (typeof value === 'number') {
    return Math.round(value * 100) / 100
  }
  if (!value) return 0
  const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''))
  if (Number.isNaN(parsed)) return 0
  return Math.round(parsed * 100) / 100
}

const getConfiguredTaxRate = (taxes: PaymentTaxSettings) => {
  const rateValue = Number(taxes.rateValue)
  return Number.isFinite(rateValue) ? rateValue : 0
}

const getConfiguredTaxName = (taxes: PaymentTaxSettings) => taxes.taxName?.trim() || 'Impuesto'

const calculateConfiguredTax = (
  amount: number,
  taxes: PaymentTaxSettings,
  applyTax: boolean,
  calculationMode: PaymentTaxSettings['calculationMode']
) => {
  const rateValue = getConfiguredTaxRate(taxes)

  if (!taxes.enabled || !applyTax || amount <= 0 || rateValue <= 0) {
    return {
      subtotalAmount: amount,
      taxAmount: 0,
      totalAmount: amount,
      includesTax: false,
      calculationMode
    }
  }

  if (calculationMode === 'inclusive') {
    const taxAmount = normalizeAmount(amount - (amount / (1 + rateValue / 100)))
    return {
      subtotalAmount: normalizeAmount(amount - taxAmount),
      taxAmount,
      totalAmount: amount,
      includesTax: true,
      calculationMode
    }
  }

  const taxAmount = normalizeAmount(amount * (rateValue / 100))
  return {
    subtotalAmount: amount,
    taxAmount,
    totalAmount: normalizeAmount(amount + taxAmount),
    includesTax: true,
    calculationMode
  }
}

type PaymentOption = 'send' | 'manual' | 'stripe' | 'stripe_saved_card' | 'mercadopago' | 'conekta' | 'conekta_saved_card' | 'clip' | 'rebill' | 'rebill_saved_card'
type PaymentMode = 'single' | 'partial'
type SinglePaymentAction = 'payment_link' | 'saved_card' | 'manual'
type SinglePaymentOptionsStage = 'method' | 'saved_cards' | 'gateway' | 'gateway_config' | 'confirm'
type InstallmentValueType = 'percentage' | 'amount'
type FirstPaymentMethod = '' | 'cash' | 'bank_transfer' | 'deposit' | 'card'
type RemainingFrequency = 'custom' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly'
type StripePlanCardSource = 'new_card' | 'saved_card'
type SendMethod = 'whatsapp' | 'sms' | 'email' | 'email_whatsapp' | 'email_sms' | 'all'
type InvoiceSendMethod = 'email' | 'sms' | 'both'
type StripeInstallmentChoice = '3' | '6' | '9' | '12' | '18' | '24'
type MercadoPagoInstallmentChoice = 'none' | '2' | '3' | '6' | '9' | '12' | '18' | '24'
type ConektaInstallmentChoice = 'none' | '3' | '6' | '9' | '12' | '18' | '24'
type RebillInstallmentChoice = '3' | '6' | '9' | '12' | '18' | '24'
type InstallmentChargeMode = 'single' | 'installments'
type PaymentSegmentedOption = { value: string; label: string }
type PaymentSelectOption = { value: string; label: string; description?: string; disabled?: boolean }
type RecordPaymentStep = 'form' | 'options' | 'processing' | 'link_ready'

const INSTALLMENT_VALUE_TYPE_OPTIONS = [
  { value: 'amount', label: 'Monto fijo' },
  { value: 'percentage', label: 'Porcentaje' }
]

// Primer pago integrado en la fila #1 del plan, en dos niveles:
// 1) cuándo se cobra — 'scheduled' (sin enganche, el #1 es un cobro programado más)
//    o 'immediate' (enganche cobrado de inmediato).
const FIRST_PAYMENT_TIMING_OPTIONS = [
  { value: 'immediate', label: 'Cobrar inmediato' },
  { value: 'scheduled', label: 'Cobro programado' }
]
// 2) cómo se cobra ese primer pago inmediato (solo visible al elegir 'immediate').
const FIRST_PAYMENT_IMMEDIATE_METHOD_OPTIONS = [
  { value: 'card', label: 'Tarjeta / link' },
  { value: 'bank_transfer', label: 'Transferencia' },
  { value: 'cash', label: 'Efectivo' },
  { value: 'deposit', label: 'Depósito' }
]

const REMAINING_FREQUENCY_OPTIONS = [
  { value: 'daily', label: 'Diario' },
  { value: 'weekly', label: 'Semanal' },
  { value: 'biweekly', label: 'Quincenal' },
  { value: 'monthly', label: 'Mensual' },
  { value: 'yearly', label: 'Anual' },
  { value: 'custom', label: 'Personalizada' }
]

const LINK_READY_SUCCESS_CONTEXT: RecordPaymentSuccessContext = {
  keepOpen: true,
  paymentLinkReady: true
}
const PAYMENT_PLAN_LINK_READY_SUCCESS_CONTEXT: RecordPaymentSuccessContext = {
  keepOpen: true,
  paymentLinkReady: true,
  paymentPlanChanged: true
}
const PAYMENT_PLAN_CHANGED_SUCCESS_CONTEXT: RecordPaymentSuccessContext = {
  paymentPlanChanged: true
}

const MANUAL_PAYMENT_METHOD_OPTIONS = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'bank_transfer', label: 'Transferencia bancaria' },
  { value: 'card', label: 'Tarjeta' },
  { value: 'check', label: 'Cheque' },
  { value: 'other', label: 'Otro' }
]

const MERCADOPAGO_INSTALLMENT_OPTIONS: Array<{ value: MercadoPagoInstallmentChoice; label: string }> = [
  { value: 'none', label: 'Sin meses: pago de contado' },
  { value: '2', label: 'Hasta 2 meses' },
  { value: '3', label: 'Hasta 3 meses' },
  { value: '6', label: 'Hasta 6 meses' },
  { value: '9', label: 'Hasta 9 meses' },
  { value: '12', label: 'Hasta 12 meses' },
  { value: '18', label: 'Hasta 18 meses' },
  { value: '24', label: 'Hasta 24 meses' }
]

const STRIPE_INSTALLMENT_MIN_AMOUNT = 300
const CLIP_INSTALLMENT_MIN_AMOUNT = 300
const CLIP_INSTALLMENT_MAX_MONTHS = 24

const STRIPE_INSTALLMENT_OPTIONS: Array<{ value: StripeInstallmentChoice; label: string }> = [
  { value: '3', label: 'Hasta 3 meses' },
  { value: '6', label: 'Hasta 6 meses' },
  { value: '9', label: 'Hasta 9 meses' },
  { value: '12', label: 'Hasta 12 meses' },
  { value: '18', label: 'Hasta 18 meses' },
  { value: '24', label: 'Hasta 24 meses' }
]

const REBILL_INSTALLMENT_OPTIONS: Array<{ value: RebillInstallmentChoice; label: string }> = [
  { value: '3', label: 'Hasta 3 meses' },
  { value: '6', label: 'Hasta 6 meses' },
  { value: '9', label: 'Hasta 9 meses' },
  { value: '12', label: 'Hasta 12 meses' },
  { value: '18', label: 'Hasta 18 meses' },
  { value: '24', label: 'Hasta 24 meses' }
]

const CONEKTA_INSTALLMENT_TERMS: Array<{ value: ConektaInstallmentChoice; months: number; minAmount: number; issuer?: string }> = [
  { value: '3', months: 3, minAmount: 300 },
  { value: '6', months: 6, minAmount: 600 },
  { value: '9', months: 9, minAmount: 900 },
  { value: '12', months: 12, minAmount: 1200 },
  { value: '18', months: 18, minAmount: 1800, issuer: 'Citibanamex' },
  { value: '24', months: 24, minAmount: 2400, issuer: 'BBVA, Banorte y Afirme' }
]

const getMercadoPagoInstallmentLimit = (choice: MercadoPagoInstallmentChoice) => {
  if (choice === 'none') return 1
  const parsed = Number(choice)
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : 1
}

const getStripeInstallmentLimit = (choice: StripeInstallmentChoice) => {
  const parsed = Number(choice)
  return Number.isFinite(parsed) ? Math.max(3, Math.trunc(parsed)) : 3
}

const getRebillInstallmentLimit = (choice: RebillInstallmentChoice) => {
  const parsed = Number(choice)
  return Number.isFinite(parsed) ? Math.max(3, Math.trunc(parsed)) : 3
}

const getConektaInstallmentLimit = (choice: ConektaInstallmentChoice) => {
  if (choice === 'none') return 1
  const parsed = Number(choice)
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : 1
}

const getConektaInstallmentTermLabel = (term: typeof CONEKTA_INSTALLMENT_TERMS[number]) => (
  `${term.months} meses${term.issuer ? ` (${term.issuer})` : ''}`
)

const formatConektaInstallmentMinimum = (amount: number, currency = 'MXN') => (
  `${formatCurrency(amount, currency)} ${currency}`
)

const getConektaInstallmentOptions = (amount: number, currency = 'MXN'): PaymentSelectOption[] => {
  const normalizedAmount = Number(amount || 0)

  return CONEKTA_INSTALLMENT_TERMS.map((term) => {
    const minimumLabel = formatConektaInstallmentMinimum(term.minAmount, currency)
    const available = normalizedAmount >= term.minAmount
    const termLabel = getConektaInstallmentTermLabel(term)

    return {
      value: term.value,
      label: available ? termLabel : `${termLabel} - mínimo ${minimumLabel}`,
      description: available ? `Disponible desde ${minimumLabel}` : `Necesita mínimo ${minimumLabel}`,
      disabled: !available
    }
  })
}

interface InstallmentDraft {
  id: string
  type: InstallmentValueType
  value: string
  dueDate: string
}

export interface RecordPaymentSuccessContext {
  keepOpen?: boolean
  paymentLinkReady?: boolean
  paymentPlanChanged?: boolean
}

interface RecordPaymentModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess?: (context?: RecordPaymentSuccessContext) => void | Promise<void>
  initialPaymentMode?: PaymentMode
  lockPaymentMode?: boolean
  initialContact?: Partial<Contact> | null
  lockInitialContact?: boolean
  showEmbeddedBackButton?: boolean
  /**
   * 'modal' (default) renderiza dentro del overlay Modal.
   * 'embedded' renderiza el mismo flujo sin overlay, para incrustarlo en una
   * página propia (por ejemplo la versión móvil de registro de pagos).
   */
  variant?: 'modal' | 'embedded'
  layout?: 'phone' | 'wide'
  /**
   * Activa una llave durable para el registro manual local. El mismo payload
   * conserva la llave durante un reintento; cambiarlo o reabrir el flujo la rota.
   */
  manualPaymentIdempotencyScope?: string
}

interface Contact {
  id: string
  name: string
  email: string
  phone: string
  firstName?: string
  lastName?: string
}

const normalizePaymentContact = (contact?: Partial<Contact> | null): Contact | null => {
  if (!contact?.id) return null

  return {
    id: contact.id,
    name: contact.name || '',
    email: contact.email || '',
    phone: contact.phone || '',
    firstName: contact.firstName || '',
    lastName: contact.lastName || ''
  }
}

const getContactInitials = (contact?: Partial<Contact> | null) => {
  const source = contact?.name || `${contact?.firstName || ''} ${contact?.lastName || ''}`.trim() || contact?.email || contact?.phone || ''
  const initials = source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')

  return initials || 'C'
}

const getContactDisplayName = (contact?: Partial<Contact> | null) => (
  contact?.name || `${contact?.firstName || ''} ${contact?.lastName || ''}`.trim() || contact?.email || contact?.phone || 'Sin nombre'
)

const getContactDisplayDetail = (contact?: Partial<Contact> | null) => (
  contact?.email || contact?.phone || 'Sin información de contacto'
)

const getSavedCardLabel = (method?: StripeSavedPaymentMethod | null) => {
  if (!method) return 'Tarjeta guardada'
  const brand = method.brand ? method.brand.toUpperCase() : 'Tarjeta'
  return `${brand} •••• ${method.last4 || '----'}`
}

const getSavedCardDescription = (method?: StripeSavedPaymentMethod | null) => {
  const label = getSavedCardLabel(method)
  return method?.expiresLabel ? `${label} · vence ${method.expiresLabel}` : label
}

const getSavedStripePaymentMethodId = (method?: StripeSavedPaymentMethod | null) => (
  method?.stripePaymentMethodId || method?.id || ''
)

const getSavedConektaCardLabel = (source?: ConektaSavedPaymentSource | null) => {
  if (!source) return 'Tarjeta guardada'
  const brand = source.brand ? source.brand.toUpperCase() : 'Tarjeta'
  return `${brand} •••• ${source.last4 || '----'}`
}

const getSavedConektaCardDescription = (source?: ConektaSavedPaymentSource | null) => {
  const label = getSavedConektaCardLabel(source)
  return source?.expiresLabel ? `${label} · vence ${source.expiresLabel}` : label
}

const getSavedConektaPaymentSourceId = (source?: ConektaSavedPaymentSource | null) => (
  source?.conektaPaymentSourceId || source?.id || ''
)

const getSavedRebillCardLabel = (source?: RebillSavedPaymentSource | null) => {
  if (!source) return 'Tarjeta guardada'
  const brand = source.brand ? source.brand.toUpperCase() : 'Rebill'
  return `${brand} •••• ${source.last4 || '----'}`
}

const getSavedRebillCardDescription = (source?: RebillSavedPaymentSource | null) => getSavedRebillCardLabel(source)

const getSavedRebillPaymentSourceId = (source?: RebillSavedPaymentSource | null) => (
  source?.rebillCardId || source?.id || ''
)

const EMAIL_SEND_METHODS = new Set<SendMethod>(['email', 'email_whatsapp', 'email_sms', 'all'])
const PHONE_SEND_METHODS = new Set<SendMethod>(['whatsapp', 'sms', 'email_whatsapp', 'email_sms', 'all'])
const SMS_SEND_METHODS = new Set<SendMethod>(['sms', 'email_sms', 'all'])
const WHATSAPP_SEND_METHODS = new Set<SendMethod>(['whatsapp', 'email_whatsapp', 'all'])
const DEFAULT_SEND_METHOD: SendMethod = 'all'

const getSendMethodOptions = (contact: Contact | null) => {
  const hasEmail = Boolean(contact?.email)
  const hasPhone = Boolean(contact?.phone)
  const options: Array<{ value: SendMethod; label: string }> = []

  if (hasPhone) {
    options.push({ value: 'whatsapp', label: 'WhatsApp' })
    options.push({ value: 'sms', label: 'SMS' })
  }

  if (hasEmail) {
    options.push({ value: 'email', label: 'Email' })
  }

  if (hasEmail && hasPhone) {
    options.push({ value: 'email_whatsapp', label: 'Email + WhatsApp' })
    options.push({ value: 'email_sms', label: 'Email + SMS' })
    options.push({ value: 'all', label: 'Todos' })
  }

  return options
}

const getDefaultSendMethod = (options: Array<{ value: SendMethod; label: string }>) => (
  options.find(option => option.value === DEFAULT_SEND_METHOD)?.value || options[0]?.value || DEFAULT_SEND_METHOD
)

const getSendMethodLabel = (method: SendMethod) => {
  const labels: Record<SendMethod, string> = {
    whatsapp: 'WhatsApp',
    sms: 'SMS',
    email: 'email',
    email_whatsapp: 'email y WhatsApp',
    email_sms: 'email y SMS',
    all: 'todos los canales'
  }

  return labels[method]
}

const toInvoiceSendMethod = (method: SendMethod): InvoiceSendMethod => {
  if (method === 'email') return 'email'
  if (method === 'sms' || method === 'whatsapp') return 'sms'
  return 'both'
}

interface Product {
  _id: string
  id: string
  localId?: string
  ghlProductId?: string | null
  name: string
  description?: string
  currency?: string
  syncStatus?: string
  gigstackProductKey?: string
  gigstackUnitKey?: string
  gigstackUnitName?: string
  prices?: Price[]
}

interface Price {
  _id: string
  id: string
  localId?: string
  ghlPriceId?: string | null
  localProductId?: string
  name: string
  amount: number
  price: number
  currency: string
  syncStatus?: string
}

interface InvoiceSummary {
  contactId: string
  contactName: string
  contactEmail?: string
  amount: number
  subtotal: number
  taxAmount: number
  includesTax: boolean
  taxName: string
  taxRate: number
  taxCalculationMode: PaymentTaxSettings['calculationMode']
  taxBaseAmount: number
  currency: string
  description: string
  invoiceId?: string
}

interface ManualPaymentData {
  paymentDate: string
  paymentMethod: string
  reference: string
  notes: string
}

type CreatedPaymentLink = PaymentLinkReadyData

const toDateInputValue = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const getBusinessTodayInputValue = (timezone: string) => todayDateOnlyInTimezone(timezone)

const defaultManualPaymentData = (timezone: string): ManualPaymentData => ({
  paymentDate: getBusinessTodayInputValue(timezone),
  paymentMethod: 'bank_transfer',
  reference: '',
  notes: ''
})

const addDays = (date: Date, days: number) => {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

const addMonths = (date: Date, months: number) => {
  const next = new Date(date)
  const originalDay = next.getDate()
  next.setDate(1)
  next.setMonth(next.getMonth() + months)
  const lastDayOfTargetMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
  next.setDate(Math.min(originalDay, lastDayOfTargetMonth))
  return next
}

const createInstallmentId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const defaultPartialInstallments = (timezone: string): InstallmentDraft[] => {
  const today = new Date(`${getBusinessTodayInputValue(timezone)}T00:00:00`)
  return [
    {
      id: createInstallmentId(),
      type: 'amount',
      value: '0',
      dueDate: toDateInputValue(addMonths(today, 1))
    },
    {
      id: createInstallmentId(),
      type: 'amount',
      value: '0',
      dueDate: toDateInputValue(addMonths(today, 2))
    }
  ]
}

const getNextDueDate = (baseDate: string, frequency: RemainingFrequency, index: number, timezone: string) => {
  const base = new Date(`${baseDate || getBusinessTodayInputValue(timezone)}T00:00:00`)

  if (frequency === 'daily') {
    return toDateInputValue(addDays(base, index))
  }

  if (frequency === 'weekly') {
    return toDateInputValue(addDays(base, 7 * index))
  }

  if (frequency === 'biweekly') {
    return toDateInputValue(addDays(base, 14 * index))
  }

  if (frequency === 'yearly') {
    return toDateInputValue(addMonths(base, 12 * index))
  }

  return toDateInputValue(addMonths(base, index))
}

const getRemainingDueDateOffset = (zeroBasedIndex: number) => zeroBasedIndex + 1

const getDateOnly = (value: string) => {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : ''
}

const buildPlanChargeDateValue = (dateValue: string) => {
  const dateOnly = getDateOnly(dateValue)
  if (!dateOnly) return ''
  return dateOnly
}

const buildFirstPaymentChargeDateValue = (dateValue: string, immediate: boolean, timezone: string) => {
  const dateOnly = getDateOnly(dateValue)
  if (!dateOnly) return ''
  if (immediate && dateOnly === todayDateOnlyInTimezone(timezone)) return new Date().toISOString()
  return dateOnly
}

const getCollisionReflowFrequency = (frequency: RemainingFrequency): RemainingFrequency => (
  frequency === 'custom' ? 'monthly' : frequency
)

const reflowRemainingDatesAfterFirstPayment = (
  installments: InstallmentDraft[],
  firstPaymentDate: string,
  frequency: RemainingFrequency,
  timezone: string
) => {
  const firstDate = getDateOnly(firstPaymentDate)
  if (!firstDate || !installments.some((installment) => getDateOnly(installment.dueDate) === firstDate)) {
    return installments
  }

  const reflowFrequency = getCollisionReflowFrequency(frequency)
  return installments.map((installment, index) => ({
    ...installment,
    dueDate: getNextDueDate(firstPaymentDate, reflowFrequency, getRemainingDueDateOffset(index), timezone)
  }))
}

const resolvePartialAmount = (type: InstallmentValueType, value: string, totalAmount: number) => {
  const parsedValue = normalizeAmount(value)
  return type === 'percentage'
    ? normalizeAmount(totalAmount * (parsedValue / 100))
    : parsedValue
}

const formatInstallmentValue = (value: number) => {
  const rounded = Math.round(value * 100) / 100
  return String(rounded).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

const getRemainingPercentages = (
  count: number,
  firstEnabled: boolean,
  firstType: InstallmentValueType,
  firstValue: string,
  total: number
) => {
  if (count <= 0) return []

  const firstAmount = firstEnabled
    ? resolvePartialAmount(firstType, firstValue, total)
    : 0
  const firstPercent = firstEnabled
    ? firstType === 'percentage'
      ? normalizeAmount(firstValue)
      : total > 0
        ? normalizeAmount((firstAmount / total) * 100)
        : 0
    : 0
  const remainingPercent = Math.max(0, normalizeAmount(100 - firstPercent))
  const base = Math.floor((remainingPercent / count) * 100) / 100

  return Array.from({ length: count }, (_, index) => {
    if (index === count - 1) {
      return normalizeAmount(remainingPercent - base * (count - 1))
    }

    return normalizeAmount(base)
  })
}

const getRemainingFixedAmounts = (
  count: number,
  firstEnabled: boolean,
  firstType: InstallmentValueType,
  firstValue: string,
  total: number
) => {
  if (count <= 0) return []

  const firstAmount = firstEnabled
    ? resolvePartialAmount(firstType, firstValue, total)
    : 0
  const remainingAmount = Math.max(0, normalizeAmount(total - firstAmount))
  const base = Math.floor((remainingAmount / count) * 100) / 100

  return Array.from({ length: count }, (_, index) => {
    if (index === count - 1) {
      return normalizeAmount(remainingAmount - base * (count - 1))
    }

    return normalizeAmount(base)
  })
}

const getRemainingDistributedValues = (
  count: number,
  valueType: InstallmentValueType,
  firstEnabled: boolean,
  firstType: InstallmentValueType,
  firstValue: string,
  total: number
) => {
  const values = valueType === 'percentage'
    ? getRemainingPercentages(count, firstEnabled, firstType, firstValue, total)
    : getRemainingFixedAmounts(count, firstEnabled, firstType, firstValue, total)

  return values.map(formatInstallmentValue)
}

const isOfflineFirstPaymentMethod = (method: FirstPaymentMethod) => (
  method === 'cash' || method === 'bank_transfer' || method === 'deposit'
)

export const RecordPaymentModal: React.FC<RecordPaymentModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  initialPaymentMode = 'single',
  lockPaymentMode = false,
  initialContact = null,
  lockInitialContact = false,
  showEmbeddedBackButton = true,
  variant = 'modal',
  layout = 'phone',
  manualPaymentIdempotencyScope = ''
}) => {
  const { user } = useAuth()
  const { timezone } = useTimezone()
  const { labels } = useLabels()
  const customerLabel = labels.customer?.trim() || DEFAULT_CRM_LABELS.customer
  const customerLowerLabel = formatCrmLabelLower(customerLabel, DEFAULT_CRM_LABELS.customer)
  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState<RecordPaymentStep>('form')
  const paymentPlanRequestKeyRef = useRef('')
  const manualPaymentRequestRef = useRef<StableRequestIntent | null>(null)

  // Contact search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchingContact, setSearchingContact] = useState(false)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [contactPickerOpen, setContactPickerOpen] = useState(false)

  // Charge type
  const [chargeType, setChargeType] = useState<'direct' | 'product'>('direct')

  // Direct charge
  const [amount, setAmount] = useState('')
  const [paymentTitle, setPaymentTitle] = useState('')
  const [description, setDescription] = useState('')
  const [currency, setCurrency] = useState('MXN')
  const [includeIVA, setIncludeIVA] = useState(false)
  const [taxCalculationMode, setTaxCalculationMode] = useState<PaymentTaxSettings['calculationMode']>(defaultPaymentSettings.taxes.calculationMode)
  const [paymentTaxes, setPaymentTaxes] = useState<PaymentTaxSettings>(defaultPaymentSettings.taxes)

  // Partial payments
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('single')
  const [firstPaymentEnabled, setFirstPaymentEnabled] = useState(false)
  const [firstPaymentType, setFirstPaymentType] = useState<InstallmentValueType>('amount')
  const [firstPaymentValue, setFirstPaymentValue] = useState('')
  // Escritorio: cuando está en true, el primer pago se reparte como una parcialidad
  // más (parte igual del total). Se apaga en cuanto el usuario edita su monto.
  const [firstPaymentAuto, setFirstPaymentAuto] = useState(true)
  const [firstPaymentDate, setFirstPaymentDate] = useState(() => getBusinessTodayInputValue(timezone))
  const [firstPaymentMethod, setFirstPaymentMethod] = useState<FirstPaymentMethod>('')
  const [remainingAutomatic, setRemainingAutomatic] = useState(true)
  const [remainingValueType, setRemainingValueType] = useState<InstallmentValueType>('amount')
  const [remainingFrequency, setRemainingFrequency] = useState<RemainingFrequency>('monthly')
  const [remainingInstallments, setRemainingInstallments] = useState<InstallmentDraft[]>(() => defaultPartialInstallments(timezone))
  const [autoDistributeRemaining, setAutoDistributeRemaining] = useState(true)

  // Business details used by payment documents and optional gateway syncs.
  const [businessName, setBusinessName] = useState('Mi Negocio')
  const [businessEmail, setBusinessEmail] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [businessPhone, setBusinessPhone] = useState('')
  const [businessAddress, setBusinessAddress] = useState('')
  const [businessCity, setBusinessCity] = useState('')
  const [businessState, setBusinessState] = useState('')
  const [businessCountry, setBusinessCountry] = useState('')
  const [businessPostalCode, setBusinessPostalCode] = useState('')
  const [businessWebsite, setBusinessWebsite] = useState('')
  const [invoiceTermsNotes, setInvoiceTermsNotes] = useState<string | null>(null)
  const [invoiceDueDays, setInvoiceDueDays] = useState(7)
  const [cardSetupAmount, setCardSetupAmount] = useState(25)
  const [ghlInvoiceMode, setGhlInvoiceMode] = useState<'live' | 'test'>('live')

  // Product charge
  const [products, setProducts] = useState<Product[]>([])
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [prices, setPrices] = useState<Price[]>([])
  const [selectedPrice, setSelectedPrice] = useState<Price | null>(null)
  const [customAmount, setCustomAmount] = useState('')
  const [loadingProducts, setLoadingProducts] = useState(false)
  const [showCreateProduct, setShowCreateProduct] = useState(false)
  const [creatingProduct, setCreatingProduct] = useState(false)
  const [newProductName, setNewProductName] = useState('')
  const [newProductDescription, setNewProductDescription] = useState('')
  const [newProductPriceName, setNewProductPriceName] = useState('')
  const [newProductAmount, setNewProductAmount] = useState('')
  const [newProductGigstackProductKey, setNewProductGigstackProductKey] = useState('')
  const [newProductGigstackUnitKey, setNewProductGigstackUnitKey] = useState('')

  // Payment options
  const [invoicePayload, setInvoicePayload] = useState<Record<string, any> | null>(null)
  const [invoiceSummary, setInvoiceSummary] = useState<InvoiceSummary | null>(null)
  const [singlePaymentAction, setSinglePaymentAction] = useState<SinglePaymentAction>('payment_link')
  const [singlePaymentOptionsStage, setSinglePaymentOptionsStage] = useState<SinglePaymentOptionsStage>('method')
  const [paymentOption, setPaymentOption] = useState<PaymentOption>('send')
  const [sendMethod, setSendMethod] = useState<SendMethod>(DEFAULT_SEND_METHOD)
  const [installmentChargeMode, setInstallmentChargeMode] = useState<InstallmentChargeMode>('single')
  const [stripeInstallmentChoice, setStripeInstallmentChoice] = useState<StripeInstallmentChoice>('24')
  const [mercadoPagoInstallmentChoice, setMercadoPagoInstallmentChoice] = useState<MercadoPagoInstallmentChoice>('none')
  const [conektaInstallmentChoice, setConektaInstallmentChoice] = useState<ConektaInstallmentChoice>('none')
  const [rebillInstallmentChoice, setRebillInstallmentChoice] = useState<RebillInstallmentChoice>('12')
  const [conektaSavedCardGatewayConfirmed, setConektaSavedCardGatewayConfirmed] = useState(false)
  const [manualPaymentData, setManualPaymentData] = useState<ManualPaymentData>(() => defaultManualPaymentData(timezone))
  const [transferInfoUrl, setTransferInfoUrl] = useState<string | null>(null)
  const [savedPaymentMethods, setSavedPaymentMethods] = useState<StripeSavedPaymentMethod[]>([])
  const [selectedSavedPaymentMethodId, setSelectedSavedPaymentMethodId] = useState('')
  const [savedConektaPaymentSources, setSavedConektaPaymentSources] = useState<ConektaSavedPaymentSource[]>([])
  const [selectedConektaPaymentSourceId, setSelectedConektaPaymentSourceId] = useState('')
  const [savedRebillPaymentSources, setSavedRebillPaymentSources] = useState<RebillSavedPaymentSource[]>([])
  const [selectedRebillPaymentSourceId, setSelectedRebillPaymentSourceId] = useState('')
  const [stripePlanCardSource, setStripePlanCardSource] = useState<StripePlanCardSource>('new_card')
  const [createdPaymentLink, setCreatedPaymentLink] = useState<CreatedPaymentLink | null>(null)

  // Estado de conexión con pasarelas. Ristak opera sin HighLevel; cada gateway
  // habilita sólo las acciones que realmente soporta.
  const [highLevelConnected, setHighLevelConnected] = useState(false)
  const [stripeConnected, setStripeConnected] = useState(false)
  const [conektaConnected, setConektaConnected] = useState(false)
  const [mercadoPagoConnected, setMercadoPagoConnected] = useState(false)
  const [clipConnected, setClipConnected] = useState(false)
  const [rebillConnected, setRebillConnected] = useState(false)

  const { showToast } = useNotification()
  const [accountCurrency] = useAccountCurrency()
  const embeddedScrollRef = useRef<HTMLDivElement | null>(null)
  const [embeddedScrollEl, setEmbeddedScrollEl] = useState<HTMLDivElement | null>(null)
  const embeddedBackHidden = useHideOnScrollDown(embeddedScrollEl)
  const renderPaymentSelect = ({
    value,
    onChange,
    options,
    title,
    placeholder,
    invalid = false,
    includeDisabledOptions = false,
    dropdownMinWidth
  }: {
    value: string;
    onChange: (value: string) => void;
    options: PaymentSelectOption[];
    title: string;
    placeholder?: string;
    invalid?: boolean;
    includeDisabledOptions?: boolean;
    dropdownMinWidth?: number;
  }) => (
    variant === 'embedded' ? (
      <PhoneSelect
        value={value}
        onChange={onChange}
        options={options}
        title={title}
        placeholder={placeholder || title}
        invalid={invalid}
        buttonClassName={styles.phoneSelectButton}
        inlineOnWide
      />
    ) : (
      <CustomSelect
        value={value}
        onValueChange={onChange}
        options={includeDisabledOptions ? options : options.filter((option) => !option.disabled)}
        placeholder={placeholder || title}
        className={styles.customSelectControl}
        dropdownMinWidth={dropdownMinWidth}
        portal
      />
    )
  )

  const canUsePaymentGateways = hasPaymentGatewaysAccess(user)
  const canUsePaymentLinks = hasPaymentLinksAccess(user)
  const canUsePaymentPlans = hasPaymentPlansAccess(user)
  const canUseSavedPaymentMethods = hasSavedPaymentMethodsAccess(user)
  const hasPaymentPlanProviders = highLevelConnected || stripeConnected || conektaConnected || rebillConnected
  const canChoosePaymentMode = canUsePaymentPlans && hasPaymentPlanProviders && (chargeType === 'direct' || Boolean(selectedProduct && selectedPrice))
  const activePaymentMode: PaymentMode = lockPaymentMode
    ? paymentMode
    : canChoosePaymentMode
      ? paymentMode
      : 'single'
  const subtotalAmount = useMemo(() => (
    chargeType === 'product'
      ? normalizeAmount(customAmount)
      : normalizeAmount(amount)
  ), [amount, chargeType, customAmount])

  const currentTaxBreakdown = useMemo(() => (
    calculateConfiguredTax(subtotalAmount, paymentTaxes, includeIVA, taxCalculationMode)
  ), [includeIVA, paymentTaxes, subtotalAmount, taxCalculationMode])
  const gigstackProductMappingEnabled = Boolean(paymentTaxes.enabled && paymentTaxes.gigstackEnabled)
  const taxAmount = currentTaxBreakdown.taxAmount
  const totalAmount = currentTaxBreakdown.totalAmount
  const firstPaymentAmount = firstPaymentEnabled
    ? resolvePartialAmount(firstPaymentType, firstPaymentValue, totalAmount)
    : 0
  // El primer pago solo "cuenta" si tiene monto > 0. Un primer pago en $0 se envía
  // como sin enganche (enabled:false) para que TODAS las pasarelas lo acepten igual
  // que el flujo de parcialidades, en vez de rebotar con un error del servidor.
  const firstPaymentActive = firstPaymentEnabled && firstPaymentAmount > 0
  const effectiveRemainingValueType = firstPaymentEnabled ? firstPaymentType : remainingValueType
  const resolvedRemainingInstallments = useMemo(() => {
    return remainingInstallments.map((installment, index) => ({
      ...installment,
      type: effectiveRemainingValueType,
      sequence: index + 1,
      amount: resolvePartialAmount(effectiveRemainingValueType, installment.value, totalAmount),
      percentage: effectiveRemainingValueType === 'percentage' ? normalizeAmount(installment.value) : null
    }))
  }, [effectiveRemainingValueType, remainingInstallments, totalAmount])
  const remainingTotalAmount = normalizeAmount(
    resolvedRemainingInstallments.reduce((sum, installment) => sum + installment.amount, 0)
  )
  const partialPlanTotal = normalizeAmount(firstPaymentAmount + remainingTotalAmount)
  const partialPlanDifference = normalizeAmount(totalAmount - partialPlanTotal)
  const partialPlanMatches = toCurrencyMinorUnits(totalAmount, currency) === toCurrencyMinorUnits(partialPlanTotal, currency)
  const partialAllocatedPct = totalAmount > 0
    ? Math.min(100, Math.max(0, (partialPlanTotal / totalAmount) * 100))
    : 0
  const partialPlanStatus: 'ok' | 'under' | 'over' = partialPlanMatches
    ? 'ok'
    : partialPlanDifference > 0
      ? 'under'
      : 'over'
  const firstPaymentMethodMissing = activePaymentMode === 'partial' && firstPaymentActive && !firstPaymentMethod
  const partialNeedsCardAuthorization = activePaymentMode === 'partial' && remainingAutomatic && (
    !firstPaymentEnabled || isOfflineFirstPaymentMethod(firstPaymentMethod)
  )
  const sendMethodOptions = useMemo(() => getSendMethodOptions(selectedContact), [selectedContact?.email, selectedContact?.phone])
  const selectedSendMethodOption = sendMethodOptions.find(option => option.value === sendMethod)
  const savedPaymentMethodOptions = useMemo(() => (
    savedPaymentMethods.flatMap((method) => {
      const value = getSavedStripePaymentMethodId(method)
      return value ? [{ value, label: getSavedCardDescription(method) }] : []
    })
  ), [savedPaymentMethods])
  const selectedSavedPaymentMethod = savedPaymentMethods.find((method) => (
    getSavedStripePaymentMethodId(method) === selectedSavedPaymentMethodId
  )) || null
  const savedConektaPaymentSourceOptions = useMemo(() => (
    savedConektaPaymentSources.flatMap((source) => {
      const value = getSavedConektaPaymentSourceId(source)
      return value ? [{ value, label: getSavedConektaCardDescription(source) }] : []
    })
  ), [savedConektaPaymentSources])
  const selectedConektaPaymentSource = savedConektaPaymentSources.find((source) => (
    getSavedConektaPaymentSourceId(source) === selectedConektaPaymentSourceId
  )) || null
  const savedRebillPaymentSourceOptions = useMemo(() => (
    savedRebillPaymentSources.flatMap((source) => {
      const value = getSavedRebillPaymentSourceId(source)
      return value ? [{ value, label: getSavedRebillCardDescription(source) }] : []
    })
  ), [savedRebillPaymentSources])
  const selectedRebillPaymentSource = savedRebillPaymentSources.find((source) => (
    getSavedRebillPaymentSourceId(source) === selectedRebillPaymentSourceId
  )) || null
  const stripePlanSavedPaymentMethod = stripePlanCardSource === 'saved_card'
    ? selectedSavedPaymentMethod || savedPaymentMethods[0] || null
    : null
  const conektaPlanSavedPaymentSource = stripePlanCardSource === 'saved_card'
    ? selectedConektaPaymentSource || savedConektaPaymentSources[0] || null
    : null
  const rebillPlanSavedPaymentSource = stripePlanCardSource === 'saved_card'
    ? selectedRebillPaymentSource || savedRebillPaymentSources[0] || null
    : null
  const firstPaymentCanAuthorizeStripePlan = firstPaymentEnabled && firstPaymentMethod === 'card'
  const stripePlanNeedsSetupLink = stripePlanCardSource === 'new_card' && !firstPaymentCanAuthorizeStripePlan
  const stripePlanCanBeAuthorized = stripePlanCardSource === 'saved_card'
    ? Boolean(stripePlanSavedPaymentMethod)
    : firstPaymentCanAuthorizeStripePlan || stripePlanNeedsSetupLink
  const conektaPlanNeedsSetupLink = stripePlanCardSource === 'new_card' && !firstPaymentCanAuthorizeStripePlan
  const conektaPlanCanBeAuthorized = stripePlanCardSource === 'saved_card'
    ? Boolean(conektaPlanSavedPaymentSource)
    : firstPaymentCanAuthorizeStripePlan || conektaPlanNeedsSetupLink
  const rebillPlanNeedsSetupLink = stripePlanCardSource === 'new_card' && !firstPaymentCanAuthorizeStripePlan
  const rebillPlanCanBeAuthorized = stripePlanCardSource === 'saved_card'
    ? Boolean(rebillPlanSavedPaymentSource)
    : firstPaymentCanAuthorizeStripePlan || rebillPlanNeedsSetupLink
  const remainingFrequencyOptions = REMAINING_FREQUENCY_OPTIONS
  const contactLocked = Boolean(lockInitialContact && initialContact?.id)
  const isEmbedded = variant === 'embedded'
  const renderPaymentSegmentedTabs = ({
    options,
    value,
    onChange,
    ariaLabel,
    desktopFullWidth = true
  }: {
    options: PaymentSegmentedOption[]
    value: string
    onChange: (value: string) => void
    ariaLabel: string
    desktopFullWidth?: boolean
  }) => {
    if (isEmbedded) {
      return (
        <PhoneSegmentedTabs
          ariaLabel={ariaLabel}
          options={options}
          value={value}
          onChange={onChange}
        />
      )
    }

    return (
      <TabList
        tabs={options}
        activeTab={value}
        onTabChange={onChange}
        variant="compact"
        className={desktopFullWidth ? styles.fullWidthTabList : undefined}
      />
    )
  }

  const paymentLinkGatewayLabels = canUsePaymentLinks ? [
    stripeConnected ? 'Stripe' : null,
    conektaConnected ? 'Conekta' : null,
    mercadoPagoConnected ? 'Mercado Pago' : null,
    clipConnected ? 'CLIP' : null,
    rebillConnected ? 'Rebill' : null,
    highLevelConnected ? 'HighLevel' : null
  ].filter(Boolean) as string[] : []
  const paymentLinkGatewayCount = paymentLinkGatewayLabels.length
  const hasPaymentLinkGateways = paymentLinkGatewayCount > 0
  const hasMultiplePaymentLinkGateways = paymentLinkGatewayCount > 1
  const hasStripeSavedCards = canUseSavedPaymentMethods && stripeConnected && savedPaymentMethods.length > 0
  const hasConektaSavedCards = canUseSavedPaymentMethods && conektaConnected && savedConektaPaymentSources.length > 0
  const hasRebillSavedCards = canUseSavedPaymentMethods && rebillConnected && savedRebillPaymentSources.length > 0
  const savedCardGatewayLabels = [
    hasStripeSavedCards ? 'Stripe' : null,
    hasConektaSavedCards ? 'Conekta' : null,
    hasRebillSavedCards ? 'Rebill' : null
  ].filter(Boolean) as string[]
  const hasSavedCards = savedCardGatewayLabels.length > 0
  const paymentPlanGatewayLabels = canUsePaymentPlans ? [
    stripeConnected ? 'Stripe' : null,
    conektaConnected ? 'Conekta' : null,
    rebillConnected ? 'Rebill' : null,
    highLevelConnected ? 'HighLevel' : null
  ].filter(Boolean) as string[] : []
  const hasPaymentPlanGateways = paymentPlanGatewayLabels.length > 0
  const hasMultiplePaymentPlanGateways = paymentPlanGatewayLabels.length > 1
  const hasPaymentPlanSavedCards = hasStripeSavedCards || hasConektaSavedCards || hasRebillSavedCards
  const partialAuthorizationNotice = (() => {
    if (!hasPaymentPlanGateways) {
      return 'El plan se preparará con la pasarela conectada que elijas en el siguiente paso.'
    }

    if (hasPaymentPlanSavedCards) {
      return 'En el siguiente paso eliges la pasarela. Si esa pasarela ya tiene una tarjeta guardada, se usará para los cobros programados.'
    }

    if (firstPaymentEnabled && firstPaymentMethod === 'card') {
      return 'Si el primer pago se cobra con tarjeta o link, esa autorización puede activar los cobros futuros del plan.'
    }

    if (rebillConnected && !stripeConnected && !conektaConnected && !highLevelConnected) {
      return 'Rebill guardará una tarjeta y Ristak cobrará cada parcialidad cuando toque.'
    }

    return `Si el contacto no tiene una tarjeta guardada, la pasarela que elijas enviará una liga de domiciliación por ${formatCurrency(cardSetupAmount, currency)}. El plan no se activa hasta que esa tarjeta quede autorizada.`
  })()
  const defaultPaymentLinkOption: PaymentOption | null = stripeConnected
    ? 'stripe'
    : conektaConnected
        ? 'conekta'
        : mercadoPagoConnected
          ? 'mercadopago'
            : clipConnected
              ? 'clip'
              : rebillConnected
                ? 'rebill'
                : highLevelConnected
                  ? 'send'
                  : null
  const defaultPaymentPlanGatewayOption: PaymentOption | null = stripeConnected
    ? 'stripe'
    : conektaConnected
      ? 'conekta'
      : rebillConnected
        ? 'rebill'
        : highLevelConnected
          ? 'send'
          : null
  const defaultPaymentPlanSavedCardOption: PaymentOption | null = hasStripeSavedCards
    ? 'stripe'
    : hasConektaSavedCards
      ? 'conekta'
      : hasRebillSavedCards
        ? 'rebill'
        : null

  const getDefaultPaymentOption = (): PaymentOption => {
    if (stripeConnected) return 'stripe'
    if (conektaConnected) return 'conekta'
    if (mercadoPagoConnected) return 'mercadopago'
    if (clipConnected) return 'clip'
    if (rebillConnected) return 'rebill'
    return highLevelConnected ? 'send' : 'manual'
  }

  const getDefaultSavedCardOption = (): PaymentOption | null => {
    if (hasStripeSavedCards) return 'stripe_saved_card'
    if (hasConektaSavedCards) return 'conekta_saved_card'
    if (hasRebillSavedCards) return 'rebill_saved_card'
    return null
  }

  const getDefaultSinglePaymentAction = (): SinglePaymentAction => {
    if (hasPaymentLinkGateways) return 'payment_link'
    if (hasSavedCards) return 'saved_card'
    return 'manual'
  }

  const paymentLinkOptionNeedsConfiguration = (option: PaymentOption | null) => option === 'stripe' || option === 'mercadopago' || option === 'conekta' || option === 'clip' || option === 'rebill'

  const clipContactEmail = selectedContact?.email || invoiceSummary?.contactEmail || ''
  const clipContactPhone = selectedContact?.phone || ''
  const clipCurrency = (invoiceSummary?.currency || accountCurrency || 'MXN').toUpperCase()
  const clipCurrencyAvailable = clipCurrency === 'MXN'
  const clipContactReady = Boolean(clipContactEmail && clipContactPhone)
  const clipInstallmentsAmountAvailable = Number(invoiceSummary?.amount || 0) >= CLIP_INSTALLMENT_MIN_AMOUNT
  const clipInstallmentsAvailable = Boolean(invoiceSummary && clipCurrencyAvailable && clipInstallmentsAmountAvailable)
  const clipMsiEnabled = installmentChargeMode === 'installments' && clipInstallmentsAvailable
  const clipInstallmentPaymentLabel = clipInstallmentsAvailable
    ? 'CLIP lo mostrará si aplica'
    : `Desde ${formatCurrency(CLIP_INSTALLMENT_MIN_AMOUNT, 'MXN')}`

  const stripeInstallmentsCurrencyAvailable = (invoiceSummary?.currency || accountCurrency || 'MXN').toUpperCase() === 'MXN'
  const stripeInstallmentsAmountAvailable = Number(invoiceSummary?.amount || 0) >= STRIPE_INSTALLMENT_MIN_AMOUNT
  const stripeInstallmentsAvailable = Boolean(invoiceSummary && stripeInstallmentsCurrencyAvailable && stripeInstallmentsAmountAvailable)
  const stripeInstallmentLimit = getStripeInstallmentLimit(stripeInstallmentChoice)
  const stripeMsiEnabled = installmentChargeMode === 'installments' && stripeInstallmentsAvailable
  const stripeInstallmentPaymentLabel = stripeInstallmentsAvailable ? `Hasta ${stripeInstallmentLimit} meses` : `Desde ${formatCurrency(STRIPE_INSTALLMENT_MIN_AMOUNT, 'MXN')}`
  const stripeInstallmentEstimate = invoiceSummary && stripeMsiEnabled
    ? normalizeAmount(invoiceSummary.amount / stripeInstallmentLimit)
    : 0
  const mercadoPagoInstallmentLimit = getMercadoPagoInstallmentLimit(mercadoPagoInstallmentChoice)
  const mercadoPagoInstallmentEnabled = mercadoPagoInstallmentLimit > 1
  const mercadoPagoMsiEnabled = installmentChargeMode === 'installments' && mercadoPagoInstallmentEnabled
  const mercadoPagoInstallmentPaymentLabel = mercadoPagoInstallmentEnabled
    ? `Hasta ${mercadoPagoInstallmentLimit} meses`
    : 'Pago de contado'
  const mercadoPagoInstallmentEstimate = invoiceSummary && mercadoPagoInstallmentEnabled
    ? normalizeAmount(invoiceSummary.amount / mercadoPagoInstallmentLimit)
    : 0
  const conektaInstallmentOptions = invoiceSummary ? getConektaInstallmentOptions(invoiceSummary.amount, invoiceSummary.currency) : []
  const conektaInstallmentsAvailable = conektaInstallmentOptions.some((option) => !option.disabled)
  const conektaSelectedInstallmentOption = conektaInstallmentOptions.find((option) => option.value === conektaInstallmentChoice)
  const conektaInstallmentLimit = getConektaInstallmentLimit(conektaInstallmentChoice)
  const conektaInstallmentEnabled = conektaInstallmentLimit > 1 && !conektaSelectedInstallmentOption?.disabled
  const conektaMsiEnabled = installmentChargeMode === 'installments' && conektaInstallmentEnabled
  const conektaInstallmentPaymentLabel = conektaInstallmentEnabled
    ? `Hasta ${conektaInstallmentLimit} meses`
    : conektaInstallmentsAvailable
      ? 'Selecciona plazo'
      : `Desde ${formatConektaInstallmentMinimum(300, invoiceSummary?.currency || accountCurrency || 'MXN')}`
  const conektaInstallmentEstimate = invoiceSummary && conektaInstallmentEnabled
    ? normalizeAmount(invoiceSummary.amount / conektaInstallmentLimit)
    : 0
  const rebillInstallmentLimit = getRebillInstallmentLimit(rebillInstallmentChoice)
  const rebillMsiEnabled = installmentChargeMode === 'installments' && rebillInstallmentLimit > 1
  const rebillInstallmentPaymentLabel = rebillMsiEnabled ? `Hasta ${rebillInstallmentLimit} meses` : 'Pago de contado'
  const rebillInstallmentEstimate = invoiceSummary && rebillMsiEnabled
    ? normalizeAmount(invoiceSummary.amount / rebillInstallmentLimit)
    : 0
  const conektaSavedCardDescription = conektaInstallmentsAvailable
    ? 'Elige cobro único o meses sin intereses antes de cobrar.'
    : 'Se cobrará de contado; MSI requiere monto mínimo.'

  useEffect(() => {
    if (conektaInstallmentChoice === 'none') return
    const nextOptions = getConektaInstallmentOptions(invoiceSummary?.amount || 0, invoiceSummary?.currency || accountCurrency || 'MXN')
    const nextOption = nextOptions.find((option) => option.value === conektaInstallmentChoice)
    if (!nextOption || nextOption.disabled) {
      setConektaInstallmentChoice('none')
    }
  }, [accountCurrency, conektaInstallmentChoice, invoiceSummary?.amount, invoiceSummary?.currency])

  const resetInstallmentChargeMode = () => {
    setInstallmentChargeMode('single')
    setStripeInstallmentChoice('24')
    setMercadoPagoInstallmentChoice('none')
    setConektaInstallmentChoice('none')
    setRebillInstallmentChoice('12')
  }

  const openMercadoPagoInstallmentConfiguration = () => {
    setInstallmentChargeMode('installments')
    setMercadoPagoInstallmentChoice((current) => current === 'none' ? '3' : current)
  }

  const openStripeInstallmentConfiguration = () => {
    if (!stripeInstallmentsAvailable) return
    setInstallmentChargeMode('installments')
    setStripeInstallmentChoice((current) => current || '24')
  }

  const openClipInstallmentConfiguration = () => {
    if (!clipInstallmentsAvailable) return
    setInstallmentChargeMode('installments')
  }

  const openRebillInstallmentConfiguration = () => {
    setInstallmentChargeMode('installments')
    setRebillInstallmentChoice((current) => current || '12')
  }

  const openConektaInstallmentConfiguration = () => {
    const fallback = conektaInstallmentOptions.find((option) => !option.disabled)?.value as ConektaInstallmentChoice | undefined

    setInstallmentChargeMode('installments')
    setConektaInstallmentChoice((current) => (
      current !== 'none' && conektaInstallmentOptions.some((option) => option.value === current && !option.disabled)
        ? current
        : fallback || 'none'
    ))
  }

  const isSinglePaymentInstallmentContext = activePaymentMode !== 'partial' && (
    (
      singlePaymentAction === 'payment_link' &&
      singlePaymentOptionsStage === 'gateway_config' &&
      (paymentOption === 'stripe' || paymentOption === 'conekta' || paymentOption === 'mercadopago' || paymentOption === 'clip' || paymentOption === 'rebill')
    ) ||
    (
      singlePaymentAction === 'saved_card' &&
      singlePaymentOptionsStage === 'saved_cards' &&
      paymentOption === 'conekta_saved_card'
    )
  )
  const needsConektaInstallmentSelection = isSinglePaymentInstallmentContext &&
    (paymentOption === 'conekta' || paymentOption === 'conekta_saved_card') &&
    installmentChargeMode === 'installments' &&
    !conektaMsiEnabled
  const needsStripeInstallmentAvailability = isSinglePaymentInstallmentContext &&
    paymentOption === 'stripe' &&
    installmentChargeMode === 'installments' &&
    !stripeMsiEnabled
  const needsClipInstallmentAvailability = isSinglePaymentInstallmentContext &&
    paymentOption === 'clip' &&
    installmentChargeMode === 'installments' &&
    !clipMsiEnabled

  const goToSavedCardOptions = () => {
    const nextPaymentOption = getDefaultSavedCardOption()
    if (!nextPaymentOption) return

    resetInstallmentChargeMode()
    setConektaSavedCardGatewayConfirmed(false)
    setSinglePaymentAction('saved_card')
    setPaymentOption(nextPaymentOption)
    setSinglePaymentOptionsStage('saved_cards')
  }

  const selectSinglePaymentLinkAction = () => {
    setSinglePaymentAction('payment_link')
    const nextPaymentOption = defaultPaymentLinkOption || 'manual'
    setPaymentOption(nextPaymentOption)
    resetInstallmentChargeMode()
    setConektaSavedCardGatewayConfirmed(false)

    if (hasMultiplePaymentLinkGateways) {
      setSinglePaymentOptionsStage('gateway')
      return
    }

    if (paymentLinkOptionNeedsConfiguration(nextPaymentOption)) {
      setSinglePaymentOptionsStage('gateway_config')
      return
    }

    setSinglePaymentOptionsStage('method')
  }

  const selectPaymentPlanNewCardAction = () => {
    const nextPaymentOption = defaultPaymentPlanGatewayOption || 'manual'

    setSinglePaymentAction('payment_link')
    setStripePlanCardSource('new_card')
    setPaymentOption(nextPaymentOption)
    setConektaSavedCardGatewayConfirmed(false)
    setSinglePaymentOptionsStage(hasMultiplePaymentPlanGateways ? 'gateway' : 'confirm')
  }

  const goToPaymentPlanSavedCardOptions = () => {
    const nextPaymentOption = defaultPaymentPlanSavedCardOption
    if (!nextPaymentOption) return

    setSinglePaymentAction('saved_card')
    setStripePlanCardSource('saved_card')
    setPaymentOption(nextPaymentOption)
    setConektaSavedCardGatewayConfirmed(false)
    setSinglePaymentOptionsStage('saved_cards')
  }

  const renderSavedCardGatewayRow = ({
    platform,
    label,
    description,
    value,
    options,
    active,
    onSelect
  }: {
    platform: 'stripe' | 'conekta' | 'rebill'
    label: string
    description: string
    value: string
    options: Array<{ value: string; label: string }>
    active: boolean
    onSelect: (value: string) => void
  }) => {
    const selectedValue = value || options[0]?.value || ''
    const selectCurrentCard = () => {
      if (selectedValue) {
        onSelect(selectedValue)
      }
    }

    return (
      <div
        className={styles.savedCardGatewayRow}
        data-active={active ? 'true' : undefined}
      >
        <button
          type="button"
          className={styles.savedCardGatewayMain}
          onClick={selectCurrentCard}
        >
          <div className={styles.optionInfo}>
            <div className={styles.optionIcon}>
              <PaymentPlatformLogo platform={platform} size="md" decorative />
            </div>
            <div>
              <p>{label}</p>
              <span>{description}</span>
            </div>
          </div>
        </button>
        <div className={styles.savedCardSelector} onClick={(event) => event.stopPropagation()}>
          <CustomSelect
            value={selectedValue}
            onValueChange={onSelect}
            options={options}
            placeholder={`Tarjeta de ${label}`}
            aria-label={`Tarjeta guardada de ${label}`}
            portal
          />
        </div>
        {active && <Check size={18} className={styles.optionCheck} />}
      </div>
    )
  }

  useEffect(() => {
    if (sendMethodOptions.length === 0) return
    if (!selectedSendMethodOption) {
      setSendMethod(getDefaultSendMethod(sendMethodOptions))
    }
  }, [sendMethodOptions, selectedSendMethodOption])

  useEffect(() => {
    if (!isEmbedded || typeof document === 'undefined') return

    if (contactPickerOpen) {
      document.body.dataset.paymentContactPicker = 'open'
    } else {
      delete document.body.dataset.paymentContactPicker
    }

    return () => {
      delete document.body.dataset.paymentContactPicker
    }
  }, [contactPickerOpen, isEmbedded])

  const resetForm = () => {
    const resolvedInitialContact = normalizePaymentContact(initialContact)

    setStep('form')
    setLoading(false)
    setSearchQuery('')
    setSearchingContact(false)
    setContacts([])
    setSelectedContact(resolvedInitialContact)
    setContactPickerOpen(false)
    setChargeType('direct')
    setAmount('')
    setPaymentTitle('')
    setDescription('')
    setCurrency(accountCurrency)
    setIncludeIVA(Boolean(paymentTaxes.enabled))
    setTaxCalculationMode(paymentTaxes.calculationMode || defaultPaymentSettings.taxes.calculationMode)
    setPaymentMode(initialPaymentMode)
    // El plan abre por defecto con "Cobrar inmediato" (primer pago con tarjeta),
    // misma interacción en escritorio y celular.
    setFirstPaymentEnabled(true)
    setFirstPaymentType('amount')
    setFirstPaymentValue('')
    setFirstPaymentAuto(true)
    setFirstPaymentDate(getBusinessTodayInputValue(timezone))
    setFirstPaymentMethod('card')
    setRemainingAutomatic(true)
    setRemainingValueType('amount')
    setRemainingFrequency('monthly')
    setRemainingInstallments(defaultPartialInstallments(timezone))
    setAutoDistributeRemaining(true)
    setSelectedProduct(null)
    setSelectedPrice(null)
    setPrices([])
    setProducts([])
    setCustomAmount('')
    setShowCreateProduct(false)
    setCreatingProduct(false)
    setNewProductName('')
    setNewProductDescription('')
    setNewProductPriceName('')
    setNewProductAmount('')
    setNewProductGigstackProductKey('')
    setNewProductGigstackUnitKey('')
    setInvoicePayload(null)
    setInvoiceSummary(null)
    setSinglePaymentAction(getDefaultSinglePaymentAction())
    setSinglePaymentOptionsStage('method')
    setPaymentOption(getDefaultPaymentOption())
    setSendMethod(resolvedInitialContact ? getDefaultSendMethod(getSendMethodOptions(resolvedInitialContact)) : DEFAULT_SEND_METHOD)
    setInstallmentChargeMode('single')
    setStripeInstallmentChoice('24')
    setMercadoPagoInstallmentChoice('none')
    setConektaInstallmentChoice('none')
    setManualPaymentData(defaultManualPaymentData(timezone))
    setSavedPaymentMethods([])
    setSelectedSavedPaymentMethodId('')
    setSavedConektaPaymentSources([])
    setSelectedConektaPaymentSourceId('')
    setSavedRebillPaymentSources([])
    setSelectedRebillPaymentSourceId('')
    setStripePlanCardSource('new_card')
    setCreatedPaymentLink(null)
  }

  const loadConfig = async () => {
    try {
      const response = await fetch(apiUrl('/api/highlevel/config'))
      if (!response.ok) return

      const config = await response.json()
      const locationData = typeof config.locationData === 'string'
        ? JSON.parse(config.locationData)
        : config.locationData
      const business = locationData?.business || {}

      setBusinessName(config.businessName || business.name || locationData?.name || 'Mi Negocio')
      setBusinessEmail(config.businessEmail || business.email || locationData?.email || '')
      setLogoUrl(config.companyLogoUrl || business.logoUrl || locationData?.logoUrl || '')
      setBusinessPhone(business.phone || locationData?.phone || '')
      setBusinessAddress(business.address || locationData?.address || '')
      setBusinessCity(business.city || locationData?.city || '')
      setBusinessState(business.state || locationData?.state || '')
      setBusinessCountry(business.country || locationData?.country || '')
      setBusinessPostalCode(business.postalCode || locationData?.postalCode || '')
      setBusinessWebsite(config.companyWebsite || business.website || locationData?.website || config.domain || '')
      setInvoiceTermsNotes(config.invoiceTermsNotes || null)
      setInvoiceDueDays(config.invoiceDueDays || 7)
      setCardSetupAmount(config.cardSetupAmount || 25)
      setGhlInvoiceMode(config.ghlInvoiceMode === 'test' ? 'test' : 'live')
      setTransferInfoUrl(config.transferInfoUrl || null)
    } catch (error) {
    }
  }

  const loadPaymentTaxSettings = async () => {
    try {
      const paymentSettings = await paymentSettingsService.getSettings()
      const nextTaxes = paymentSettings.taxes || defaultPaymentSettings.taxes
      setPaymentTaxes(nextTaxes)
      setTaxCalculationMode(nextTaxes.calculationMode || defaultPaymentSettings.taxes.calculationMode)
      setIncludeIVA(Boolean(nextTaxes.enabled))
    } catch {
      setPaymentTaxes(defaultPaymentSettings.taxes)
      setTaxCalculationMode(defaultPaymentSettings.taxes.calculationMode)
      setIncludeIVA(false)
    }
  }

  const loadIntegrationStatus = async () => {
    if (!canUsePaymentGateways) {
      setHighLevelConnected(false)
      setStripeConnected(false)
      setConektaConnected(false)
      setMercadoPagoConnected(false)
      setClipConnected(false)
      setRebillConnected(false)
      return
    }

    try {
      const data = await getIntegrationsStatus()
      setHighLevelConnected(Boolean(data?.highlevel?.connected))
      setStripeConnected(Boolean(data?.stripe?.connected))
      setConektaConnected(Boolean(data?.conekta?.connected))
      setMercadoPagoConnected(Boolean(data?.mercadopago?.connected))
      setClipConnected(Boolean(data?.clip?.connected))
      setRebillConnected(Boolean(data?.rebill?.connected))
    } catch (error) {
      setHighLevelConnected(false)
      setStripeConnected(false)
      setConektaConnected(false)
      setMercadoPagoConnected(false)
      setClipConnected(false)
      setRebillConnected(false)
    }
  }

  // En modo local completo (sin pasarela) forzamos pago único manual.
  // Stripe, Conekta, Rebill y la integración opcional de HighLevel pueden manejar planes desde Ristak.
  // Mercado Pago maneja links y suscripciones, no parcialidades.
  useEffect(() => {
    if (!highLevelConnected && !stripeConnected && !conektaConnected && !mercadoPagoConnected && !clipConnected && !rebillConnected) {
      setPaymentMode('single')
      setSinglePaymentAction('manual')
      setSinglePaymentOptionsStage('method')
      setPaymentOption('manual')
    }
  }, [clipConnected, conektaConnected, highLevelConnected, mercadoPagoConnected, rebillConnected, stripeConnected])

  useEffect(() => {
    // El método del primer pago vive en la fila #1 y su default visible es
    // "Tarjeta / link"; comprometemos ese valor para que pantalla, payload y la
    // validación de envío coincidan en escritorio y celular.
    if (isOpen && activePaymentMode === 'partial' && firstPaymentEnabled && !firstPaymentMethod) {
      setFirstPaymentMethod('card')
    }
  }, [isOpen, activePaymentMode, firstPaymentEnabled, firstPaymentMethod])

  useEffect(() => {
    if (!paymentTaxes.enabled && includeIVA) {
      setIncludeIVA(false)
    }
  }, [includeIVA, paymentTaxes.enabled])

  useEffect(() => {
    const controller = new AbortController()

    if (!isOpen || !stripeConnected || !selectedContact?.id) {
      setSavedPaymentMethods([])
      setSelectedSavedPaymentMethodId('')
      if (paymentOption === 'stripe_saved_card') {
        setSinglePaymentAction(getDefaultSinglePaymentAction())
        setPaymentOption(getDefaultPaymentOption())
      }
      return () => {
        controller.abort()
      }
    }

    stripePaymentsService.getSavedPaymentMethods(selectedContact.id, controller.signal)
      .then((methods) => {
        if (controller.signal.aborted) return
        setSavedPaymentMethods(methods)
        setSelectedSavedPaymentMethodId((current) => {
          const stillExists = methods.some((method) => (
            getSavedStripePaymentMethodId(method) === current
          ))
          if (stillExists) return current
          const preferred = methods.find((method) => method.isDefault) || methods[0]
          return getSavedStripePaymentMethodId(preferred)
        })
        if (!methods.length && paymentOption === 'stripe_saved_card') {
          setSinglePaymentAction(getDefaultSinglePaymentAction())
          setPaymentOption(getDefaultPaymentOption())
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setSavedPaymentMethods([])
        setSelectedSavedPaymentMethodId('')
        if (paymentOption === 'stripe_saved_card') {
          setSinglePaymentAction(getDefaultSinglePaymentAction())
          setPaymentOption(getDefaultPaymentOption())
        }
      })

    return () => {
      controller.abort()
    }
  }, [isOpen, stripeConnected, selectedContact?.id, paymentOption])

  useEffect(() => {
    let cancelled = false

    if (!isOpen || !conektaConnected || !selectedContact?.id) {
      setSavedConektaPaymentSources([])
      setSelectedConektaPaymentSourceId('')
      if (paymentOption === 'conekta_saved_card') {
        setSinglePaymentAction(getDefaultSinglePaymentAction())
        setPaymentOption(getDefaultPaymentOption())
      }
      return () => {
        cancelled = true
      }
    }

    conektaPaymentsService.getSavedPaymentSources(selectedContact.id)
      .then((sources) => {
        if (cancelled) return
        setSavedConektaPaymentSources(sources)
        setSelectedConektaPaymentSourceId((current) => {
          const stillExists = sources.some((source) => (
            getSavedConektaPaymentSourceId(source) === current
          ))
          if (stillExists) return current
          const preferred = sources.find((source) => source.isDefault) || sources[0]
          return getSavedConektaPaymentSourceId(preferred)
        })
        if (!sources.length && paymentOption === 'conekta_saved_card') {
          setSinglePaymentAction(getDefaultSinglePaymentAction())
          setPaymentOption(getDefaultPaymentOption())
        }
      })
      .catch(() => {
        if (cancelled) return
        setSavedConektaPaymentSources([])
        setSelectedConektaPaymentSourceId('')
        if (paymentOption === 'conekta_saved_card') {
          setSinglePaymentAction(getDefaultSinglePaymentAction())
          setPaymentOption(getDefaultPaymentOption())
        }
      })

    return () => {
      cancelled = true
    }
  }, [isOpen, conektaConnected, selectedContact?.id, paymentOption])

  useEffect(() => {
    let cancelled = false

    if (!isOpen || !rebillConnected || !selectedContact?.id) {
      setSavedRebillPaymentSources([])
      setSelectedRebillPaymentSourceId('')
      if (paymentOption === 'rebill_saved_card') {
        setSinglePaymentAction(getDefaultSinglePaymentAction())
        setPaymentOption(getDefaultPaymentOption())
      }
      return () => {
        cancelled = true
      }
    }

    rebillPaymentsService.getSavedPaymentSources(selectedContact.id)
      .then((sources) => {
        if (cancelled) return
        setSavedRebillPaymentSources(sources)
        setSelectedRebillPaymentSourceId((current) => {
          const stillExists = sources.some((source) => (
            getSavedRebillPaymentSourceId(source) === current
          ))
          if (stillExists) return current
          const preferred = sources.find((source) => source.isDefault) || sources[0]
          return getSavedRebillPaymentSourceId(preferred)
        })
        if (!sources.length && paymentOption === 'rebill_saved_card') {
          setSinglePaymentAction(getDefaultSinglePaymentAction())
          setPaymentOption(getDefaultPaymentOption())
        }
      })
      .catch(() => {
        if (cancelled) return
        setSavedRebillPaymentSources([])
        setSelectedRebillPaymentSourceId('')
        if (paymentOption === 'rebill_saved_card') {
          setSinglePaymentAction(getDefaultSinglePaymentAction())
          setPaymentOption(getDefaultPaymentOption())
        }
      })

    return () => {
      cancelled = true
    }
  }, [isOpen, rebillConnected, selectedContact?.id, paymentOption])

  useEffect(() => {
    manualPaymentRequestRef.current = null
  }, [isOpen, initialContact?.id, manualPaymentIdempotencyScope])

  useEffect(() => {
    if (!isOpen) {
      paymentPlanRequestKeyRef.current = ''
      resetForm()
      return
    }

    resetForm()
    loadConfig()
    loadPaymentTaxSettings()
    loadIntegrationStatus()
  }, [isOpen, initialPaymentMode, initialContact?.id, initialContact?.email, initialContact?.phone, initialContact?.name, accountCurrency, canUsePaymentGateways])

  // Search contacts
  useEffect(() => {
    if (contactLocked) {
      setContacts([])
      setContactPickerOpen(false)
      setSearchingContact(false)
      return
    }

    if (isEmbedded && !contactPickerOpen) {
      setContacts([])
      setSearchingContact(false)
      return
    }

    const query = searchQuery.trim()
    const shouldLoadRecentContacts = isEmbedded && contactPickerOpen && query.length < 2

    if (query.length < 2 && !shouldLoadRecentContacts) {
      setContacts([])
      setSearchingContact(false)
      return
    }

    const controller = new AbortController()
    setSearchingContact(true)

    const timer = window.setTimeout(async () => {
      setSearchingContact(true)
      try {
        let formattedContacts: Contact[]

        if (shouldLoadRecentContacts) {
          const params = new URLSearchParams({
            page: '1',
            limit: '60',
            sortBy: 'created_at',
            sortOrder: 'DESC'
          })
          const response = await fetch(apiUrl(`/api/contacts?${params.toString()}`), {
            signal: controller.signal
          })
          if (!response.ok) {
            throw new Error('Error al cargar contactos')
          }
          const data = await response.json()
          const recentContacts = Array.isArray(data)
            ? data
            : Array.isArray(data.data)
              ? data.data
              : Array.isArray(data.contacts)
                ? data.contacts
                : []

          formattedContacts = recentContacts.map((contact: any) => ({
            id: contact.id,
            name: contact.full_name || contact.name || 'Sin nombre',
            email: contact.email || '',
            phone: contact.phone || '',
            firstName: contact.firstName || contact.first_name || '',
            lastName: contact.lastName || contact.last_name || ''
          }))
        } else if (highLevelConnected) {
          const response = await fetch(apiUrl('/api/highlevel/contacts/search'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            signal: controller.signal,
            body: JSON.stringify({
              query,
              limit: 10
            })
          })
          if (!response.ok) {
            throw new Error('Error al buscar contactos')
          }
          const data = await response.json()

          formattedContacts = (data.contacts || []).map((contact: any) => ({
            id: contact.id,
            name: contact.name || 'Sin nombre',
            email: contact.email || '',
            phone: contact.phone || '',
            firstName: contact.firstName || '',
            lastName: contact.lastName || ''
          }))
        } else {
          // Modo local: buscar en los contactos almacenados en Ristak.
          const params = new URLSearchParams({ q: query })
          const response = await fetch(apiUrl(`/api/contacts/search?${params.toString()}`), {
            signal: controller.signal
          })
          if (!response.ok) {
            throw new Error('Error al buscar contactos')
          }
          const data = await response.json()

          formattedContacts = (data.data || []).map((contact: any) => ({
            id: contact.id,
            name: contact.full_name || contact.name || 'Sin nombre',
            email: contact.email || '',
            phone: contact.phone || '',
            firstName: contact.firstName || '',
            lastName: contact.lastName || ''
          }))
        }

        if (!controller.signal.aborted) {
          setContacts(formattedContacts)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setContacts([])
        }
      } finally {
        if (!controller.signal.aborted) {
          setSearchingContact(false)
        }
      }
    }, shouldLoadRecentContacts ? 0 : CONTACT_SEARCH_DELAY_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [searchQuery, highLevelConnected, contactLocked, contactPickerOpen, isEmbedded])

  useEffect(() => {
    if (isOpen && chargeType === 'product' && products.length === 0) {
      loadProducts()
    }
  }, [isOpen, chargeType])

  useEffect(() => {
    if (!isEmbedded) return
    embeddedScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }, [isEmbedded, step])

  useEffect(() => {
    if (selectedProduct) {
      const productId = selectedProduct.id || selectedProduct._id || selectedProduct.localId || ''
      if (productId) loadPrices(productId)
    }
  }, [selectedProduct])

  useEffect(() => {
    if (selectedPrice) {
      const priceAmount = selectedPrice.amount || selectedPrice.price
      setCustomAmount(priceAmount ? String(priceAmount) : '')
      setCurrency(accountCurrency)
    }
  }, [selectedPrice, accountCurrency])

  useEffect(() => {
    if (activePaymentMode !== 'partial' || remainingFrequency === 'custom') return

    setRemainingInstallments(prev => prev.map((installment, index) => ({
      ...installment,
      dueDate: getNextDueDate(
        firstPaymentDate,
        remainingFrequency,
        getRemainingDueDateOffset(index),
        timezone
      )
    })))
  }, [activePaymentMode, firstPaymentDate, remainingFrequency, remainingInstallments.length, timezone])

  useEffect(() => {
    if (activePaymentMode !== 'partial' || !firstPaymentEnabled) return

    const reflowed = reflowRemainingDatesAfterFirstPayment(
      remainingInstallments,
      firstPaymentDate,
      remainingFrequency,
      timezone
    )
    if (reflowed !== remainingInstallments) {
      setRemainingInstallments(reflowed)
    }
  }, [
    activePaymentMode,
    firstPaymentDate,
    firstPaymentEnabled,
    remainingFrequency,
    remainingInstallments,
    timezone
  ])

  useEffect(() => {
    if (activePaymentMode !== 'partial' || !autoDistributeRemaining) return

    // Primer pago automático: el #1 cuenta como una parcialidad más, así el total
    // se reparte en partes iguales (primer pago incluido) y el plan cuadra desde el
    // inicio sin obligar a teclear el enganche.
    const firstPaymentParticipates = firstPaymentEnabled && firstPaymentAuto
    if (firstPaymentParticipates) {
      const values = getRemainingDistributedValues(
        remainingInstallments.length + 1,
        effectiveRemainingValueType,
        false,
        'amount',
        '',
        totalAmount
      )
      const firstValue = values[0] || '0'
      setFirstPaymentValue(prev => (prev === firstValue ? prev : firstValue))
      setRemainingInstallments(prev => prev.map((installment, index) => ({
        ...installment,
        type: effectiveRemainingValueType,
        value: values[index + 1] || '0'
      })))
      return
    }

    setRemainingInstallments(prev => {
      const distributedValues = getRemainingDistributedValues(
        prev.length,
        effectiveRemainingValueType,
        firstPaymentEnabled,
        firstPaymentType,
        firstPaymentValue,
        totalAmount
      )

      return prev.map((installment, index) => ({
        ...installment,
        type: effectiveRemainingValueType,
        value: distributedValues[index] || '0'
      }))
    })
  }, [
    autoDistributeRemaining,
    isEmbedded,
    firstPaymentEnabled,
    firstPaymentAuto,
    firstPaymentType,
    firstPaymentValue,
    effectiveRemainingValueType,
    activePaymentMode,
    remainingInstallments.length,
    totalAmount
  ])

  const loadProducts = async () => {
    setLoadingProducts(true)
    try {
      const response = await fetch(apiUrl('/api/products?limit=100'))
      if (!response.ok) throw new Error('Error al obtener productos')
      const data = await response.json()
      setProducts(data.products || [])
    } catch (error) {
      showToast('error', 'No se pudieron cargar los productos')
    } finally {
      setLoadingProducts(false)
    }
  }

  const loadPrices = async (productId: string) => {
    try {
      const response = await fetch(apiUrl(`/api/products/${productId}/prices`))
      if (!response.ok) throw new Error('Error al obtener precios')
      const data = await response.json()
      setPrices(data.prices || [])
    } catch (error) {
      showToast('error', 'No se pudieron cargar los precios')
    }
  }

  const resetNewProductForm = () => {
    setNewProductName('')
    setNewProductDescription('')
    setNewProductPriceName('')
    setNewProductAmount('')
    setNewProductGigstackProductKey('')
    setNewProductGigstackUnitKey('')
  }

  const handleCreateProduct = async () => {
    const productName = newProductName.trim()
    const productAmount = normalizeAmount(newProductAmount)

    if (!productName) {
      showToast('error', 'Escribe el nombre del producto')
      return
    }

    if (productAmount <= 0) {
      showToast('error', 'Ingresa un precio válido')
      return
    }

    setCreatingProduct(true)
    try {
      const response = await fetch(apiUrl('/api/products'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: productName,
          description: newProductDescription.trim(),
          productType: 'DIGITAL',
          availableInStore: false,
          currency: accountCurrency,
          gigstackProductKey: newProductGigstackProductKey,
          gigstackUnitKey: newProductGigstackUnitKey,
          gigstackUnitName: getGigstackUnitName(newProductGigstackUnitKey) || newProductGigstackUnitKey,
          prices: [
            {
              name: newProductPriceName.trim() || productName,
              amount: productAmount,
              currency: accountCurrency,
              type: 'one_time',
              description: newProductDescription.trim()
            }
          ]
        })
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'No se pudo crear el producto')

      const product = data.product as Product
      const productPrices = product?.prices || []
      const firstPrice = productPrices[0] || null

      setProducts(prev => {
        const productKey = product.id || product._id || product.localId
        const filtered = prev.filter(item => (item.id || item._id || item.localId) !== productKey)
        return [product, ...filtered]
      })
      setSelectedProduct(product)
      setPrices(productPrices)
      setSelectedPrice(firstPrice)
      if (firstPrice) {
        setCustomAmount(String(firstPrice.amount || firstPrice.price || productAmount))
        setCurrency(accountCurrency)
      }
      setShowCreateProduct(false)
      resetNewProductForm()
      showToast('success', data.message || 'Producto creado')
    } catch (error: any) {
      showToast('error', error.message || 'No se pudo crear el producto')
    } finally {
      setCreatingProduct(false)
    }
  }

  const handleCopyTransferUrl = async () => {
    if (!transferInfoUrl) return

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(transferInfoUrl)
      } else {
        const input = document.createElement('input')
        input.value = transferInfoUrl
        document.body.appendChild(input)
        input.select()
        document.execCommand('copy')
        document.body.removeChild(input)
      }
      showToast('success', 'Enlace copiado al portapapeles')
    } catch (error) {
      showToast('error', 'No se pudo copiar el enlace')
    }
  }

  const copyTextToClipboard = async (text: string) => {
    if (!text) return false

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const input = document.createElement('input')
        input.value = text
        document.body.appendChild(input)
        input.select()
        document.execCommand('copy')
        document.body.removeChild(input)
      }
      return true
    } catch {
      return false
    }
  }

  const showPaymentLinkReady = (link: CreatedPaymentLink) => {
    setCreatedPaymentLink(link)
    setStep('link_ready')
  }

  const handleSelectContact = (contact: ContactSearchInputContact) => {
    // Solo guardar los datos primitivos del contacto para evitar referencias circulares
    const nextContact = {
      id: contact.id,
      name: contact.name || '',
      email: contact.email || '',
      phone: contact.phone || '',
      firstName: contact.firstName || '',
      lastName: contact.lastName || ''
    }

    setSelectedContact(nextContact)
    setSendMethod(getDefaultSendMethod(getSendMethodOptions(nextContact)))
    setSearchQuery('')
    setContactPickerOpen(false)
    setContacts([])
  }

  const handleClearContact = () => {
    if (contactLocked) return
    setSelectedContact(null)
    setSearchQuery('')
    setContacts([])
    setContactPickerOpen(false)
  }

  const openContactPicker = () => {
    if (contactLocked) return
    setSearchQuery('')
    setContacts([])
    setContactPickerOpen(true)
  }

  const closeContactPicker = () => {
    setContactPickerOpen(false)
    setSearchQuery('')
    setContacts([])
    setSearchingContact(false)
  }

  const returnToPaymentForm = () => {
    setStep('form')
    setInvoicePayload(null)
    setInvoiceSummary(null)
    setSinglePaymentAction(getDefaultSinglePaymentAction())
    setSinglePaymentOptionsStage('method')
    setPaymentOption(getDefaultPaymentOption())
    resetInstallmentChargeMode()
    setConektaSavedCardGatewayConfirmed(false)
    setCreatedPaymentLink(null)
  }

  const returnToPreviousPaymentOptionsStage = () => {
    if (activePaymentMode === 'partial') {
      if (singlePaymentOptionsStage !== 'method') {
        setSinglePaymentOptionsStage('method')
        return
      }

      returnToPaymentForm()
      return
    }

    if (isSinglePaymentInstallmentContext && installmentChargeMode === 'installments') {
      resetInstallmentChargeMode()
      return
    }

    if (
      singlePaymentAction === 'saved_card' &&
      singlePaymentOptionsStage === 'saved_cards' &&
      paymentOption === 'conekta_saved_card' &&
      conektaSavedCardGatewayConfirmed
    ) {
      setConektaSavedCardGatewayConfirmed(false)
      resetInstallmentChargeMode()
      return
    }

    if (singlePaymentOptionsStage === 'gateway_config') {
      setSinglePaymentOptionsStage(hasMultiplePaymentLinkGateways ? 'gateway' : 'method')
      resetInstallmentChargeMode()
      return
    }

    if (singlePaymentOptionsStage !== 'method') {
      setSinglePaymentOptionsStage('method')
      resetInstallmentChargeMode()
      return
    }

    returnToPaymentForm()
  }

  const handleEmbeddedBack = () => {
    if (contactPickerOpen) {
      closeContactPicker()
      return
    }

    if (step === 'options') {
      returnToPreviousPaymentOptionsStage()
      return
    }

    onClose()
  }

  const updateRemainingInstallment = (id: string, updates: Partial<InstallmentDraft>) => {
    if ('type' in updates || 'value' in updates) {
      setAutoDistributeRemaining(false)
    }

    setRemainingInstallments(prev => prev.map(installment => (
      installment.id === id
        ? { ...installment, ...updates }
        : installment
    )))
  }


  const addRemainingInstallment = () => {
    setAutoDistributeRemaining(true)
    setRemainingInstallments(prev => {
      const nextIndex = prev.length
      return [
        ...prev,
        {
          id: createInstallmentId(),
          type: effectiveRemainingValueType,
          value: '0',
          dueDate: getNextDueDate(
            firstPaymentDate,
            remainingFrequency === 'custom' ? 'monthly' : remainingFrequency,
            getRemainingDueDateOffset(nextIndex),
            timezone
          )
        }
      ]
    })
  }

  const removeRemainingInstallment = (id: string) => {
    setAutoDistributeRemaining(true)
    setRemainingInstallments(prev => (
      prev.length <= 1 ? prev : prev.filter(installment => installment.id !== id)
    ))
  }

  // Plan unificado (escritorio): la fila #1 elige cuándo se cobra el primer pago.
  // 'scheduled' lo deja como cobro programado; 'immediate' enciende el enganche y
  // deja un método por defecto para que se pueda elegir cómo cobrarlo de inmediato.
  const handleFirstPaymentTimingChange = (value: string) => {
    if (value === 'immediate') {
      setFirstPaymentEnabled(true)
      setFirstPaymentMethod(prev => prev || 'card')
      setFirstPaymentAuto(true)
    } else {
      setFirstPaymentEnabled(false)
    }
    setAutoDistributeRemaining(true)
  }

  const buildPartialFlowPayload = (payload: Record<string, any>, summary: InvoiceSummary, channels: Record<string, boolean>) => ({
    contact: selectedContact,
    totalAmount: summary.amount,
    currency: summary.currency,
    description: summary.description,
    invoicePayload: payload,
    firstPayment: {
      enabled: firstPaymentActive,
      type: firstPaymentType,
      value: normalizeAmount(firstPaymentValue),
      amount: firstPaymentAmount,
      date: buildFirstPaymentChargeDateValue(firstPaymentDate, firstPaymentActive, timezone),
      frequency: remainingFrequency,
      method: firstPaymentActive ? firstPaymentMethod : 'none'
    },
    remainingAutomatic,
    remainingFrequency,
    remainingPayments: resolvedRemainingInstallments.map(installment => ({
      sequence: installment.sequence,
      type: installment.type,
      value: normalizeAmount(installment.value),
      amount: installment.amount,
      percentage: installment.percentage,
      dueDate: buildPlanChargeDateValue(installment.dueDate),
      frequency: remainingFrequency
    })),
    channels
  })

  const buildGatewayPaymentPlanPayload = (payload: Record<string, any>, summary: InvoiceSummary, provider: 'stripe' | 'conekta' | 'rebill') => ({
    contact: {
      id: selectedContact?.id || '',
      name: summary.contactName || selectedContact?.name || '',
      email: selectedContact?.email || summary.contactEmail || '',
      phone: selectedContact?.phone || ''
    },
    totalAmount: summary.amount,
    currency: summary.currency,
    description: summary.description,
    title: payload.title || payload.name || DEFAULT_INVOICE_TITLE,
    invoicePayload: payload,
    firstPayment: {
      enabled: firstPaymentActive,
      amount: firstPaymentAmount,
      date: buildFirstPaymentChargeDateValue(firstPaymentDate, firstPaymentActive, timezone),
      frequency: remainingFrequency,
      method: firstPaymentActive ? firstPaymentMethod || 'card' : 'none'
    },
    remainingFrequency,
    remainingPayments: resolvedRemainingInstallments.map(installment => ({
      sequence: installment.sequence,
      type: installment.type,
      value: normalizeAmount(installment.value),
      amount: installment.amount,
      percentage: installment.percentage,
      dueDate: buildPlanChargeDateValue(installment.dueDate),
      frequency: remainingFrequency
    })),
    paymentMethodId: provider === 'conekta'
      ? conektaPlanSavedPaymentSource?.conektaPaymentSourceId || ''
      : provider === 'rebill'
        ? rebillPlanSavedPaymentSource?.rebillCardId || ''
        : stripePlanSavedPaymentMethod?.stripePaymentMethodId || '',
    cardSetupAmount,
    source: provider === 'rebill'
      ? 'record_payment_modal_rebill_plan'
      : provider === 'conekta'
        ? 'record_payment_modal_conekta_plan'
        : 'record_payment_modal_stripe_plan'
  })

  const submitPartialFlow = async (
    payload: Record<string, any>,
    summary: InvoiceSummary,
    channels: Record<string, boolean>
  ) => {
    const response = await fetch(apiUrl('/api/transactions/payment-flows/installments'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPartialFlowPayload(payload, summary, channels))
    })

    const data = await response.json()
    if (!response.ok) {
      throw new Error(data.error || 'No se pudo crear el flujo de parcialidades')
    }

    if (selectedContact && data.cardSetupPaymentLink) {
      showPaymentLinkReady({
        kind: 'card_setup',
        title: 'Enlace de domiciliación listo',
        description: `Comparte este enlace para que el ${customerLowerLabel} domicilie su tarjeta. El plan se activa cuando pague y guarde la tarjeta.`,
        provider: 'stripe',
        paymentUrl: data.cardSetupPaymentLink,
        amount: cardSetupAmount,
        currency: summary.currency,
        contact: selectedContact,
        paymentId: data.cardSetupInvoiceId
      })
      showToast('success', 'Parcialidades creadas', 'El enlace de domiciliación está listo para copiar o enviar.')
      await onSuccess?.(PAYMENT_PLAN_LINK_READY_SUCCESS_CONTEXT)
      return
    }

    if (selectedContact && data.firstPaymentLink) {
      showPaymentLinkReady({
        kind: 'first_payment',
        title: 'Primer pago listo',
        description: `Comparte este enlace para que el ${customerLowerLabel} pague el primer cobro. Al pagarlo se guarda la tarjeta y se activan los siguientes cobros programados.`,
        provider: 'stripe',
        paymentUrl: data.firstPaymentLink,
        amount: firstPaymentAmount,
        currency: summary.currency,
        contact: selectedContact,
        paymentId: data.firstPaymentInvoiceId
      })
      showToast('success', 'Parcialidades creadas', 'El enlace del primer pago está listo para copiar o enviar.')
      await onSuccess?.(PAYMENT_PLAN_LINK_READY_SUCCESS_CONTEXT)
      return
    }

    const statusMessage = data.currentState === 'waiting_card_authorization'
      ? 'Parcialidades creadas. El sistema esperará la autorización de tarjeta antes de activar los pagos automáticos.'
      : 'Parcialidades creadas correctamente.'

    showToast('success', 'Éxito', statusMessage)

    await onSuccess?.(PAYMENT_PLAN_CHANGED_SUCCESS_CONTEXT)
    onClose()
  }

  const buildInvoicePayload = (taxBreakdown: ReturnType<typeof calculateConfiguredTax>, finalCurrency: string, contactName: string, invoiceTitle: string, items: any[], contactId: string, contactEmail: string, contactPhone: string) => {
    const businessDetails: Record<string, any> = {
      name: businessName || 'Mi Negocio'
    }

    if (businessEmail) businessDetails.email = businessEmail
    if (logoUrl) businessDetails.logoUrl = logoUrl
    if (businessPhone) businessDetails.phone = businessPhone
    if (businessWebsite) businessDetails.website = businessWebsite

    const addressFields: Record<string, string> = {}
    if (businessAddress) addressFields.line1 = businessAddress
    if (businessCity) addressFields.city = businessCity
    if (businessState) addressFields.state = businessState
    if (businessCountry) addressFields.country = businessCountry
    if (businessPostalCode) addressFields.postalCode = businessPostalCode

    if (Object.keys(addressFields).length > 0) {
      businessDetails.address = addressFields
    }

    const dueDate = toDateInputValue(addDays(new Date(`${getBusinessTodayInputValue(timezone)}T00:00:00`), invoiceDueDays || 7))

    return {
      name: invoiceTitle,
      title: invoiceTitle,
      currency: finalCurrency,
      businessDetails,
      contactDetails: {
        id: contactId,
        name: contactName,
        email: contactEmail || '',
        phoneNo: contactPhone || ''
      },
      items,
      issueDate: getBusinessTodayInputValue(timezone),
      dueDate,
      liveMode: ghlInvoiceMode === 'live',
      ...(taxBreakdown.includesTax && {
        tax: {
          name: getConfiguredTaxName(paymentTaxes),
          rate: getConfiguredTaxRate(paymentTaxes),
          amount: taxBreakdown.taxAmount,
          calculationMode: taxBreakdown.calculationMode,
          country: paymentTaxes.country,
          fiscalId: paymentTaxes.fiscalId
        }
      }),
      ...(invoiceTermsNotes && { termsNotes: invoiceTermsNotes })
    }
  }

  const handleContinue = async () => {
    if (!selectedContact) {
      showToast('error', 'Selecciona un contacto')
      return
    }

    if (chargeType === 'direct') {
      if (!amount || parseFloat(amount) <= 0) {
        showToast('error', 'Ingresa un monto válido')
        return
      }
    } else {
      if (!selectedProduct) {
        showToast('error', 'Selecciona un producto')
        return
      }
      if (!selectedPrice) {
        showToast('error', 'Selecciona un precio')
        return
      }
      if (!customAmount || parseFloat(customAmount) <= 0) {
        showToast('error', 'Ingresa un monto válido')
        return
      }
    }

    if (activePaymentMode === 'partial') {
      if (totalAmount <= 0) {
        showToast('error', 'Ingresa un total válido para el plan')
        return
      }

      // Un primer pago en $0 se envía como "sin enganche" (enabled:false), así que no
      // se bloquea el envío en ninguna plataforma.
      if (firstPaymentMethodMissing) {
        showToast('error', 'Selecciona un método de pago para el primer pago')
        return
      }

      if (firstPaymentEnabled && firstPaymentAmount >= totalAmount) {
        showToast('error', 'El primer pago debe ser menor al total cuando hay parcialidades restantes')
        return
      }

      if (resolvedRemainingInstallments.length === 0) {
        showToast('error', 'Agrega al menos un pago restante')
        return
      }

      if (resolvedRemainingInstallments.some(installment => installment.amount <= 0 || !installment.dueDate)) {
        showToast('error', 'Todos los pagos restantes necesitan monto y fecha')
        return
      }

      if (!partialPlanMatches) {
        showToast('error', `Las parcialidades no cuadran: faltan o sobran ${formatCurrency(Math.abs(partialPlanDifference), currency)}`)
        return
      }
    }

    try {
      setLoading(true)

      const contactName =
        selectedContact.name ||
        `${selectedContact.firstName || ''} ${selectedContact.lastName || ''}`.trim() ||
        selectedContact.email ||
        selectedContact.phone ||
        customerLabel

      let items: any[] = []
      let finalCurrency = accountCurrency
      let subtotal = 0
      const resolvedTitle = paymentTitle.trim() || DEFAULT_INVOICE_TITLE
      const resolvedDescription = description.trim()

      if (chargeType === 'product' && selectedProduct && selectedPrice) {
        const parsedAmount = normalizeAmount(customAmount)
        subtotal = parsedAmount
        finalCurrency = accountCurrency
        const productCatalogId = selectedProduct.ghlProductId || selectedProduct.id || selectedProduct._id || selectedProduct.localId
        const priceCatalogId = selectedPrice.ghlPriceId || selectedPrice.id || selectedPrice._id || selectedPrice.localId

        items = [
          {
            name: selectedProduct.name,
            description: resolvedDescription || selectedProduct.description || selectedPrice.name || selectedProduct.name || resolvedTitle,
            priceId: priceCatalogId,
            productId: productCatalogId,
            localProductId: selectedProduct.localId || '',
            gigstackProductKey: selectedProduct.gigstackProductKey || '',
            gigstackUnitKey: selectedProduct.gigstackUnitKey || '',
            gigstackUnitName: selectedProduct.gigstackUnitName || '',
            amount: parsedAmount,
            qty: 1,
            currency: finalCurrency
          }
        ]
      } else {
        const parsedAmount = normalizeAmount(amount)
        subtotal = parsedAmount
        items = [
          {
            name: resolvedTitle,
            description: resolvedDescription || resolvedTitle,
            amount: parsedAmount,
            qty: 1,
            currency: finalCurrency
          }
        ]
      }

      const taxBreakdown = calculateConfiguredTax(subtotal, paymentTaxes, includeIVA, taxCalculationMode)
      const totalAmount = taxBreakdown.totalAmount

      if (taxBreakdown.includesTax && taxBreakdown.calculationMode === 'inclusive') {
        items = items.map((item) => ({
          ...item,
          amount: taxBreakdown.subtotalAmount
        }))
      }

      const payload = buildInvoicePayload(
        taxBreakdown,
        finalCurrency,
        contactName,
        resolvedTitle,
        items,
        selectedContact.id,
        selectedContact.email || '',
        selectedContact.phone || ''
      )

      const summary: InvoiceSummary = {
        contactId: selectedContact.id,
        contactName,
        contactEmail: selectedContact.email || '',
        amount: totalAmount,
        subtotal: taxBreakdown.subtotalAmount,
        taxAmount: taxBreakdown.taxAmount,
        includesTax: taxBreakdown.includesTax,
        taxName: getConfiguredTaxName(paymentTaxes),
        taxRate: getConfiguredTaxRate(paymentTaxes),
        taxCalculationMode: taxBreakdown.calculationMode,
        taxBaseAmount: taxBreakdown.calculationMode === 'exclusive' ? taxBreakdown.subtotalAmount : taxBreakdown.totalAmount,
        currency: finalCurrency,
        description: resolvedDescription || (chargeType === 'product' && selectedProduct ? selectedProduct.name : resolvedTitle)
      }

      setInvoicePayload(payload)
      setInvoiceSummary(summary)

      if (activePaymentMode === 'partial') {
        setPaymentOption(defaultPaymentPlanGatewayOption || 'manual')
        setStripePlanCardSource('new_card')
        setSinglePaymentAction('payment_link')
        setSinglePaymentOptionsStage('method')
        setStep('options')
        return
      }

      setManualPaymentData(defaultManualPaymentData(timezone))
      setSinglePaymentAction(getDefaultSinglePaymentAction())
      setSinglePaymentOptionsStage('method')
      setPaymentOption(getDefaultPaymentOption())

      setStep('options')
    } catch (error: any) {
      showToast('error', error.message || 'No se pudo preparar el invoice')
    } finally {
      setLoading(false)
    }
  }

  const handleConfirm = async () => {
    if (!invoiceSummary || !invoicePayload) {
      showToast('error', 'No se pudo procesar el pago. Intenta nuevamente.')
      return
    }

    if (needsConektaInstallmentSelection) {
      showToast(
        'error',
        'Selecciona un plazo disponible',
        'El monto no alcanza para ese plazo de meses sin intereses en Conekta.'
      )
      return
    }

    if (needsStripeInstallmentAvailability) {
      showToast(
        'error',
        'Stripe no puede mostrar MSI',
        'Los meses sin intereses de Stripe requieren MXN y un monto mínimo de 300 MXN.'
      )
      return
    }

    if (needsClipInstallmentAvailability) {
      showToast(
        'error',
        'CLIP no puede mostrar MSI',
        'Los meses sin intereses de CLIP requieren MXN y un monto mínimo de 300 MXN.'
      )
      return
    }

    const effectiveSendMethod = sendMethod
    let processedInvoiceId: string | undefined

    setLoading(true)
    setStep('processing')

    if (paymentOption === 'stripe_saved_card') {
      if (!selectedContact) {
        showToast('error', 'Selecciona un contacto')
        setStep('options')
        setLoading(false)
        return
      }

      if (!selectedSavedPaymentMethod) {
        showToast('error', 'Selecciona una tarjeta guardada')
        setStep('options')
        setLoading(false)
        return
      }

      try {
        const result = await stripePaymentsService.createSavedCardPayment({
          contactId: selectedContact.id,
          paymentMethodId: selectedSavedPaymentMethod.stripePaymentMethodId,
          contactName: invoiceSummary.contactName || selectedContact.name,
          email: selectedContact.email || invoiceSummary.contactEmail || '',
          phone: selectedContact.phone || '',
          amount: invoiceSummary.taxBaseAmount,
          currency: invoiceSummary.currency,
          applyTax: invoiceSummary.includesTax,
          taxCalculationMode: invoiceSummary.taxCalculationMode,
          title: invoicePayload.title || invoicePayload.name || DEFAULT_INVOICE_TITLE,
          description: invoiceSummary.description,
          dueDate: invoicePayload.dueDate,
          source: 'record_payment_modal_saved_card',
          lineItems: Array.isArray(invoicePayload.items) ? invoicePayload.items : []
        })

        const paid = result.payment?.status === 'paid'
        showToast(
          'success',
          paid ? 'Cobro realizado' : 'Cobro enviado a Stripe',
          paid
            ? `${getSavedCardLabel(selectedSavedPaymentMethod)} quedó cobrada correctamente.`
            : 'Stripe está terminando de procesar este cobro.'
        )
        onSuccess?.()
        onClose()
      } catch (stripeError: any) {
        showToast('error', 'No se pudo cobrar la tarjeta', stripeError.message || 'Revisa la tarjeta guardada o envía un link de Stripe.')
        setStep('options')
      } finally {
        setLoading(false)
      }
      return
    }

    if (paymentOption === 'conekta_saved_card') {
      if (!selectedContact) {
        showToast('error', 'Selecciona un contacto')
        setStep('options')
        setLoading(false)
        return
      }

      if (!selectedConektaPaymentSource) {
        showToast('error', 'Selecciona una tarjeta guardada')
        setStep('options')
        setLoading(false)
        return
      }

      try {
        const result = await conektaPaymentsService.createSavedCardPayment({
          contactId: selectedContact.id,
          paymentSourceId: selectedConektaPaymentSource.conektaPaymentSourceId,
          contactName: invoiceSummary.contactName || selectedContact.name,
          email: selectedContact.email || invoiceSummary.contactEmail || '',
          phone: selectedContact.phone || '',
          amount: invoiceSummary.taxBaseAmount,
          currency: invoiceSummary.currency,
          applyTax: invoiceSummary.includesTax,
          taxCalculationMode: invoiceSummary.taxCalculationMode,
          title: invoicePayload.title || invoicePayload.name || DEFAULT_INVOICE_TITLE,
          description: invoiceSummary.description,
          dueDate: invoicePayload.dueDate,
          source: 'record_payment_modal_conekta_saved_card',
          lineItems: Array.isArray(invoicePayload.items) ? invoicePayload.items : [],
          installments: {
            enabled: conektaMsiEnabled,
            maxInstallments: conektaInstallmentLimit
          }
        })

        const paid = result.payment?.status === 'paid'
        showToast(
          'success',
          paid ? 'Cobro realizado' : 'Cobro enviado a Conekta',
          paid
            ? `${getSavedConektaCardLabel(selectedConektaPaymentSource)} quedó cobrada correctamente${conektaMsiEnabled ? ` a ${conektaInstallmentLimit} meses sin intereses` : ''}.`
            : 'Conekta está terminando de procesar este cobro.'
        )
        onSuccess?.()
        onClose()
      } catch (conektaError: any) {
        showToast('error', 'No se pudo cobrar la tarjeta', conektaError.message || 'Revisa la tarjeta guardada o envía un link de Conekta.')
        setStep('options')
      } finally {
        setLoading(false)
      }
      return
    }

    if (paymentOption === 'rebill_saved_card') {
      if (!selectedContact) {
        showToast('error', 'Selecciona un contacto')
        setStep('options')
        setLoading(false)
        return
      }

      if (!selectedRebillPaymentSource) {
        showToast('error', 'Selecciona una tarjeta guardada')
        setStep('options')
        setLoading(false)
        return
      }

      try {
        const result = await rebillPaymentsService.createSavedCardPayment({
          contactId: selectedContact.id,
          paymentSourceId: selectedRebillPaymentSource.rebillCardId,
          contactName: invoiceSummary.contactName || selectedContact.name,
          email: selectedContact.email || invoiceSummary.contactEmail || '',
          phone: selectedContact.phone || '',
          amount: invoiceSummary.taxBaseAmount,
          currency: invoiceSummary.currency,
          applyTax: invoiceSummary.includesTax,
          taxCalculationMode: invoiceSummary.taxCalculationMode,
          title: invoicePayload.title || invoicePayload.name || DEFAULT_INVOICE_TITLE,
          description: invoiceSummary.description,
          dueDate: invoicePayload.dueDate,
          source: 'record_payment_modal_rebill_saved_card',
          lineItems: Array.isArray(invoicePayload.items) ? invoicePayload.items : []
        })

        const paid = result.payment?.status === 'paid'
        showToast(
          'success',
          paid ? 'Cobro realizado' : 'Cobro enviado a Rebill',
          paid
            ? `${getSavedRebillCardLabel(selectedRebillPaymentSource)} quedó cobrada correctamente.`
            : 'Rebill está terminando de procesar este cobro.'
        )
        onSuccess?.()
        onClose()
      } catch (rebillError: any) {
        showToast('error', 'No se pudo cobrar la tarjeta', rebillError.message || 'Revisa la tarjeta guardada o envía un link de Rebill.')
        setStep('options')
      } finally {
        setLoading(false)
      }
      return
    }

    if (paymentOption === 'stripe' && activePaymentMode === 'partial') {
      if (!selectedContact) {
        showToast('error', 'Selecciona un contacto')
        setStep('options')
        setLoading(false)
        return
      }

      try {
        paymentPlanRequestKeyRef.current ||= createPaymentPlanRequestKey()
        const result = await stripePaymentsService.createPaymentPlan({
          ...buildGatewayPaymentPlanPayload(invoicePayload, invoiceSummary, 'stripe'),
          idempotencyKey: paymentPlanRequestKeyRef.current
        })

        if (result.cardSetupLink) {
          const setupAmount = result.cardSetupAmount || cardSetupAmount
          const manualFirstPaymentRegistered = firstPaymentEnabled && isOfflineFirstPaymentMethod(firstPaymentMethod)
          showPaymentLinkReady({
            kind: 'card_setup',
            title: 'Enlace de domiciliación listo',
            description: `${manualFirstPaymentRegistered ? 'El primer pago manual ya quedó registrado. ' : ''}Comparte este enlace para que el ${customerLowerLabel} domicilie su tarjeta. El plan se activa cuando pague y guarde la tarjeta.`,
            provider: 'stripe',
            paymentUrl: result.cardSetupLink,
            amount: setupAmount,
            currency: invoiceSummary.currency,
            contact: selectedContact,
            paymentId: result.cardSetupPaymentId
          })
          showToast(
            'success',
            'Plan de Stripe creado',
            `${manualFirstPaymentRegistered ? 'El primer pago quedó registrado. ' : ''}El enlace de domiciliación por ${formatCurrency(setupAmount, invoiceSummary.currency)} está listo para compartir.`
          )
          await onSuccess?.(PAYMENT_PLAN_LINK_READY_SUCCESS_CONTEXT)
          return
        } else if (result.firstPaymentLink) {
          showPaymentLinkReady({
            kind: 'first_payment',
            title: 'Primer pago listo',
            description: `Comparte este enlace para que el ${customerLowerLabel} pague el primer cobro. Al pagarlo se guarda la tarjeta y se activan los siguientes cobros programados.`,
            provider: 'stripe',
            paymentUrl: result.firstPaymentLink,
            amount: firstPaymentAmount,
            currency: invoiceSummary.currency,
            contact: selectedContact,
            paymentId: result.firstPaymentPaymentId
          })
          showToast(
            'success',
            'Plan de Stripe creado',
            'El enlace del primer pago está listo para compartir.'
          )
          await onSuccess?.(PAYMENT_PLAN_LINK_READY_SUCCESS_CONTEXT)
          return
        } else {
          showToast(
            'success',
            'Plan de Stripe creado',
            `${result.scheduledPayments.length} cobros quedaron programados con tarjeta guardada.`
          )
        }

        await onSuccess?.(PAYMENT_PLAN_CHANGED_SUCCESS_CONTEXT)
        onClose()
      } catch (stripePlanError: any) {
        showToast('error', 'No se pudo crear el plan con Stripe', stripePlanError.message || 'Revisa la tarjeta guardada o manda primer pago por link.')
        setStep('options')
      } finally {
        setLoading(false)
      }
      return
    }

    if (paymentOption === 'conekta' && activePaymentMode === 'partial') {
      if (!selectedContact) {
        showToast('error', 'Selecciona un contacto')
        setStep('options')
        setLoading(false)
        return
      }

      try {
        paymentPlanRequestKeyRef.current ||= createPaymentPlanRequestKey()
        const result = await conektaPaymentsService.createPaymentPlan({
          ...buildGatewayPaymentPlanPayload(invoicePayload, invoiceSummary, 'conekta'),
          idempotencyKey: paymentPlanRequestKeyRef.current
        })

        if (result.cardSetupLink) {
          const setupAmount = result.cardSetupAmount || cardSetupAmount
          const manualFirstPaymentRegistered = firstPaymentEnabled && isOfflineFirstPaymentMethod(firstPaymentMethod)
          showPaymentLinkReady({
            kind: 'card_setup',
            title: 'Enlace de domiciliación listo',
            description: `${manualFirstPaymentRegistered ? 'El primer pago manual ya quedó registrado. ' : ''}Comparte este enlace para que el ${customerLowerLabel} domicilie su tarjeta. El plan se activa cuando pague y guarde la tarjeta.`,
            paymentUrl: result.cardSetupLink,
            amount: setupAmount,
            currency: invoiceSummary.currency,
            contact: selectedContact,
            paymentId: result.cardSetupPaymentId
          })
          showToast(
            'success',
            'Plan de Conekta creado',
            `${manualFirstPaymentRegistered ? 'El primer pago quedó registrado. ' : ''}El enlace de domiciliación por ${formatCurrency(setupAmount, invoiceSummary.currency)} está listo para compartir.`
          )
          await onSuccess?.(PAYMENT_PLAN_LINK_READY_SUCCESS_CONTEXT)
          return
        } else if (result.firstPaymentLink) {
          showPaymentLinkReady({
            kind: 'first_payment',
            title: 'Primer pago listo',
            description: `Comparte este enlace para que el ${customerLowerLabel} pague el primer cobro. Al pagarlo se guarda la tarjeta y se activan los siguientes cobros programados.`,
            paymentUrl: result.firstPaymentLink,
            amount: firstPaymentAmount,
            currency: invoiceSummary.currency,
            contact: selectedContact,
            paymentId: result.firstPaymentPaymentId
          })
          showToast(
            'success',
            'Plan de Conekta creado',
            'El enlace del primer pago está listo para compartir.'
          )
          await onSuccess?.(PAYMENT_PLAN_LINK_READY_SUCCESS_CONTEXT)
          return
        } else {
          showToast(
            'success',
            'Plan de Conekta creado',
            `${result.scheduledPayments.length} cobros quedaron programados con tarjeta guardada.`
          )
        }

        await onSuccess?.(PAYMENT_PLAN_CHANGED_SUCCESS_CONTEXT)
        onClose()
      } catch (conektaPlanError: any) {
        showToast('error', 'No se pudo crear el plan con Conekta', conektaPlanError.message || 'Revisa la tarjeta guardada o manda primer pago por link.')
        setStep('options')
      } finally {
        setLoading(false)
      }
      return
    }

    if (paymentOption === 'rebill' && activePaymentMode === 'partial') {
      if (!selectedContact) {
        showToast('error', 'Selecciona un contacto')
        setStep('options')
        setLoading(false)
        return
      }

      try {
        paymentPlanRequestKeyRef.current ||= createPaymentPlanRequestKey()
        const result = await rebillPaymentsService.createPaymentPlan({
          ...buildGatewayPaymentPlanPayload(invoicePayload, invoiceSummary, 'rebill'),
          idempotencyKey: paymentPlanRequestKeyRef.current
        })

        if (result.cardSetupLink) {
          const setupAmount = result.cardSetupAmount || cardSetupAmount
          const manualFirstPaymentRegistered = firstPaymentEnabled && isOfflineFirstPaymentMethod(firstPaymentMethod)
          showPaymentLinkReady({
            kind: 'card_setup',
            title: 'Enlace de domiciliación Rebill listo',
            description: `${manualFirstPaymentRegistered ? 'El primer pago manual ya quedó registrado. ' : ''}Comparte este enlace para que el ${customerLowerLabel} domicilie su tarjeta. El plan se activa cuando pague y Rebill guarde la tarjeta.`,
            provider: 'rebill',
            paymentUrl: result.cardSetupLink,
            amount: setupAmount,
            currency: invoiceSummary.currency,
            contact: selectedContact,
            paymentId: result.cardSetupPaymentId
          })
          showToast(
            'success',
            'Plan de Rebill creado',
            `${manualFirstPaymentRegistered ? 'El primer pago quedó registrado. ' : ''}El enlace de domiciliación por ${formatCurrency(setupAmount, invoiceSummary.currency)} está listo para compartir.`
          )
          await onSuccess?.(PAYMENT_PLAN_LINK_READY_SUCCESS_CONTEXT)
          return
        }

        if (result.firstPaymentLink) {
          showPaymentLinkReady({
            kind: 'first_payment',
            title: 'Primer pago Rebill listo',
            description: `Comparte este enlace para que el ${customerLowerLabel} pague el primer cobro. Al pagarlo se guarda la tarjeta y Ristak cobra las siguientes parcialidades cuando toque.`,
            provider: 'rebill',
            paymentUrl: result.firstPaymentLink,
            amount: firstPaymentAmount,
            currency: invoiceSummary.currency,
            contact: selectedContact,
            paymentId: result.firstPaymentPaymentId
          })
          showToast(
            'success',
            'Plan de Rebill creado',
            'El enlace del primer pago está listo. Las demás parcialidades se cobrarán con la tarjeta guardada cuando toque.'
          )
          await onSuccess?.(PAYMENT_PLAN_LINK_READY_SUCCESS_CONTEXT)
          return
        }

        showToast(
          'success',
          'Plan de Rebill creado',
          `${result.scheduledPayments.length} parcialidades quedaron programadas con tarjeta guardada.`
        )
        await onSuccess?.(PAYMENT_PLAN_CHANGED_SUCCESS_CONTEXT)
        onClose()
      } catch (rebillPlanError: any) {
        showToast('error', 'No se pudo crear el plan con Rebill', rebillPlanError.message || 'Revisa la conexión de Rebill.')
        setStep('options')
      } finally {
        setLoading(false)
      }
      return
    }

    if (paymentOption === 'stripe') {
      if (!selectedContact) {
        showToast('error', 'Selecciona un contacto')
        setStep('options')
        setLoading(false)
        return
      }

      try {
        const result = await stripePaymentsService.createPaymentLink({
          contactId: selectedContact.id,
          contactName: invoiceSummary.contactName || selectedContact.name,
          email: selectedContact.email || invoiceSummary.contactEmail || '',
          phone: selectedContact.phone || '',
          amount: invoiceSummary.taxBaseAmount,
          currency: invoiceSummary.currency,
          applyTax: invoiceSummary.includesTax,
          taxCalculationMode: invoiceSummary.taxCalculationMode,
          title: invoicePayload.title || invoicePayload.name || DEFAULT_INVOICE_TITLE,
          description: invoiceSummary.description,
          dueDate: invoicePayload.dueDate,
          source: 'record_payment_modal',
          lineItems: Array.isArray(invoicePayload.items) ? invoicePayload.items : [],
          installments: {
            enabled: stripeMsiEnabled,
            maxInstallments: stripeMsiEnabled ? stripeInstallmentLimit : undefined
          }
        })

        showPaymentLinkReady({
          kind: 'single',
          title: 'Enlace de pago listo',
          description: stripeMsiEnabled
            ? `Comparte este enlace para que el ${customerLowerLabel} pague con Stripe. Ristak mostrará sólo los plazos disponibles hasta ${stripeInstallmentLimit} meses.`
            : `Comparte este enlace para que el ${customerLowerLabel} pague con tarjeta desde la página pública segura.`,
          provider: 'stripe',
          paymentUrl: result.paymentUrl,
          amount: invoiceSummary.amount,
          currency: invoiceSummary.currency,
          contact: selectedContact,
          paymentId: result.payment?.id,
          publicPaymentId: result.publicPaymentId
        })
        showToast(
          'success',
          'Link de Stripe creado',
          stripeMsiEnabled
            ? `El enlace público quedó listo con MSI hasta ${stripeInstallmentLimit} meses.`
            : 'El enlace público está listo para copiar o enviar.'
        )
        onSuccess?.(LINK_READY_SUCCESS_CONTEXT)
      } catch (stripeError: any) {
        showToast('error', 'No se pudo crear el link de Stripe', stripeError.message || 'Revisa la configuración de Stripe.')
        setStep('options')
      } finally {
        setLoading(false)
      }
      return
    }

    if (paymentOption === 'conekta') {
      if (!selectedContact) {
        showToast('error', 'Selecciona un contacto')
        setStep('options')
        setLoading(false)
        return
      }

      try {
        const result = await conektaPaymentsService.createPaymentLink({
          contactId: selectedContact.id,
          contactName: invoiceSummary.contactName || selectedContact.name,
          email: selectedContact.email || invoiceSummary.contactEmail || '',
          phone: selectedContact.phone || '',
          amount: invoiceSummary.taxBaseAmount,
          currency: invoiceSummary.currency,
          applyTax: invoiceSummary.includesTax,
          taxCalculationMode: invoiceSummary.taxCalculationMode,
          title: invoicePayload.title || invoicePayload.name || DEFAULT_INVOICE_TITLE,
          description: invoiceSummary.description,
          dueDate: invoicePayload.dueDate,
          source: 'record_payment_modal_conekta',
          lineItems: Array.isArray(invoicePayload.items) ? invoicePayload.items : [],
          installments: {
            enabled: conektaMsiEnabled,
            maxInstallments: conektaInstallmentLimit
          }
        })

        showPaymentLinkReady({
          kind: 'single',
          title: 'Enlace Conekta listo',
          description: conektaMsiEnabled
            ? `Comparte este enlace para que el ${customerLowerLabel} pague con Conekta. Podrá elegir hasta ${conektaInstallmentLimit} meses sin intereses si su tarjeta aplica.`
            : `Comparte este enlace para que el ${customerLowerLabel} pague con tarjeta en el tokenizador seguro de Conekta.`,
          provider: 'conekta',
          paymentUrl: result.paymentUrl,
          amount: invoiceSummary.amount,
          currency: invoiceSummary.currency,
          contact: selectedContact,
          paymentId: result.payment?.id,
          publicPaymentId: result.publicPaymentId
        })
        showToast(
          'success',
          'Link de Conekta creado',
          'El enlace público está listo para copiar o enviar.'
        )
        onSuccess?.(LINK_READY_SUCCESS_CONTEXT)
      } catch (conektaError: any) {
        showToast('error', 'No se pudo crear el link de Conekta', conektaError.message || 'Revisa la configuración de Conekta.')
        setStep('options')
      } finally {
        setLoading(false)
      }
      return
    }

    if (paymentOption === 'mercadopago') {
      if (!selectedContact) {
        showToast('error', 'Selecciona un contacto')
        setStep('options')
        setLoading(false)
        return
      }

      try {
        const result = await mercadoPagoPaymentsService.createPaymentLink({
          contactId: selectedContact.id,
          contactName: invoiceSummary.contactName || selectedContact.name,
          email: selectedContact.email || invoiceSummary.contactEmail || '',
          phone: selectedContact.phone || '',
          amount: invoiceSummary.taxBaseAmount,
          currency: invoiceSummary.currency,
          applyTax: invoiceSummary.includesTax,
          taxCalculationMode: invoiceSummary.taxCalculationMode,
          title: invoicePayload.title || invoicePayload.name || DEFAULT_INVOICE_TITLE,
          description: invoiceSummary.description,
          dueDate: invoicePayload.dueDate,
          source: 'record_payment_modal_mercadopago',
          lineItems: Array.isArray(invoicePayload.items) ? invoicePayload.items : [],
          installments: {
            enabled: mercadoPagoMsiEnabled,
            maxInstallments: mercadoPagoInstallmentLimit
          }
        })

        showPaymentLinkReady({
          kind: 'single',
          title: 'Enlace Mercado Pago listo',
          description: mercadoPagoMsiEnabled
            ? `Comparte este enlace para que el ${customerLowerLabel} pague con Mercado Pago. Se mostrarán hasta ${mercadoPagoInstallmentLimit} meses si su tarjeta lo permite.`
            : `Comparte este enlace para que el ${customerLowerLabel} pague de contado con Mercado Pago. Ristak actualizará el estado por webhook.`,
          provider: 'mercadopago',
          paymentUrl: result.paymentUrl,
          amount: invoiceSummary.amount,
          currency: invoiceSummary.currency,
          contact: selectedContact,
          paymentId: result.payment?.id,
          publicPaymentId: result.publicPaymentId
        })
        showToast(
          'success',
          'Link de Mercado Pago creado',
          'El enlace público está listo para copiar o enviar.'
        )
        onSuccess?.(LINK_READY_SUCCESS_CONTEXT)
      } catch (mercadoPagoError: any) {
        showToast('error', 'No se pudo crear el link de Mercado Pago', mercadoPagoError.message || 'Revisa la conexión de Mercado Pago.')
        setStep('options')
      } finally {
        setLoading(false)
      }
      return
    }

    if (paymentOption === 'clip') {
      if (!selectedContact) {
        showToast('error', 'Selecciona un contacto')
        setStep('options')
        setLoading(false)
        return
      }

      const contactEmail = selectedContact.email || invoiceSummary.contactEmail || ''
      const contactPhone = selectedContact.phone || ''
      if (!contactEmail || !contactPhone) {
        showToast('error', `Faltan datos del ${customerLowerLabel}`, 'CLIP requiere email y teléfono para crear el link de pago.')
        setStep('options')
        setLoading(false)
        return
      }

      if ((invoiceSummary.currency || accountCurrency || 'MXN').toUpperCase() !== 'MXN') {
        showToast('error', 'Moneda no soportada', 'CLIP Checkout Transparente solo acepta MXN. Usa otra pasarela para este cobro.')
        setStep('options')
        setLoading(false)
        return
      }

      try {
        const result = await clipPaymentsService.createPaymentLink({
          contactId: selectedContact.id,
          contactName: invoiceSummary.contactName || selectedContact.name,
          email: contactEmail,
          phone: contactPhone,
          amount: invoiceSummary.taxBaseAmount,
          currency: invoiceSummary.currency,
          applyTax: invoiceSummary.includesTax,
          taxCalculationMode: invoiceSummary.taxCalculationMode,
          title: invoicePayload.title || invoicePayload.name || DEFAULT_INVOICE_TITLE,
          description: invoiceSummary.description,
          dueDate: invoicePayload.dueDate,
          source: 'record_payment_modal_clip',
          lineItems: Array.isArray(invoicePayload.items) ? invoicePayload.items : [],
          installments: {
            enabled: clipMsiEnabled,
            maxInstallments: CLIP_INSTALLMENT_MAX_MONTHS
          }
        })

        showPaymentLinkReady({
          kind: 'single',
          title: 'Enlace CLIP listo',
          description: clipMsiEnabled
            ? `Comparte este enlace para que el ${customerLowerLabel} pague con CLIP. Si su tarjeta aplica, CLIP mostrará meses sin intereses dentro del formulario seguro.`
            : `Comparte este enlace para que el ${customerLowerLabel} pague con tarjeta en el checkout transparente de CLIP.`,
          provider: 'clip',
          paymentUrl: result.paymentUrl,
          amount: invoiceSummary.amount,
          currency: invoiceSummary.currency,
          contact: selectedContact,
          paymentId: result.payment?.id,
          publicPaymentId: result.publicPaymentId
        })
        showToast(
          'success',
          'Link de CLIP creado',
          clipMsiEnabled
            ? 'El enlace público quedó listo con meses sin intereses habilitado en CLIP.'
            : 'El enlace público está listo para copiar o enviar.'
        )
        onSuccess?.(LINK_READY_SUCCESS_CONTEXT)
      } catch (clipError: any) {
        showToast('error', 'No se pudo crear el link de CLIP', clipError.message || 'Revisa la configuración de CLIP.')
        setStep('options')
      } finally {
        setLoading(false)
      }
      return
    }

    if (paymentOption === 'rebill') {
      if (!selectedContact) {
        showToast('error', 'Selecciona un contacto')
        setStep('options')
        setLoading(false)
        return
      }

      try {
        const result = await rebillPaymentsService.createPaymentLink({
          contactId: selectedContact.id,
          contactName: invoiceSummary.contactName || selectedContact.name,
          email: selectedContact.email || invoiceSummary.contactEmail || '',
          phone: selectedContact.phone || '',
          amount: invoiceSummary.taxBaseAmount,
          currency: invoiceSummary.currency,
          applyTax: invoiceSummary.includesTax,
          taxCalculationMode: invoiceSummary.taxCalculationMode,
          title: invoicePayload.title || invoicePayload.name || DEFAULT_INVOICE_TITLE,
          description: invoiceSummary.description,
          dueDate: invoicePayload.dueDate,
          source: 'record_payment_modal_rebill',
          lineItems: Array.isArray(invoicePayload.items) ? invoicePayload.items : [],
          installments: {
            enabled: rebillMsiEnabled,
            maxInstallments: rebillMsiEnabled ? rebillInstallmentLimit : undefined
          }
        })

        showPaymentLinkReady({
          kind: 'single',
          title: 'Enlace Rebill listo',
          description: rebillMsiEnabled
            ? `Comparte este enlace para que el ${customerLowerLabel} pague con Rebill. Si su país, cuenta y tarjeta aplican, Rebill mostrará meses sin intereses hasta ${rebillInstallmentLimit} meses.`
            : `Comparte este enlace para que el ${customerLowerLabel} pague de contado en el checkout seguro de Rebill.`,
          provider: 'rebill',
          paymentUrl: result.paymentUrl,
          amount: invoiceSummary.amount,
          currency: invoiceSummary.currency,
          contact: selectedContact,
          paymentId: result.payment?.id,
          publicPaymentId: result.publicPaymentId
        })
        showToast(
          'success',
          'Link de Rebill creado',
          rebillMsiEnabled
            ? `El enlace público quedó listo con MSI hasta ${rebillInstallmentLimit} meses en Rebill.`
            : 'El enlace público está listo para copiar o enviar.'
        )
        onSuccess?.(LINK_READY_SUCCESS_CONTEXT)
      } catch (rebillError: any) {
        showToast('error', 'No se pudo crear el link de Rebill', rebillError.message || 'Revisa la conexión de Rebill.')
        setStep('options')
      } finally {
        setLoading(false)
      }
      return
    }

    // Modo local de Ristak: registrar el pago directamente en la base propia.
    if (!highLevelConnected) {
      if (!selectedContact) {
        showToast('error', 'Selecciona un contacto')
        setStep('options')
        setLoading(false)
        return
      }

      try {
        const transactionData = {
          date: buildPaymentTimestamp(manualPaymentData.paymentDate, timezone),
          contactId: selectedContact.id,
          contactName: selectedContact.name,
          email: selectedContact.email || '',
          phone: selectedContact.phone || '',
          amount: invoiceSummary.amount,
          currency: invoiceSummary.currency,
          method: manualPaymentData.paymentMethod as any,
          status: 'paid',
          reference: manualPaymentData.reference,
          title: invoicePayload.title || invoicePayload.name || DEFAULT_INVOICE_TITLE,
          description: [invoiceSummary.description, manualPaymentData.notes].filter(Boolean).join('\n'),
          dueDate: invoicePayload.dueDate,
          metadata: {
            lineItems: Array.isArray(invoicePayload.items) ? invoicePayload.items : [],
            ...(invoiceSummary.includesTax && {
              tax: {
                enabled: true,
                taxName: invoiceSummary.taxName,
                rateType: 'percentage',
                rateValue: invoiceSummary.taxRate,
                rateSource: 'automatic',
                calculationMode: invoiceSummary.taxCalculationMode,
                subtotalAmount: invoiceSummary.subtotal,
                taxAmount: invoiceSummary.taxAmount,
                totalAmount: invoiceSummary.amount
              }
            })
          }
        } satisfies Parameters<typeof transactionsService.createTransaction>[0]
        const requestIntent = manualPaymentIdempotencyScope
          ? resolveStableRequestIntent(
              manualPaymentRequestRef.current,
              manualPaymentIdempotencyScope,
              {
                ...transactionData,
                date: manualPaymentData.paymentDate
              }
            )
          : null
        if (requestIntent) manualPaymentRequestRef.current = requestIntent

        await transactionsService.createTransaction(transactionData, {
          idempotencyKey: requestIntent?.clientRequestId
        })
        manualPaymentRequestRef.current = null

        showToast('success', 'Éxito', 'Pago registrado correctamente')
        onSuccess?.()
        onClose()
      } catch (localError: any) {
        showToast('error', 'Error', localError.message || 'No se pudo registrar el pago')
        setStep('options')
      } finally {
        setLoading(false)
      }
      return
    }

    try {
      if (activePaymentMode === 'partial') {
        const channels = paymentOption === 'send'
          ? {
              email: EMAIL_SEND_METHODS.has(effectiveSendMethod),
              sms: SMS_SEND_METHODS.has(effectiveSendMethod),
              whatsapp: WHATSAPP_SEND_METHODS.has(effectiveSendMethod)
            }
          : {
              email: false,
              sms: false,
              whatsapp: false
            }

        await submitPartialFlow(invoicePayload, invoiceSummary, channels)
        return
      }

      let invoiceId = invoiceSummary.invoiceId
      processedInvoiceId = invoiceId

      if (!invoiceId) {
        // Crear una copia limpia del payload para evitar referencias circulares
        const cleanPayload = {
          name: invoicePayload.name,
          title: invoicePayload.title,
          currency: invoicePayload.currency,
          businessDetails: {
            name: invoicePayload.businessDetails?.name || '',
            ...(invoicePayload.businessDetails?.email && { email: invoicePayload.businessDetails.email }),
            ...(invoicePayload.businessDetails?.logoUrl && { logoUrl: invoicePayload.businessDetails.logoUrl }),
            ...(invoicePayload.businessDetails?.phone && { phone: invoicePayload.businessDetails.phone }),
            ...(invoicePayload.businessDetails?.website && { website: invoicePayload.businessDetails.website }),
            ...(invoicePayload.businessDetails?.address && {
              address: {
                line1: invoicePayload.businessDetails.address.line1 || '',
                ...(invoicePayload.businessDetails.address.city && { city: invoicePayload.businessDetails.address.city }),
                ...(invoicePayload.businessDetails.address.state && { state: invoicePayload.businessDetails.address.state }),
                ...(invoicePayload.businessDetails.address.country && { country: invoicePayload.businessDetails.address.country }),
                ...(invoicePayload.businessDetails.address.postalCode && { postalCode: invoicePayload.businessDetails.address.postalCode })
              }
            })
          },
          contactDetails: {
            id: invoicePayload.contactDetails?.id || '',
            name: invoicePayload.contactDetails?.name || '',
            email: invoicePayload.contactDetails?.email || '',
            phoneNo: invoicePayload.contactDetails?.phoneNo || ''
          },
          items: invoicePayload.items?.map((item: any) => ({
            name: item.name,
            description: item.description,
            amount: item.amount,
            qty: item.qty,
            currency: item.currency,
            ...(item.priceId && { priceId: item.priceId }),
            ...(item.productId && { productId: item.productId })
          })) || [],
          metadata: {
            lineItems: Array.isArray(invoicePayload.items) ? invoicePayload.items : [],
            ...(invoiceSummary.includesTax && {
              tax: {
                enabled: true,
                taxName: invoiceSummary.taxName,
                rateType: 'percentage',
                rateValue: invoiceSummary.taxRate,
                rateSource: 'automatic',
                calculationMode: invoiceSummary.taxCalculationMode,
                subtotalAmount: invoiceSummary.subtotal,
                taxAmount: invoiceSummary.taxAmount,
                totalAmount: invoiceSummary.amount
              }
            })
          },
          issueDate: invoicePayload.issueDate,
          dueDate: invoicePayload.dueDate,
          liveMode: invoicePayload.liveMode,
          ...(invoicePayload.tax && {
            tax: {
              name: invoicePayload.tax.name,
              rate: invoicePayload.tax.rate,
              amount: invoicePayload.tax.amount
            }
          }),
          ...(invoicePayload.termsNotes && { termsNotes: invoicePayload.termsNotes })
        }

        const response = await fetch(apiUrl('/api/highlevel/invoices'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cleanPayload)
        })

        const data = await response.json()
        if (!response.ok) {
          throw new Error(data.error || 'Error al crear el invoice')
        }

        invoiceId = data.invoice?.id || data.invoice?._id
        processedInvoiceId = invoiceId

        if (!invoiceId) {
          throw new Error('No se pudo obtener el ID del invoice')
        }

        setInvoiceSummary(prev => (prev ? { ...prev, invoiceId } : prev))
      }

      switch (paymentOption) {
        case 'send': {
          if (PHONE_SEND_METHODS.has(effectiveSendMethod) && !selectedContact?.phone) {
            throw new Error(`El contacto no tiene teléfono registrado. No se puede enviar por ${getSendMethodLabel(effectiveSendMethod)}.`)
          }

          if (EMAIL_SEND_METHODS.has(effectiveSendMethod) && !selectedContact?.email) {
            throw new Error('El contacto no tiene email registrado. No se puede enviar por correo.')
          }

          // Enviar enlace por el método seleccionado
          await highLevelService.sendInvoice(invoiceId, toInvoiceSendMethod(effectiveSendMethod))

          const successMessage = `Enlace enviado por ${getSendMethodLabel(effectiveSendMethod)} correctamente`

          showToast('success', 'Éxito', successMessage)
          break
        }
        case 'manual': {
          const response = await fetch(apiUrl(`/api/highlevel/invoices/${invoiceId}/record-payment`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              amount: invoiceSummary.amount,
              currency: invoiceSummary.currency,
              paymentDate: buildPaymentTimestamp(manualPaymentData.paymentDate, timezone),
              paymentMethod: manualPaymentData.paymentMethod,
              reference: manualPaymentData.reference,
              notes: manualPaymentData.notes
            })
          })

          const data = await response.json()
          if (!response.ok) {
            throw new Error(data.error || 'No se pudo registrar el pago')
          }

          showToast('success', 'Éxito', 'Pago registrado correctamente')
          break
        }
        default:
          break
      }

      // Sincronizar el invoice específico desde GHL para asegurar que la BD
      // tiene el estado actualizado. Silencioso: si falla, los datos locales
      // ya están correctos gracias a createInvoice + recordPayment.
      try {
        await fetch(apiUrl(`/api/highlevel/invoices/${invoiceId}/sync`), { method: 'POST' })
      } catch {
        // continuar aunque falle el sync — datos locales ya son correctos
      }

      onSuccess?.()
      onClose()
    } catch (error: any) {
      const canSaveManualPaymentLocally = paymentOption === 'manual' && !processedInvoiceId

      if (canSaveManualPaymentLocally && selectedContact) {
        try {
          const transactionData = {
            date: buildPaymentTimestamp(manualPaymentData.paymentDate, timezone),
            contactId: selectedContact.id,
            contactName: selectedContact.name,
            email: selectedContact.email || '',
            phone: selectedContact.phone || '',
            amount: invoiceSummary.amount,
            currency: invoiceSummary.currency,
            method: manualPaymentData.paymentMethod as any,
            status: 'paid',
            reference: manualPaymentData.reference,
            title: invoicePayload.title || invoicePayload.name || DEFAULT_INVOICE_TITLE,
            description: [invoiceSummary.description, manualPaymentData.notes].filter(Boolean).join('\n'),
            dueDate: invoicePayload.dueDate,
            metadata: {
              lineItems: Array.isArray(invoicePayload.items) ? invoicePayload.items : [],
              ...(invoiceSummary.includesTax && {
                tax: {
                  enabled: true,
                  taxName: invoiceSummary.taxName,
                  rateType: 'percentage',
                  rateValue: invoiceSummary.taxRate,
                  rateSource: 'automatic',
                  calculationMode: invoiceSummary.taxCalculationMode,
                  subtotalAmount: invoiceSummary.subtotal,
                  taxAmount: invoiceSummary.taxAmount,
                  totalAmount: invoiceSummary.amount
                }
              })
            }
          } satisfies Parameters<typeof transactionsService.createTransaction>[0]
          const requestIntent = manualPaymentIdempotencyScope
            ? resolveStableRequestIntent(
                manualPaymentRequestRef.current,
                manualPaymentIdempotencyScope,
                {
                  ...transactionData,
                  date: manualPaymentData.paymentDate
                }
              )
            : null
          if (requestIntent) manualPaymentRequestRef.current = requestIntent

          await transactionsService.createTransaction(transactionData, {
            idempotencyKey: requestIntent?.clientRequestId
          })
          manualPaymentRequestRef.current = null

          showToast('success', 'Pago registrado en Ristak', 'El pago quedó guardado y aparecerá en el historial del contacto.')
          onSuccess?.()
          onClose()
          return
        } catch (localError: any) {
          showToast('error', 'Error', localError.message || 'No se pudo registrar el pago localmente')
          setStep('options')
          return
        }
      }

      showToast('error', 'Error', error.message || 'No se pudo completar la operación')
      setStep('options')
    } finally {
      setLoading(false)
    }
  }

  const renderForm = () => {
    const subtotalAmount = chargeType === 'product'
      ? normalizeAmount(customAmount)
      : normalizeAmount(amount)

    const taxBreakdown = calculateConfiguredTax(subtotalAmount, paymentTaxes, includeIVA, taxCalculationMode)
    const taxAmount = taxBreakdown.taxAmount
    const totalAmount = taxBreakdown.totalAmount
    const taxName = getConfiguredTaxName(paymentTaxes)
    const taxRate = getConfiguredTaxRate(paymentTaxes)

    const renderPaymentModeField = () => {
      // El tipo de flujo se decide desde la entrada: pago unico o plan de pagos.
      // Aqui no se muestra selector para evitar cambiar de modo dentro del formulario.
      return null
    }

    const renderEmbeddedContactPicker = () => {
      if (!isEmbedded || !contactPickerOpen) return null

      const trimmedQuery = searchQuery.trim()
      const shouldPromptSearch = trimmedQuery.length < 2 && !searchingContact

      return (
        <div className={styles.embeddedSheetOverlay} onClick={closeContactPicker}>
          <section
            className={styles.embeddedSheet}
            aria-label="Buscar contacto para cobrar"
            onClick={(event) => event.stopPropagation()}
          >
            <header className={styles.embeddedSheetHeader}>
              <div>
                <span>{customerLabel}</span>
                <strong>Seleccionar contacto</strong>
              </div>
              <button type="button" onClick={closeContactPicker} aria-label="Cerrar búsqueda">
                <ChevronLeft size={19} />
              </button>
            </header>

            <div className={styles.contactSearchBox} data-ristak-unstyled>
              <Search size={16} className={styles.searchIcon} />
              <input
                {...suppressContactAutofill}
                type="text"
                placeholder="Buscar contacto"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className={styles.input}
                aria-label="Buscar contacto para cobrar"
                autoFocus
              />
              {searchingContact && <Loader2 size={16} className={styles.loadingIcon} />}
            </div>

            <div className={styles.contactList} data-phone-scrollable="true">
              {searchingContact && contacts.length === 0 ? (
                <div className={styles.contactListState}>
                  <Loader2 size={18} className={styles.inlineSpinner} />
                  <span>Buscando contactos...</span>
                </div>
              ) : contacts.length > 0 ? (
                contacts.map((contact) => (
                  <button
                    key={contact.id}
                    type="button"
                    className={styles.contactOption}
                    onClick={() => handleSelectContact(contact)}
                  >
                    <span className={styles.contactAvatar}>{getContactInitials(contact)}</span>
                    <span className={styles.contactMain}>
                      <strong>{getContactDisplayName(contact)}</strong>
                      <small>{getContactDisplayDetail(contact)}</small>
                    </span>
                  </button>
                ))
              ) : (
                <div className={styles.contactListState}>
                  <User size={22} />
                  <span>
                    {shouldPromptSearch
                      ? 'Busca por nombre, teléfono o correo.'
                      : 'No se encontraron contactos.'}
                  </span>
                </div>
              )}
            </div>
          </section>
        </div>
      )
    }

    return (
      <div className={styles.content} data-modal-panel="">
        {!contactLocked && (
          isEmbedded ? (
            <div className={`${styles.field} ${styles.contactPickerField}`}>
              <label className={styles.label}>{customerLabel}</label>
              <>
                <div className={styles.contactPickerControl}>
                  <button
                    type="button"
                    className={styles.contactPickerTrigger}
                    onClick={openContactPicker}
                  >
                    <span className={selectedContact ? styles.contactAvatar : styles.contactPickerIcon}>
                      {selectedContact ? getContactInitials(selectedContact) : <Search size={18} />}
                    </span>
                    <span className={styles.contactMain}>
                      <strong>{selectedContact ? getContactDisplayName(selectedContact) : 'Seleccionar contacto'}</strong>
                      <small>{selectedContact ? getContactDisplayDetail(selectedContact) : 'Busca por nombre, teléfono o correo'}</small>
                    </span>
                    <ChevronRight size={18} className={styles.contactPickerChevron} aria-hidden="true" />
                  </button>
                  {selectedContact && (
                    <button
                      type="button"
                      onClick={handleClearContact}
                      className={styles.contactPickerClear}
                      aria-label="Quitar contacto seleccionado"
                    >
                      <X size={17} />
                    </button>
                  )}
                </div>
                {renderEmbeddedContactPicker()}
              </>
            </div>
          ) : (
            <div className={styles.field}>
              <ContactSearchInput
                label={customerLabel}
                value={selectedContact}
                onChange={(contact) => {
                  if (contact) {
                    handleSelectContact(contact)
                    return
                  }
                  handleClearContact()
                }}
                placeholder={`Buscar ${customerLowerLabel} por nombre, email o teléfono`}
                required
              />
            </div>
          )
        )}

        <div className={styles.field}>
          <label className={styles.label}>Tipo de cobro</label>
          <div className={styles.segmentedTabsField}>
            {renderPaymentSegmentedTabs({
              ariaLabel: 'Tipo de cobro',
              options: [
                { value: 'direct', label: 'Personalizado' },
                { value: 'product', label: 'Productos' }
              ],
              value: chargeType,
              onChange: (value) => {
                if (value === 'direct') {
                  setChargeType('direct')
                  setSelectedProduct(null)
                  setSelectedPrice(null)
                  setPrices([])
                  setCustomAmount('')
                  setCurrency(accountCurrency)
                  setShowCreateProduct(false)
                } else {
                  setChargeType('product')
                  setAmount('')
                  setCurrency(accountCurrency)
                }
              }
            })}
          </div>
        </div>

        {chargeType === 'direct' && renderPaymentModeField()}

        {chargeType === 'product' && (
          <>
            <div className={styles.field}>
              <div className={styles.fieldHeader}>
                <label className={styles.label}>Producto</label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setShowCreateProduct(prev => !prev)
                  }}
                >
                  <Plus size={14} />
                  Nuevo
                </Button>
              </div>
              <CustomSelect
                options={[
                  { value: '', label: 'Selecciona un producto' },
                  ...products.map((product) => ({
                    value: product.id || product._id || product.localId || '',
                    label: product.name
                  }))
                ]}
                value={selectedProduct?.id || selectedProduct?._id || selectedProduct?.localId || ''}
                onValueChange={(value) => {
                  const product = products.find(p => (p.id || p._id || p.localId) === value)
                  setSelectedProduct(product || null)
                  setSelectedPrice(null)
                  setPrices([])
                }}
                disabled={loadingProducts}
                placeholder="Selecciona un producto"
              />
              {loadingProducts && <p className={styles.hint} role="status" aria-live="polite" aria-label="Cargando productos" />}
            </div>

            {showCreateProduct && (
              <div className={styles.quickProductPanel}>
                <div className={styles.fieldGrid}>
                  <div className={styles.field}>
                    <label className={styles.label}>Nombre</label>
                    <input
                      className={styles.input}
                      value={newProductName}
                      onChange={(event) => setNewProductName(event.target.value)}
                      placeholder="Producto"
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>Precio</label>
                    <div className={styles.amountInput}>
                      <DollarSign size={16} className={styles.dollarIcon} />
                      <NumberInput
                        step="0.01"
                        min="0"
                        className={styles.input}
                        value={newProductAmount}
                        onChange={(event) => setNewProductAmount(event.target.value)}
                        placeholder="0.00"
                      />
                    </div>
                  </div>
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Nombre del precio</label>
                  <input
                    className={styles.input}
                    value={newProductPriceName}
                    onChange={(event) => setNewProductPriceName(event.target.value)}
                    placeholder="Precio base"
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Descripción</label>
                  <input
                    className={styles.input}
                    value={newProductDescription}
                    onChange={(event) => setNewProductDescription(event.target.value)}
                    placeholder="Detalle"
                  />
                </div>

                {gigstackProductMappingEnabled && (
                  <div className={styles.quickProductFiscalPanel}>
                    <div className={styles.quickProductFiscalHeader}>
                      <span className={styles.quickProductFiscalTitle}>
                        <PaymentPlatformLogo platform="gigstack" size="sm" decorative />
                        <span>Facturación e impuestos</span>
                      </span>
                      <span className={styles.quickProductFiscalChip}>
                        {newProductGigstackProductKey ? 'Mapeado' : 'Default'}
                      </span>
                    </div>
                    <div className={styles.fieldGrid}>
                      <div className={styles.field}>
                        <label className={styles.label}>Categoría SAT para facturas</label>
                        <CustomSelect
                          value={newProductGigstackProductKey}
                          onValueChange={setNewProductGigstackProductKey}
                          options={[
                            {
                              value: '',
                              label: paymentTaxes.gigstackDefaultProductKey
                                ? `Usar default · ${paymentTaxes.gigstackDefaultProductKey}`
                                : 'Usar default de Gigstack'
                            },
                            ...gigstackProductKeyOptions
                          ]}
                          placeholder="Usar default de Gigstack"
                          className={styles.customSelectControl}
                          portal
                          searchable
                          searchPlaceholder="Busca o escribe 8 dígitos"
                          allowCustomValue
                          normalizeCustomValue={normalizeGigstackProductKeyInput}
                          isCustomValueValid={isValidGigstackProductKey}
                          getCustomValueLabel={(value) => `Usar clave SAT ${value}`}
                        />
                      </div>
                      <div className={styles.field}>
                        <label className={styles.label}>Unidad fiscal</label>
                        <CustomSelect
                          value={newProductGigstackUnitKey}
                          onValueChange={setNewProductGigstackUnitKey}
                          options={[
                            {
                              value: '',
                              label: paymentTaxes.gigstackDefaultUnitKey
                                ? `Usar default · ${paymentTaxes.gigstackDefaultUnitKey}`
                                : 'Usar default de Gigstack'
                            },
                            ...gigstackUnitOptions
                          ]}
                          placeholder="Usar default de Gigstack"
                          className={styles.customSelectControl}
                          portal
                          searchable
                          searchPlaceholder="Busca o escribe la unidad"
                          allowCustomValue
                          normalizeCustomValue={normalizeGigstackUnitKeyInput}
                          isCustomValueValid={isValidGigstackUnitKey}
                          getCustomValueLabel={(value) => `Usar unidad SAT ${value}`}
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div className={styles.quickProductActions}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    loading={creatingProduct}
                    onClick={handleCreateProduct}
                  >
                    Guardar producto
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowCreateProduct(false)
                      resetNewProductForm()
                    }}
                    disabled={creatingProduct}
                  >
                    Cancelar
                  </Button>
                </div>
              </div>
            )}

            {selectedProduct && (
              <div className={styles.field}>
                <label className={styles.label}>Precio</label>
                <CustomSelect
                  options={[
                    { value: '', label: 'Selecciona un precio' },
                    ...prices.map((price) => ({
                      value: price.id || price._id || price.localId || '',
                      label: `${price.name || 'Precio'} - ${formatCurrency(price.amount || price.price, accountCurrency)}`
                    }))
                  ]}
                  value={selectedPrice?.id || selectedPrice?._id || selectedPrice?.localId || ''}
                  onValueChange={(value) => {
                    const price = prices.find(p => (p.id || p._id || p.localId) === value)
                    setSelectedPrice(price || null)
                  }}
                  placeholder="Selecciona un precio"
                />
                {prices.length === 0 && (
                  <p className={styles.hint}>No hay precios disponibles para este producto</p>
                )}
              </div>
            )}

            {selectedProduct && selectedPrice && (
              <>
                <div className={styles.field}>
                  <label className={styles.label}>Monto a cobrar (personalizable)</label>
                  <div className={styles.amountInput}>
                    <DollarSign size={16} className={styles.dollarIcon} />
                    <NumberInput
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={customAmount}
                      onChange={(e) => setCustomAmount(e.target.value)}
                      className={styles.input}
                    />
                  </div>
                  <p className={styles.hint}>Puedes modificar el precio según tu negociación con el {customerLowerLabel}</p>
                </div>
                {renderPaymentModeField()}
              </>
            )}
          </>
        )}

        {chargeType === 'direct' && (
          <div className={styles.field}>
            <label className={styles.label}>Monto ({currency})</label>
            <div className={styles.amountInput}>
              <DollarSign size={16} className={styles.dollarIcon} />
              <NumberInput
                step="0.01"
                min="0"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={styles.input}
              />
            </div>
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.label}>Título de factura</label>
          <input
            type="text"
            placeholder={DEFAULT_INVOICE_TITLE}
            value={paymentTitle}
            onChange={(e) => setPaymentTitle(e.target.value)}
            className={styles.input}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Descripción del producto / detalle</label>
          <input
            type="text"
            placeholder="Ej: Pago de servicios, consulta, etc."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={styles.input}
          />
        </div>

        {activePaymentMode === 'partial' && (
          <div className={styles.planSection}>
            <div className={styles.planIntro}>
              <div className={styles.planIntroText}>
                <p>Plan de pagos</p>
                <span>Define el primer pago y los cobros automáticos hasta cubrir el total a cobrar.</span>
              </div>
            </div>

            <div className={styles.fieldGrid}>
              <div className={styles.manualField}>
                <label>Frecuencia de cobro</label>
                {renderPaymentSelect({
                  value: remainingFrequency,
                  onChange: (value) => setRemainingFrequency(value as RemainingFrequency),
                  options: remainingFrequencyOptions,
                  title: 'Frecuencia de cobro'
                })}
              </div>
              <div className={styles.manualField}>
                <label>Tipo de valor</label>
                {renderPaymentSelect({
                  value: effectiveRemainingValueType,
                  onChange: (value) => {
                    setRemainingValueType(value as InstallmentValueType)
                    setFirstPaymentType(value as InstallmentValueType)
                    setAutoDistributeRemaining(true)
                  },
                  options: INSTALLMENT_VALUE_TYPE_OPTIONS,
                  title: 'Tipo de valor'
                })}
              </div>
            </div>

            <p className={styles.planHint}>
              {remainingFrequency === 'custom'
                ? `Ajusta ${effectiveRemainingValueType === 'percentage' ? 'el porcentaje' : 'el monto'} y la fecha de cada cobro.`
                : 'Las fechas se calculan automáticamente. Cambia a “Personalizada” para editarlas a mano.'}
            </p>

            <div className={styles.planList}>
              <div className={styles.planListHead}>
                <span>#</span>
                <span>Valor</span>
                <span>Fecha de cobro</span>
                <span aria-hidden="true" />
              </div>

              {([
                ...(firstPaymentEnabled ? [{ kind: 'first' as const }] : []),
                ...resolvedRemainingInstallments.map((inst) => ({ kind: 'remaining' as const, inst }))
              ]).map((row, index) => {
                const isFirstVisual = index === 0
                const isPercentage = effectiveRemainingValueType === 'percentage'
                const ValueIcon = isPercentage ? Percent : DollarSign
                const methodControl = isFirstVisual ? (
                  <div className={styles.planFirstMethod}>
                    <div className={styles.planFirstMethodControl}>
                      {renderPaymentSelect({
                        value: firstPaymentEnabled ? 'immediate' : 'scheduled',
                        onChange: handleFirstPaymentTimingChange,
                        options: FIRST_PAYMENT_TIMING_OPTIONS,
                        title: 'Primer pago'
                      })}
                    </div>
                    {firstPaymentEnabled && (
                      <div className={styles.planFirstMethodControl}>
                        {renderPaymentSelect({
                          value: firstPaymentMethod || 'card',
                          onChange: (value) => setFirstPaymentMethod(value as FirstPaymentMethod),
                          options: FIRST_PAYMENT_IMMEDIATE_METHOD_OPTIONS,
                          title: 'Cómo cobrar el primer pago'
                        })}
                      </div>
                    )}
                  </div>
                ) : null

                if (row.kind === 'first') {
                  return (
                    <div key="first-payment" className={styles.planRow}>
                      <div className={styles.planSeq}>{index + 1}</div>
                      <div className={styles.planValueCell}>
                        <span className={styles.cellLabel}>Valor</span>
                        <div className={styles.amountInput}>
                          <ValueIcon size={16} className={styles.dollarIcon} />
                          <NumberInput
                            step="0.01"
                            min="0"
                            value={firstPaymentValue}
                            onChange={(e) => {
                              setFirstPaymentValue(e.target.value)
                              setFirstPaymentAuto(false)
                              setAutoDistributeRemaining(true)
                            }}
                            className={styles.input}
                            aria-label="Valor del primer pago"
                          />
                        </div>
                        {isPercentage && (
                          <span className={styles.planAmountHint}>= {formatCurrency(firstPaymentAmount, currency)}</span>
                        )}
                      </div>
                      <div className={styles.planDateCell}>
                        <span className={styles.cellLabel}>Fecha de cobro</span>
                        <PhoneDateField
                          value={firstPaymentDate}
                          min={getBusinessTodayInputValue(timezone)}
                          onChange={setFirstPaymentDate}
                          title="Fecha del primer pago"
                          ariaLabel="Fecha del primer pago"
                          buttonClassName={styles.phoneDateButton}
                          inlineOnWide
                        />
                      </div>
                      <div className={styles.planDeleteCell} aria-hidden="true" />
                      {methodControl}
                    </div>
                  )
                }

                const installment = row.inst
                return (
                  <div key={installment.id} className={styles.planRow}>
                    <div className={styles.planSeq}>{index + 1}</div>
                    <div className={styles.planValueCell}>
                      <span className={styles.cellLabel}>Valor</span>
                      <div className={styles.amountInput}>
                        <ValueIcon size={16} className={styles.dollarIcon} />
                        <NumberInput
                          step="0.01"
                          min="0"
                          value={installment.value}
                          onChange={(e) => updateRemainingInstallment(installment.id, { value: e.target.value })}
                          className={styles.input}
                          aria-label={`Valor del cobro ${index + 1}`}
                        />
                      </div>
                      {isPercentage && (
                        <span className={styles.planAmountHint}>= {formatCurrency(installment.amount, currency)}</span>
                      )}
                    </div>
                    <div className={styles.planDateCell}>
                      <span className={styles.cellLabel}>Fecha de cobro</span>
                      <PhoneDateField
                        value={installment.dueDate}
                        min={getBusinessTodayInputValue(timezone)}
                        onChange={(value) => updateRemainingInstallment(installment.id, { dueDate: value })}
                        disabled={remainingFrequency !== 'custom'}
                        title={`Fecha del cobro ${index + 1}`}
                        ariaLabel={`Fecha del cobro ${index + 1}`}
                        buttonClassName={styles.phoneDateButton}
                        inlineOnWide
                      />
                    </div>
                    <div className={styles.planDeleteCell}>
                      <button
                        type="button"
                        className={`${styles.iconButton} ${styles.installmentDelete}`}
                        onClick={() => removeRemainingInstallment(installment.id)}
                        disabled={remainingInstallments.length <= 1}
                        title="Eliminar cobro"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    {methodControl}
                  </div>
                )
              })}
            </div>

            <button
              type="button"
              className={styles.addInstallment}
              onClick={addRemainingInstallment}
            >
              <Plus size={16} />
              Agregar pago
            </button>

            <div className={`${styles.allocation} ${
              partialPlanStatus === 'ok'
                ? styles.allocationOk
                : partialPlanStatus === 'under'
                  ? styles.allocationWarn
                  : styles.allocationError
            }`}>
              <div className={styles.allocationTop}>
                <span>Asignado al plan</span>
                <strong>
                  {formatCurrency(partialPlanTotal, currency)}
                  <em> / {formatCurrency(totalAmount, currency)}</em>
                </strong>
              </div>
              <div className={styles.allocationBar}>
                <div className={styles.allocationFill} style={{ width: `${partialAllocatedPct}%` }} />
              </div>
              <div className={styles.allocationStatus}>
                {partialPlanStatus === 'ok' ? (
                  <>
                    <Check size={15} />
                    <span>El plan cuadra con el total a cobrar.</span>
                  </>
                ) : partialPlanStatus === 'under' ? (
                  <>
                    <AlertCircle size={15} />
                    <span>Faltan {formatCurrency(partialPlanDifference, currency)} por asignar.</span>
                  </>
                ) : (
                  <>
                    <AlertCircle size={15} />
                    <span>Te excediste {formatCurrency(Math.abs(partialPlanDifference), currency)} del total.</span>
                  </>
                )}
              </div>
            </div>

            <div className={styles.authorizationNotice}>
              <ShieldCheck size={16} />
              <span>{partialAuthorizationNotice}</span>
            </div>
          </div>
        )}

        {paymentTaxes.enabled && (
          <>
            <div className={styles.field}>
              <label className={styles.label}>{taxName}</label>
              <div className={styles.segmentedTabsField}>
                {renderPaymentSegmentedTabs({
                  ariaLabel: taxName,
                  options: [
                    { value: 'sin', label: `Sin ${taxName}` },
                    { value: 'con', label: `Aplicar ${taxRate}%` }
                  ],
                  value: includeIVA ? 'con' : 'sin',
                  onChange: (value) => setIncludeIVA(value === 'con')
                })}
              </div>
            </div>

            {includeIVA && (
              <div className={styles.field}>
                <label className={styles.label}>Cálculo del impuesto</label>
                <div className={styles.segmentedTabsField}>
                  {renderPaymentSegmentedTabs({
                    ariaLabel: 'Cálculo del impuesto',
                    options: [
                      { value: 'exclusive', label: 'Se suma al total' },
                      { value: 'inclusive', label: 'Ya incluido' }
                    ],
                    value: taxCalculationMode,
                    onChange: (value) => setTaxCalculationMode(value as PaymentTaxSettings['calculationMode'])
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {/* En embedded el total vive en la barra inferior fija; la tarjeta solo aplica en el modal de escritorio */}
        {!isEmbedded && (
          <div className={styles.summaryCard}>
            <div className={styles.summaryHeader}>
              <span>Resumen del cobro</span>
              <span className={styles.summaryBadge}>
                {chargeType === 'product' ? 'Productos' : 'Personalizado'}
              </span>
            </div>
            <div className={styles.summaryBody}>
              <div className={styles.summaryRow}>
                <span>Subtotal</span>
                <span>{formatCurrency(subtotalAmount, currency)}</span>
              </div>
              {taxBreakdown.includesTax && (
                <div className={styles.summaryRow}>
                  <span>{taxName} ({taxRate}%)</span>
                  <span className={styles.summaryTax}>{taxCalculationMode === 'exclusive' ? '+ ' : ''}{formatCurrency(taxAmount, currency)}</span>
                </div>
              )}
            </div>
            <div className={styles.summaryFooter}>
              <span>Total a cobrar</span>
              <span className={styles.summaryTotal}>{formatCurrency(totalAmount, currency)}</span>
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderPaymentOptions = () => {
    if (!invoiceSummary) return null

    if (activePaymentMode === 'partial') {
      const showPlanGatewayPicker = singlePaymentOptionsStage === 'gateway' && stripePlanCardSource === 'new_card' && hasMultiplePaymentPlanGateways
      const showPlanSavedCardPicker = singlePaymentOptionsStage === 'saved_cards' && stripePlanCardSource === 'saved_card'
      const showPlanMethodPicker = singlePaymentOptionsStage === 'method'
      const currentStripePlanPaymentMethodId = selectedSavedPaymentMethodId ||
        stripePlanSavedPaymentMethod?.stripePaymentMethodId ||
        stripePlanSavedPaymentMethod?.id ||
        ''
      const currentConektaPlanPaymentSourceId = selectedConektaPaymentSourceId ||
        conektaPlanSavedPaymentSource?.conektaPaymentSourceId ||
        conektaPlanSavedPaymentSource?.id ||
        ''
      const currentRebillPlanPaymentSourceId = selectedRebillPaymentSourceId ||
        rebillPlanSavedPaymentSource?.rebillCardId ||
        rebillPlanSavedPaymentSource?.id ||
        ''
      const stripeSavedCardLabel = stripePlanSavedPaymentMethod
        ? `Stripe usará ${getSavedCardDescription(stripePlanSavedPaymentMethod)} para los cobros programados.`
        : 'Selecciona una tarjeta guardada para programar este plan.'
      const stripeNewCardLabel = firstPaymentEnabled && firstPaymentMethod === 'card'
          ? 'La pasarela enviará el primer link; cuando se pague, guardará la tarjeta y activará los cobros futuros.'
          : `La pasarela enviará domiciliación por ${formatCurrency(cardSetupAmount, invoiceSummary.currency)}; al pagarse, guardará la tarjeta y activará el plan.`
      const stripeAuthorizationLabel = stripePlanCardSource === 'saved_card'
        ? stripeSavedCardLabel
        : stripeNewCardLabel
      const conektaSavedCardLabel = conektaPlanSavedPaymentSource
        ? `Conekta usará ${getSavedConektaCardDescription(conektaPlanSavedPaymentSource)} para los cobros programados.`
        : 'Selecciona una tarjeta guardada para programar este plan.'
      const conektaNewCardLabel = firstPaymentEnabled && firstPaymentMethod === 'card'
          ? 'Conekta enviará el primer link; cuando se pague, guardará la tarjeta y activará los cobros futuros.'
          : `Conekta enviará domiciliación por ${formatCurrency(cardSetupAmount, invoiceSummary.currency)}; al pagarse, guardará la tarjeta y activará el plan.`
      const conektaAuthorizationLabel = stripePlanCardSource === 'saved_card'
        ? conektaSavedCardLabel
        : conektaNewCardLabel
      const rebillSavedCardLabel = rebillPlanSavedPaymentSource
        ? `Rebill usará ${getSavedRebillCardDescription(rebillPlanSavedPaymentSource)} para los cobros programados.`
        : 'Selecciona una tarjeta guardada para programar este plan.'
      const rebillNewCardLabel = firstPaymentEnabled && firstPaymentMethod === 'card'
          ? 'Rebill enviará el primer link; cuando se pague, guardará la tarjeta y activará los cobros futuros.'
          : `Rebill enviará domiciliación por ${formatCurrency(cardSetupAmount, invoiceSummary.currency)}; al pagarse, guardará la tarjeta y activará el plan.`
      const rebillAuthorizationLabel = stripePlanCardSource === 'saved_card'
        ? rebillSavedCardLabel
        : rebillNewCardLabel
      const highLevelAuthorizationLabel = partialNeedsCardAuthorization
        ? `HighLevel enviará domiciliación por ${formatCurrency(cardSetupAmount, invoiceSummary.currency)} cuando haga falta autorizar tarjeta.`
        : 'El primer pago con tarjeta autoriza la tarjeta en HighLevel.'
      const paymentPlanNewCardActionDescription = paymentPlanGatewayLabels.length > 1
        ? `Después eliges pasarela: ${paymentPlanGatewayLabels.join(', ')}.`
        : defaultPaymentPlanGatewayOption === 'rebill'
          ? 'Rebill guardará la tarjeta y Ristak cobrará cada parcialidad cuando toque.'
        : defaultPaymentPlanGatewayOption
          ? 'La pasarela que elijas enviará el link para autorizar una tarjeta nueva.'
          : 'Conecta una pasarela para enviar el link de autorización.'
      const paymentPlanSavedCardActionDescription = savedCardGatewayLabels.length > 1
        ? `Después eliges una tarjeta guardada en ${savedCardGatewayLabels.join(' o ')}.`
        : savedCardGatewayLabels.length === 1
          ? `Después eliges la tarjeta guardada de ${savedCardGatewayLabels[0]}.`
          : `Este ${customerLowerLabel} todavía no tiene tarjetas guardadas.`
      const authorizationLabel = singlePaymentOptionsStage === 'method'
        ? stripePlanCardSource === 'saved_card'
          ? paymentPlanSavedCardActionDescription
          : paymentPlanNewCardActionDescription
        : paymentOption === 'stripe'
          ? stripeAuthorizationLabel
          : paymentOption === 'conekta'
            ? conektaAuthorizationLabel
            : paymentOption === 'rebill'
              ? rebillAuthorizationLabel
            : highLevelConnected && paymentOption === 'send'
              ? highLevelAuthorizationLabel
              : 'El primer pago con tarjeta funcionará como autorización.'

      return (
        <div className={styles.optionsContent}>
          <div className={styles.summaryCard}>
            <div className={styles.summaryHeader}>
              <div>
                <span>{customerLabel}</span>
                <h3 className={styles.summaryClient}>{invoiceSummary.contactName}</h3>
                {invoiceSummary.contactEmail && (
                  <p className={styles.summaryDetail}>{invoiceSummary.contactEmail}</p>
                )}
              </div>
              <div className={styles.summaryAmountBlock}>
                <span>Total parcializado</span>
                <p className={styles.summaryTotal}>{formatCurrency(invoiceSummary.amount, invoiceSummary.currency)}</p>
              </div>
            </div>
            <div className={styles.summaryBreakdown}>
              {firstPaymentEnabled && (
                <div className={styles.summaryRow}>
                  <span>Primer pago</span>
                  <span>{formatCurrency(firstPaymentAmount, invoiceSummary.currency)}</span>
                </div>
              )}
              <div className={styles.summaryRow}>
                <span>Cobros programados</span>
                <span>{resolvedRemainingInstallments.length} pagos programados</span>
              </div>
              <div className={styles.summaryRow}>
                <span>Autorización</span>
                <span className={styles.summaryNoteValue}>{authorizationLabel}</span>
              </div>
            </div>
          </div>

          <div className={styles.paymentOptions}>
            {showPlanGatewayPicker ? (
              <>
                {stripeConnected && (
                  <button
                    type="button"
                    className={`${styles.optionButton} ${paymentOption === 'stripe' ? styles.optionButtonActive : ''}`}
                    onClick={() => {
                      setPaymentOption('stripe')
                      setStripePlanCardSource('new_card')
                    }}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <PaymentPlatformLogo platform="stripe" size="md" decorative />
                      </div>
                      <div>
                        <p>Stripe</p>
                        <span>{stripeNewCardLabel}</span>
                      </div>
                    </div>
                    {paymentOption === 'stripe' && <Check size={18} className={styles.optionCheck} />}
                  </button>
                )}

                {conektaConnected && (
                  <button
                    type="button"
                    className={`${styles.optionButton} ${paymentOption === 'conekta' ? styles.optionButtonActive : ''}`}
                    onClick={() => {
                      setPaymentOption('conekta')
                      setStripePlanCardSource('new_card')
                    }}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <PaymentPlatformLogo platform="conekta" size="md" decorative />
                      </div>
                      <div>
                        <p>Conekta</p>
                        <span>{conektaNewCardLabel}</span>
                      </div>
                    </div>
                    {paymentOption === 'conekta' && <Check size={18} className={styles.optionCheck} />}
                  </button>
                )}

                {rebillConnected && (
                  <button
                    type="button"
                    className={`${styles.optionButton} ${paymentOption === 'rebill' ? styles.optionButtonActive : ''}`}
                    onClick={() => {
                      setPaymentOption('rebill')
                      setStripePlanCardSource('new_card')
                    }}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <PaymentPlatformLogo platform="rebill" size="md" decorative />
                      </div>
                      <div>
                        <p>Rebill</p>
                        <span>{rebillNewCardLabel}</span>
                      </div>
                    </div>
                    {paymentOption === 'rebill' && <Check size={18} className={styles.optionCheck} />}
                  </button>
                )}

                {highLevelConnected && (
                  <div
                    className={`${styles.optionButton} ${paymentOption === 'send' ? styles.optionButtonActive : ''}`}
                    onClick={() => {
                      setPaymentOption('send')
                      setStripePlanCardSource('new_card')
                    }}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <Send size={18} />
                      </div>
                      <div>
                        <p>HighLevel</p>
                        <span>
                          {(!selectedContact?.email && !selectedContact?.phone)
                            ? 'Sin email ni teléfono'
                            : 'Enviará el link por los canales del contacto.'}
                        </span>
                      </div>
                    </div>

                    {paymentOption === 'send' && (
                      <div className={styles.optionAction}>
                        <Check size={18} className={styles.optionCheck} />
                        <div className={styles.sendMethodSelector} onClick={(e) => e.stopPropagation()}>
                          {sendMethodOptions.length === 0 ? (
                            <div className={styles.noOptionsMessage}>
                              <AlertCircle size={14} />
                              <span>El contacto no tiene email ni teléfono</span>
                            </div>
                          ) : (
                            <CustomSelect
                              value={sendMethod}
                              onValueChange={(value) => setSendMethod(value as SendMethod)}
                              options={sendMethodOptions}
                              portal
                            />
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : showPlanSavedCardPicker ? (
              <>
                {hasStripeSavedCards && (
                  renderSavedCardGatewayRow({
                    platform: 'stripe',
                    label: 'Stripe',
                    description: 'Programará los cobros futuros con Stripe.',
                    value: currentStripePlanPaymentMethodId,
                    options: savedPaymentMethodOptions,
                    active: paymentOption === 'stripe' && stripePlanCardSource === 'saved_card',
                    onSelect: (value) => {
                      setSinglePaymentAction('saved_card')
                      setPaymentOption('stripe')
                      setStripePlanCardSource('saved_card')
                      setSelectedSavedPaymentMethodId(value)
                    }
                  })
                )}

                {hasConektaSavedCards && (
                  renderSavedCardGatewayRow({
                    platform: 'conekta',
                    label: 'Conekta',
                    description: 'Programará los cobros futuros con Conekta.',
                    value: currentConektaPlanPaymentSourceId,
                    options: savedConektaPaymentSourceOptions,
                    active: paymentOption === 'conekta' && stripePlanCardSource === 'saved_card',
                    onSelect: (value) => {
                      setSinglePaymentAction('saved_card')
                      setPaymentOption('conekta')
                      setStripePlanCardSource('saved_card')
                      setSelectedConektaPaymentSourceId(value)
                    }
                  })
                )}

                {hasRebillSavedCards && (
                  renderSavedCardGatewayRow({
                    platform: 'rebill',
                    label: 'Rebill',
                    description: 'Programará los cobros futuros con Rebill.',
                    value: currentRebillPlanPaymentSourceId,
                    options: savedRebillPaymentSourceOptions,
                    active: paymentOption === 'rebill' && stripePlanCardSource === 'saved_card',
                    onSelect: (value) => {
                      setSinglePaymentAction('saved_card')
                      setPaymentOption('rebill')
                      setStripePlanCardSource('saved_card')
                      setSelectedRebillPaymentSourceId(value)
                    }
                  })
                )}
              </>
            ) : showPlanMethodPicker ? (
              <>
                {hasPaymentPlanSavedCards && (
                  <button
                    type="button"
                    className={`${styles.optionButton} ${stripePlanCardSource === 'saved_card' ? styles.optionButtonActive : ''}`}
                    onClick={goToPaymentPlanSavedCardOptions}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <ShieldCheck size={18} />
                      </div>
                      <div>
                        <p>Cobrar tarjeta guardada</p>
                        <span>{paymentPlanSavedCardActionDescription}</span>
                      </div>
                    </div>
                    <ChevronRight size={18} className={styles.optionCheck} />
                  </button>
                )}

                {hasPaymentPlanGateways && (
                  <button
                    type="button"
                    className={`${styles.optionButton} ${stripePlanCardSource === 'new_card' ? styles.optionButtonActive : ''}`}
                    onClick={selectPaymentPlanNewCardAction}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <LinkIcon size={18} />
                      </div>
                      <div>
                        <p>Enviar enlace de pago</p>
                        <span>{paymentPlanNewCardActionDescription}</span>
                      </div>
                    </div>
                    <ChevronRight size={18} className={styles.optionCheck} />
                  </button>
                )}
              </>
            ) : null}
          </div>
        </div>
      )
    }

    const showSavedCardPicker = singlePaymentOptionsStage === 'saved_cards' && singlePaymentAction === 'saved_card'
    const showGatewayPicker = singlePaymentOptionsStage === 'gateway' && singlePaymentAction === 'payment_link'
    const showGatewayConfiguration = singlePaymentOptionsStage === 'gateway_config' && singlePaymentAction === 'payment_link'
    const showManualPaymentFields = singlePaymentOptionsStage === 'method' && singlePaymentAction === 'manual' && paymentOption === 'manual'
    const showConektaSavedCardChargeChoice = showSavedCardPicker &&
      paymentOption === 'conekta_saved_card' &&
      conektaSavedCardGatewayConfirmed
    const showSavedCardGatewayOptions = showSavedCardPicker && !showConektaSavedCardChargeChoice
    const showPrimaryPaymentOptions = !showManualPaymentFields && (!showSavedCardPicker || showSavedCardGatewayOptions)
    const showInstallmentModeChoice = isSinglePaymentInstallmentContext &&
      installmentChargeMode === 'single' &&
      (paymentOption !== 'conekta_saved_card' || showConektaSavedCardChargeChoice)
    const showStripeInstallmentPanel = showGatewayConfiguration &&
      paymentOption === 'stripe' &&
      installmentChargeMode === 'installments'
    const showMercadoPagoInstallmentControls = showGatewayConfiguration &&
      paymentOption === 'mercadopago' &&
      installmentChargeMode === 'installments'
    const showClipCheckoutPanel = showGatewayConfiguration && paymentOption === 'clip'
    const showRebillCheckoutPanel = showGatewayConfiguration && paymentOption === 'rebill'
    const showConektaInstallmentControls = (
      showGatewayConfiguration && paymentOption === 'conekta'
    ) || (
      showConektaSavedCardChargeChoice
    )
    const showConektaInstallmentPanel = showConektaInstallmentControls && installmentChargeMode === 'installments'
    const installmentProviderLabel = paymentOption === 'mercadopago'
      ? 'Mercado Pago'
      : paymentOption === 'stripe'
        ? 'Stripe'
        : paymentOption === 'clip'
          ? 'CLIP'
          : paymentOption === 'rebill'
            ? 'Rebill'
            : 'Conekta'
    const installmentModeIsSavedCard = paymentOption === 'conekta_saved_card'
    const installmentModeMsiAvailable = paymentOption === 'stripe'
      ? stripeInstallmentsAvailable
      : paymentOption === 'clip'
        ? clipInstallmentsAvailable
        : paymentOption === 'rebill'
          ? true
        : paymentOption === 'mercadopago' ||
          paymentOption === 'conekta' ||
          paymentOption === 'conekta_saved_card'
    const installmentModeMsiDescription = paymentOption === 'stripe'
      ? !stripeInstallmentsCurrencyAvailable
        ? 'Stripe sólo ofrece meses sin intereses en MXN.'
        : !stripeInstallmentsAmountAvailable
          ? `Disponible desde ${formatCurrency(STRIPE_INSTALLMENT_MIN_AMOUNT, 'MXN')}.`
          : `Configura hasta cuántos meses podrá elegir el ${customerLowerLabel} en el link.`
      : paymentOption === 'clip'
        ? !clipCurrencyAvailable
          ? 'CLIP sólo ofrece meses sin intereses en MXN.'
          : !clipInstallmentsAmountAvailable
            ? `Disponible desde ${formatCurrency(CLIP_INSTALLMENT_MIN_AMOUNT, 'MXN')}.`
            : 'CLIP mostrará los planes disponibles dentro del formulario seguro.'
      : paymentOption === 'rebill'
        ? 'Guarda el máximo deseado; Rebill mostrará MSI solo si la cuenta y la tarjeta califican.'
      : paymentOption === 'mercadopago'
        ? `Configura cuántos meses podrá elegir el ${customerLowerLabel} en el link.`
        : 'Consulta mínimos y selecciona un plazo disponible.'
    const handleOpenInstallmentConfiguration = () => {
      if (paymentOption === 'stripe') {
        openStripeInstallmentConfiguration()
        return
      }

      if (paymentOption === 'mercadopago') {
        openMercadoPagoInstallmentConfiguration()
        return
      }

      if (paymentOption === 'clip') {
        openClipInstallmentConfiguration()
        return
      }

      if (paymentOption === 'rebill') {
        openRebillInstallmentConfiguration()
        return
      }

      openConektaInstallmentConfiguration()
    }
    const savedCardActionDescription = savedCardGatewayLabels.length > 1
      ? `Elige la tarjeta guardada en ${savedCardGatewayLabels.join(' o ')}.`
      : savedCardGatewayLabels.length === 1
        ? `Elige la tarjeta guardada de ${savedCardGatewayLabels[0]}.`
        : `Este ${customerLowerLabel} todavía no tiene tarjetas guardadas.`
    const paymentLinkActionDescription = hasMultiplePaymentLinkGateways
      ? `Después eliges pasarela: ${paymentLinkGatewayLabels.join(', ')}.`
      : defaultPaymentLinkOption === 'stripe'
        ? 'Elige contado o meses sin intereses antes de crear el enlace.'
        : defaultPaymentLinkOption === 'conekta'
          ? 'Configura meses sin intereses antes de crear el enlace.'
          : defaultPaymentLinkOption === 'mercadopago'
            ? 'Configura meses sin intereses antes de crear el enlace.'
            : defaultPaymentLinkOption === 'clip'
              ? 'Elige contado o meses sin intereses antes de crear el enlace.'
              : defaultPaymentLinkOption === 'rebill'
                ? 'Elige contado o meses sin intereses antes de crear el enlace.'
              : defaultPaymentLinkOption === 'send'
                ? `Usa la integración conectada para enviar el enlace al ${customerLowerLabel}.`
                : 'Conecta una pasarela para enviar enlaces de pago.'
    const renderManualTransferInfo = () => (
      <div className={styles.manualTransferInfo}>
        <div className={styles.manualTransferHeader}>
          <div className={styles.manualTransferIcon}>
            <LinkIcon size={18} />
          </div>
          <div className={styles.manualTransferText}>
            <p>Enlace para transferencias</p>
            <span>Comparte este enlace con el {customerLowerLabel} para completar el depósito.</span>
          </div>
        </div>
        {transferInfoUrl ? (
          <div className={styles.manualTransferActions}>
            <div className={styles.manualTransferUrl}>{transferInfoUrl}</div>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCopyTransferUrl}
            >
              Copiar enlace
            </Button>
          </div>
        ) : (
          <p className={styles.manualTransferHint}>
            Configura la URL en Ajustes &gt; Pagos para mostrarla aquí.
          </p>
        )}
      </div>
    )
    const renderInstallmentModeChoice = () => (
      <div className={styles.paymentOptions}>
        <button
          type="button"
          className={`${styles.optionButton} ${installmentChargeMode === 'single' ? styles.optionButtonActive : ''}`}
          onClick={resetInstallmentChargeMode}
        >
          <div className={styles.optionInfo}>
            <div className={styles.optionIcon}>
              <DollarSign size={18} />
            </div>
            <div>
              <p>Cobro único</p>
              <span>
                {installmentModeIsSavedCard
                  ? 'Cobra la tarjeta seleccionada en una sola exhibición.'
                  : `Crea el link de ${installmentProviderLabel} para pago de contado.`}
              </span>
            </div>
          </div>
          {installmentChargeMode === 'single' && <Check size={18} className={styles.optionCheck} />}
        </button>

        <button
          type="button"
          className={styles.optionButton}
          onClick={handleOpenInstallmentConfiguration}
          disabled={!installmentModeMsiAvailable}
        >
          <div className={styles.optionInfo}>
            <div className={styles.optionIcon}>
              <Percent size={18} />
            </div>
            <div>
              <p>Meses sin intereses</p>
              <span>{installmentModeMsiDescription}</span>
            </div>
          </div>
          <ChevronRight size={18} className={styles.optionCheck} />
        </button>
      </div>
    )

    return (
      <div className={styles.optionsContent}>
        <div className={styles.summaryCard}>
          <div className={styles.summaryHeader}>
            <div>
              <span>{customerLabel}</span>
              <h3 className={styles.summaryClient}>{invoiceSummary.contactName}</h3>
              {invoiceSummary.contactEmail && (
                <p className={styles.summaryDetail}>{invoiceSummary.contactEmail}</p>
              )}
            </div>
            <div className={styles.summaryAmountBlock}>
              <span>Total a cobrar</span>
              <p className={styles.summaryTotal}>{formatCurrency(invoiceSummary.amount, invoiceSummary.currency)}</p>
            </div>
          </div>
          {invoiceSummary.includesTax ? (
            <div className={styles.summaryBreakdown}>
              <div className={styles.summaryRow}>
                <span>Subtotal</span>
                <span>{formatCurrency(invoiceSummary.subtotal, invoiceSummary.currency)}</span>
              </div>
              <div className={styles.summaryRow}>
                <span>{invoiceSummary.taxName} ({invoiceSummary.taxRate}%)</span>
                <span className={styles.summaryTax}>{invoiceSummary.taxCalculationMode === 'exclusive' ? '+ ' : ''}{formatCurrency(invoiceSummary.taxAmount, invoiceSummary.currency)}</span>
              </div>
            </div>
          ) : (
            <p className={styles.summaryDetail}>Este cobro no incluye impuestos</p>
          )}
          {invoiceSummary.description && (
            <div className={styles.summaryDescription}>
              <span>Concepto</span>
              <p>{invoiceSummary.description}</p>
            </div>
          )}
        </div>

        {!showGatewayConfiguration && showPrimaryPaymentOptions && (
          <div className={styles.paymentOptions}>
            {showGatewayPicker ? (
              <>
                {stripeConnected && (
                  <button
                    type="button"
                    className={`${styles.optionButton} ${paymentOption === 'stripe' ? styles.optionButtonActive : ''}`}
                    onClick={() => {
                      resetInstallmentChargeMode()
                      setPaymentOption('stripe')
                    }}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <PaymentPlatformLogo platform="stripe" size="md" decorative />
                      </div>
                      <div>
                        <p>Stripe</p>
                        <span>Genera tu página pública con campo seguro de tarjeta y meses sin intereses si aplica.</span>
                      </div>
                    </div>
                    {paymentOption === 'stripe' && <Check size={18} className={styles.optionCheck} />}
                  </button>
                )}

                {conektaConnected && (
                  <button
                    type="button"
                    className={`${styles.optionButton} ${paymentOption === 'conekta' ? styles.optionButtonActive : ''}`}
                    onClick={() => {
                      resetInstallmentChargeMode()
                      setPaymentOption('conekta')
                    }}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <PaymentPlatformLogo platform="conekta" size="md" decorative />
                      </div>
                      <div>
                        <p>Conekta</p>
                        <span>Genera tu página pública con tokenizador seguro y opción de meses sin intereses.</span>
                      </div>
                    </div>
                    {paymentOption === 'conekta' && <Check size={18} className={styles.optionCheck} />}
                  </button>
                )}

                {mercadoPagoConnected && (
                  <button
                    type="button"
                    className={`${styles.optionButton} ${paymentOption === 'mercadopago' ? styles.optionButtonActive : ''}`}
                    onClick={() => {
                      resetInstallmentChargeMode()
                      setPaymentOption('mercadopago')
                    }}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <PaymentPlatformLogo platform="mercadopago" size="md" decorative />
                      </div>
                      <div>
                        <p>Mercado Pago</p>
                        <span>Genera el enlace y después configura si tendrá meses sin intereses.</span>
                      </div>
                    </div>
                    {paymentOption === 'mercadopago' && <Check size={18} className={styles.optionCheck} />}
                  </button>
                )}

                {clipConnected && (
                  <button
                    type="button"
                    className={`${styles.optionButton} ${paymentOption === 'clip' ? styles.optionButtonActive : ''}`}
                    onClick={() => {
                      resetInstallmentChargeMode()
                      setPaymentOption('clip')
                    }}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <PaymentPlatformLogo platform="clip" size="md" decorative />
                      </div>
                      <div>
                        <p>CLIP</p>
                        <span>Genera una página pública con Checkout Transparente y MSI si aplica.</span>
                      </div>
                    </div>
                    {paymentOption === 'clip' && <Check size={18} className={styles.optionCheck} />}
                  </button>
                )}

                {rebillConnected && (
                  <button
                    type="button"
                    className={`${styles.optionButton} ${paymentOption === 'rebill' ? styles.optionButtonActive : ''}`}
                    onClick={() => {
                      resetInstallmentChargeMode()
                      setPaymentOption('rebill')
                    }}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <PaymentPlatformLogo platform="rebill" size="md" decorative />
                      </div>
                      <div>
                        <p>Rebill</p>
                        <span>Genera una página pública con checkout seguro y opción de meses sin intereses si aplica.</span>
                      </div>
                    </div>
                    {paymentOption === 'rebill' && <Check size={18} className={styles.optionCheck} />}
                  </button>
                )}

                {highLevelConnected && (
                  <div
                    className={`${styles.optionButton} ${paymentOption === 'send' ? styles.optionButtonActive : ''}`}
                    onClick={() => {
                      resetInstallmentChargeMode()
                      setPaymentOption('send')
                    }}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <Send size={18} />
                      </div>
                      <div>
                        <p>HighLevel</p>
                        <span>
                          {(!selectedContact?.email && !selectedContact?.phone) ? (
                            <span style={{ color: 'var(--color-status-error)' }}>Sin email ni teléfono</span>
                          ) : (
                            `Envía automáticamente al ${customerLowerLabel}.`
                          )}
                        </span>
                      </div>
                    </div>
                    {paymentOption === 'send' && (
                      <div className={styles.optionAction}>
                        <Check size={18} className={styles.optionCheck} />
                        <div className={styles.sendMethodSelector} onClick={(e) => e.stopPropagation()}>
                          {sendMethodOptions.length === 0 ? (
                            <div className={styles.noOptionsMessage}>
                              <AlertCircle size={14} />
                              <span>El contacto no tiene email ni teléfono</span>
                            </div>
                          ) : (
                            <CustomSelect
                              value={sendMethod}
                              onValueChange={(value) => setSendMethod(value as SendMethod)}
                              options={sendMethodOptions}
                              portal
                            />
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : showSavedCardPicker ? (
              <>
                {hasStripeSavedCards && (
                  renderSavedCardGatewayRow({
                    platform: 'stripe',
                    label: 'Stripe',
                    description: 'Se cobrará inmediatamente con Stripe.',
                    value: selectedSavedPaymentMethodId,
                    options: savedPaymentMethodOptions,
                    active: paymentOption === 'stripe_saved_card',
                    onSelect: (value) => {
                      resetInstallmentChargeMode()
                      setConektaSavedCardGatewayConfirmed(false)
                      setSinglePaymentAction('saved_card')
                      setPaymentOption('stripe_saved_card')
                      setSelectedSavedPaymentMethodId(value)
                    }
                  })
                )}

                {hasConektaSavedCards && (
                  renderSavedCardGatewayRow({
                    platform: 'conekta',
                    label: 'Conekta',
                    description: conektaSavedCardDescription,
                    value: selectedConektaPaymentSourceId,
                    options: savedConektaPaymentSourceOptions,
                    active: paymentOption === 'conekta_saved_card',
                    onSelect: (value) => {
                      if (paymentOption !== 'conekta_saved_card') {
                        resetInstallmentChargeMode()
                      }
                      setSinglePaymentAction('saved_card')
                      setPaymentOption('conekta_saved_card')
                      setConektaSavedCardGatewayConfirmed(true)
                      setSelectedConektaPaymentSourceId(value)
                    }
                  })
                )}

                {hasRebillSavedCards && (
                  renderSavedCardGatewayRow({
                    platform: 'rebill',
                    label: 'Rebill',
                    description: 'Se cobrará inmediatamente con Rebill.',
                    value: selectedRebillPaymentSourceId,
                    options: savedRebillPaymentSourceOptions,
                    active: paymentOption === 'rebill_saved_card',
                    onSelect: (value) => {
                      resetInstallmentChargeMode()
                      setConektaSavedCardGatewayConfirmed(false)
                      setSinglePaymentAction('saved_card')
                      setPaymentOption('rebill_saved_card')
                      setSelectedRebillPaymentSourceId(value)
                    }
                  })
                )}
              </>
            ) : (
              <>
                {hasSavedCards && (
                  <button
                    type="button"
                    className={`${styles.optionButton} ${singlePaymentAction === 'saved_card' ? styles.optionButtonActive : ''}`}
                    onClick={goToSavedCardOptions}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <ShieldCheck size={18} />
                      </div>
                      <div>
                        <p>Cobrar tarjeta guardada</p>
                        <span>{savedCardActionDescription}</span>
                      </div>
                    </div>
                    <ChevronRight size={18} className={styles.optionCheck} />
                  </button>
                )}

                {hasPaymentLinkGateways && (
                  <button
                    type="button"
                    className={`${styles.optionButton} ${singlePaymentAction === 'payment_link' ? styles.optionButtonActive : ''}`}
                    onClick={selectSinglePaymentLinkAction}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <LinkIcon size={18} />
                      </div>
                      <div>
                        <p>Enviar enlace de pago</p>
                        <span>{paymentLinkActionDescription}</span>
                      </div>
                    </div>
                    {hasMultiplePaymentLinkGateways || paymentLinkOptionNeedsConfiguration(defaultPaymentLinkOption) ? (
                      <ChevronRight size={18} className={styles.optionCheck} />
                    ) : (
                      singlePaymentAction === 'payment_link' && <Check size={18} className={styles.optionCheck} />
                    )}
                  </button>
                )}

                <button
                  type="button"
                  className={`${styles.optionButton} ${singlePaymentAction === 'manual' && paymentOption === 'manual' ? styles.optionButtonActive : ''}`}
                  onClick={() => {
                    resetInstallmentChargeMode()
                    setConektaSavedCardGatewayConfirmed(false)
                    setSinglePaymentAction('manual')
                    setSinglePaymentOptionsStage('method')
                    setPaymentOption('manual')
                  }}
                >
                  <div className={styles.optionInfo}>
                    <div className={styles.optionIcon}>
                      <DollarSign size={18} />
                    </div>
                    <div>
                      <p>Registrar pago manual</p>
                      <span>
                        {highLevelConnected
                          ? 'Marca el invoice como pagado (efectivo, transferencia, etc.)'
                          : 'Registra el pago en Ristak (efectivo, transferencia, etc.)'}
                      </span>
                    </div>
                  </div>
                  {singlePaymentAction === 'manual' && paymentOption === 'manual' && <Check size={18} className={styles.optionCheck} />}
                </button>
              </>
            )}
          </div>
        )}

        {showInstallmentModeChoice && renderInstallmentModeChoice()}

        {showClipCheckoutPanel && invoiceSummary && (
          <div className={styles.mercadoPagoInstallmentsPanel}>
            <div className={styles.mercadoPagoInstallmentsHeader}>
              <div>
                <span>CLIP</span>
                <p>{clipMsiEnabled ? 'Meses sin intereses' : 'Checkout Transparente'}</p>
              </div>
              <strong>{clipCurrencyAvailable ? (clipMsiEnabled ? clipInstallmentPaymentLabel : 'MXN') : 'Moneda no soportada'}</strong>
            </div>

            <div className={styles.mercadoPagoInstallmentTotals}>
              <div>
                <span>{customerLabel} paga</span>
                <strong>{formatCurrency(invoiceSummary.amount, invoiceSummary.currency)}</strong>
              </div>
              <div>
                <span>Forma de pago</span>
                <strong>{clipMsiEnabled ? 'CLIP decide planes' : 'Pago de contado'}</strong>
              </div>
              <div>
                <span>Datos requeridos</span>
                <strong>{clipContactReady ? 'Email y teléfono listos' : 'Falta email o teléfono'}</strong>
              </div>
              <div>
                <span>Ristak registra</span>
                <strong>Al confirmar CLIP</strong>
              </div>
            </div>

            <p className={styles.mercadoPagoInstallmentsNote}>
              {clipMsiEnabled
                ? 'CLIP mostrará meses sin intereses dentro del formulario seguro si la cuenta, el monto y la tarjeta califican. Los plazos disponibles se configuran en el Dashboard de CLIP.'
                : `CLIP procesa el pago con tarjeta en campos seguros y Ristak actualiza el cobro cuando CLIP lo confirma. Esta pasarela solo está disponible para cobros en MXN y requiere email y teléfono del ${customerLowerLabel}.`}
            </p>
          </div>
        )}

        {showRebillCheckoutPanel && invoiceSummary && (
          <div className={styles.mercadoPagoInstallmentsPanel}>
            <div className={`${styles.mercadoPagoInstallmentsHeader} ${styles.conektaInstallmentsHeader}`}>
              <div className={styles.conektaInstallmentIntro}>
                <span>Rebill</span>
                <p>{rebillMsiEnabled ? 'Meses sin intereses' : 'Checkout seguro'}</p>
                {rebillMsiEnabled && (
                  <div className={styles.conektaInstallmentSelectField}>
                    <label>Máximo de meses</label>
                    {renderPaymentSelect({
                      value: rebillInstallmentChoice,
                      onChange: (value) => setRebillInstallmentChoice(value as RebillInstallmentChoice),
                      options: REBILL_INSTALLMENT_OPTIONS,
                      title: 'Máximo de meses'
                    })}
                  </div>
                )}
              </div>
              <strong>{rebillMsiEnabled ? rebillInstallmentPaymentLabel : invoiceSummary.currency}</strong>
            </div>

            <div className={styles.mercadoPagoInstallmentTotals}>
              <div>
                <span>{customerLabel} paga</span>
                <strong>{formatCurrency(invoiceSummary.amount, invoiceSummary.currency)}</strong>
              </div>
              <div>
                <span>Forma de pago</span>
                <strong>{rebillInstallmentPaymentLabel}</strong>
              </div>
              <div>
                <span>{rebillMsiEnabled ? 'Referencia mensual' : 'Meses'}</span>
                <strong>
                  {rebillMsiEnabled
                    ? formatCurrency(rebillInstallmentEstimate, invoiceSummary.currency)
                    : 'No solicitado'}
                </strong>
              </div>
              <div>
                <span>Ristak registra</span>
                <strong>Al confirmar Rebill</strong>
              </div>
            </div>

            <p className={styles.mercadoPagoInstallmentsNote}>
              {rebillMsiEnabled
                ? `Ristak guardará la preferencia hasta ${rebillInstallmentLimit} meses. El checkout de Rebill mostrará MSI solo cuando la cuenta, país, moneda, monto y tarjeta califiquen.`
                : 'Ristak creará el link como pago de contado. Rebill procesa la tarjeta y Ristak confirma el paymentId con backend antes de marcar el cobro como pagado.'}
            </p>
          </div>
        )}

        {showStripeInstallmentPanel && invoiceSummary && (
          <div className={styles.mercadoPagoInstallmentsPanel}>
            <div className={`${styles.mercadoPagoInstallmentsHeader} ${styles.conektaInstallmentsHeader}`}>
              <div className={styles.conektaInstallmentIntro}>
                <span>Stripe</span>
                <p>Meses sin intereses</p>
                <div className={styles.conektaInstallmentSelectField}>
                  <label>Máximo de meses</label>
                  {renderPaymentSelect({
                    value: stripeInstallmentChoice,
                    onChange: (value) => setStripeInstallmentChoice(value as StripeInstallmentChoice),
                    options: STRIPE_INSTALLMENT_OPTIONS,
                    title: 'Máximo de meses'
                  })}
                </div>
              </div>
              <strong>{stripeInstallmentPaymentLabel}</strong>
            </div>

            <div className={styles.mercadoPagoInstallmentTotals}>
              <div>
                <span>{customerLabel} paga</span>
                <strong>{formatCurrency(invoiceSummary.amount, invoiceSummary.currency)}</strong>
              </div>
              <div>
                <span>Referencia mensual</span>
                <strong>{formatCurrency(stripeInstallmentEstimate, invoiceSummary.currency)} x {stripeInstallmentLimit}</strong>
              </div>
              <div>
                <span>Ristak registra</span>
                <strong>{formatCurrency(invoiceSummary.amount, invoiceSummary.currency)}</strong>
              </div>
            </div>

            <p className={styles.mercadoPagoInstallmentsNote}>
              Ristak mostrará sólo los plazos que Stripe confirme para la tarjeta del {customerLowerLabel} y nunca más de {stripeInstallmentLimit} meses. La cuenta, el cobro en MXN y el banco emisor todavía deben ser compatibles.
            </p>
          </div>
        )}

        {showConektaInstallmentPanel && invoiceSummary && (
          <div className={styles.mercadoPagoInstallmentsPanel}>
            <div className={`${styles.mercadoPagoInstallmentsHeader} ${styles.conektaInstallmentsHeader}`}>
              <div className={styles.conektaInstallmentIntro}>
                <span>Conekta</span>
                <p>Meses sin intereses</p>
                <div className={styles.conektaInstallmentSelectField}>
                  <label>Máximo de meses</label>
                  {renderPaymentSelect({
                    value: conektaInstallmentChoice,
                    onChange: (value) => setConektaInstallmentChoice(value as ConektaInstallmentChoice),
                    options: conektaInstallmentOptions,
                    title: 'Máximo de meses',
                    placeholder: 'Selecciona un plazo',
                    includeDisabledOptions: true,
                    dropdownMinWidth: 420
                  })}
                </div>
              </div>

              <div className={styles.conektaInstallmentSupport}>
                <strong>{conektaInstallmentPaymentLabel}</strong>
                <div className={styles.conektaInstallmentMinimums} aria-label="Montos mínimos de Conekta">
                  <span>Montos mínimos</span>
                  <div className={styles.conektaMinimumList}>
                    {CONEKTA_INSTALLMENT_TERMS.map((term) => {
                      const available = invoiceSummary.amount >= term.minAmount

                      return (
                        <div
                          key={term.value}
                          className={styles.conektaMinimumRow}
                          data-available={available ? 'true' : 'false'}
                        >
                          <span>{getConektaInstallmentTermLabel(term)}</span>
                          <strong>{formatConektaInstallmentMinimum(term.minAmount, invoiceSummary.currency)}</strong>
                        </div>
                      )
                    })}
                  </div>
                  {!conektaInstallmentsAvailable && (
                    <p className={styles.conektaInstallmentHelp}>
                      Sube el monto del cobro para habilitar meses sin intereses.
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className={styles.mercadoPagoInstallmentTotals}>
              <div>
                <span>{customerLabel} paga</span>
                <strong>{formatCurrency(invoiceSummary.amount, invoiceSummary.currency)}</strong>
              </div>
              <div>
                <span>{conektaInstallmentEnabled ? 'Referencia mensual' : 'Forma de pago'}</span>
                <strong>
                  {conektaInstallmentEnabled
                    ? `${formatCurrency(conektaInstallmentEstimate, invoiceSummary.currency)} x ${conektaInstallmentLimit}`
                    : 'Una sola exhibición'}
                </strong>
              </div>
              <div>
                <span>Ristak registra</span>
                <strong>{formatCurrency(invoiceSummary.amount, invoiceSummary.currency)}</strong>
              </div>
            </div>

            <p className={styles.mercadoPagoInstallmentsNote}>
              Conekta valida la disponibilidad con el banco emisor. Ristak registra el total completo cuando Conekta confirma el pago.
            </p>
          </div>
        )}

        {showMercadoPagoInstallmentControls && invoiceSummary && (
          <div className={styles.mercadoPagoInstallmentsPanel}>
            <div className={styles.mercadoPagoInstallmentsHeader}>
              <div>
                <span>Mercado Pago</span>
                <p>Meses sin intereses</p>
              </div>
              <strong>{mercadoPagoInstallmentPaymentLabel}</strong>
            </div>

            <div className={styles.mercadoPagoInstallmentsGrid}>
              <div className={styles.manualField}>
                <label>Máximo de meses</label>
                {renderPaymentSelect({
                  value: mercadoPagoInstallmentChoice,
                  onChange: (value) => setMercadoPagoInstallmentChoice(value as MercadoPagoInstallmentChoice),
                  options: MERCADOPAGO_INSTALLMENT_OPTIONS.filter(option => option.value !== 'none'),
                  title: 'Máximo de meses'
                })}
              </div>
            </div>

            <div className={styles.mercadoPagoInstallmentTotals}>
              <div>
                <span>{customerLabel} paga</span>
                <strong>{formatCurrency(invoiceSummary.amount, invoiceSummary.currency)}</strong>
              </div>
              <div>
                <span>{mercadoPagoInstallmentEnabled ? 'Referencia mensual' : 'Forma de pago'}</span>
                <strong>
                  {mercadoPagoInstallmentEnabled
                    ? `${formatCurrency(mercadoPagoInstallmentEstimate, invoiceSummary.currency)} x ${mercadoPagoInstallmentLimit}`
                    : 'Una sola exhibición'}
                </strong>
              </div>
              <div>
                <span>Ristak registra</span>
                <strong>{formatCurrency(invoiceSummary.amount, invoiceSummary.currency)}</strong>
              </div>
            </div>

            <p className={styles.mercadoPagoInstallmentsNote}>
              Mercado Pago solo mostrará meses disponibles para la tarjeta del {customerLowerLabel}. Ristak registra el total completo cuando el pago se confirma por webhook.
            </p>
          </div>
        )}

        {showManualPaymentFields && (
          <div className={styles.manualFields}>
            <div className={styles.manualGrid}>
              <div className={styles.manualField}>
                <label>Fecha de pago</label>
                <PhoneDateField
                  value={manualPaymentData.paymentDate}
                  onChange={(value) => setManualPaymentData({ ...manualPaymentData, paymentDate: value })}
                  title="Fecha de pago"
                  buttonClassName={styles.phoneDateButton}
                  inlineOnWide
                />
              </div>
              <div className={styles.manualField}>
                <label>Método de pago</label>
                {renderPaymentSelect({
                  value: manualPaymentData.paymentMethod,
                  onChange: (value) => setManualPaymentData({ ...manualPaymentData, paymentMethod: value }),
                  options: MANUAL_PAYMENT_METHOD_OPTIONS,
                  title: 'Método de pago'
                })}
              </div>
            </div>
            {manualPaymentData.paymentMethod === 'bank_transfer' && transferInfoUrl && renderManualTransferInfo()}
            <div className={styles.manualGrid}>
              <div className={styles.manualField}>
                <label>Referencia (opcional)</label>
                <input
                  type="text"
                  value={manualPaymentData.reference}
                  onChange={(e) => setManualPaymentData({ ...manualPaymentData, reference: e.target.value })}
                  className={styles.input}
                  placeholder="Número de transferencia, cheque, etc."
                />
              </div>
              <div className={styles.manualField}>
                <label>Notas internas</label>
                <textarea
                  value={manualPaymentData.notes}
                  onChange={(e) => setManualPaymentData({ ...manualPaymentData, notes: e.target.value })}
                  className={styles.textArea}
                  placeholder="Notas adicionales para este pago manual"
                />
              </div>
            </div>
            {manualPaymentData.paymentMethod === 'bank_transfer' && !transferInfoUrl && renderManualTransferInfo()}
          </div>
        )}
      </div>
    )
  }

  const renderProcessing = () => (
    <div className={styles.processing}>
      <Loader2 size={48} className={styles.processingIcon} />
      <p className={styles.processingText}>Procesando...</p>
      <p className={styles.processingHint}>Por favor espera mientras registramos el pago.</p>
    </div>
  )

  const renderPaymentLinkReady = () => {
    if (!createdPaymentLink) {
      return renderProcessing()
    }

    return (
      <div className={styles.paymentLinkReady}>
        <PaymentLinkReadyPanel link={createdPaymentLink} businessName={businessName} />
      </div>
    )
  }

  const renderFooter = () => {
    if (step === 'processing') {
      return null
    }

    if (step === 'link_ready') {
      return (
        <div className={styles.footer} data-modal-footer="">
          <Button
            variant="primary"
            onClick={onClose}
          >
            Listo
          </Button>
        </div>
      )
    }

    if (step === 'options') {
      const needsGatewayChoice = activePaymentMode !== 'partial' &&
        singlePaymentOptionsStage === 'method' &&
        singlePaymentAction === 'payment_link' &&
        hasMultiplePaymentLinkGateways
      const needsGatewayConfiguration = activePaymentMode !== 'partial' &&
        singlePaymentAction === 'payment_link' &&
        singlePaymentOptionsStage !== 'gateway_config' &&
        paymentLinkOptionNeedsConfiguration(paymentOption)
      const needsPaymentPlanMethodChoice = activePaymentMode === 'partial' &&
        singlePaymentOptionsStage === 'method'
      const lacksPaymentPlanGateway = activePaymentMode === 'partial' &&
        stripePlanCardSource === 'new_card' &&
        !hasPaymentPlanGateways
      const lacksPaymentPlanSavedCards = activePaymentMode === 'partial' &&
        stripePlanCardSource === 'saved_card' &&
        !hasPaymentPlanSavedCards
      const requiresDeliveryChannel = paymentOption === 'send' &&
        !needsGatewayChoice &&
        !needsPaymentPlanMethodChoice
      const lacksDeliveryChannel = requiresDeliveryChannel && !selectedContact?.email && !selectedContact?.phone
      const lacksSavedCard = (
        (paymentOption === 'stripe_saved_card' && !selectedSavedPaymentMethodId) ||
        (paymentOption === 'conekta_saved_card' && !selectedConektaPaymentSourceId) ||
        (paymentOption === 'rebill_saved_card' && !selectedRebillPaymentSourceId)
      )
      const lacksStripePlanSavedCard = paymentOption === 'stripe' &&
        activePaymentMode === 'partial' &&
        stripePlanCardSource === 'saved_card' &&
        !stripePlanSavedPaymentMethod
      const lacksStripePlanAuthorization = paymentOption === 'stripe' &&
        activePaymentMode === 'partial' &&
        !stripePlanCanBeAuthorized
      const lacksConektaPlanSavedCard = paymentOption === 'conekta' &&
        activePaymentMode === 'partial' &&
        stripePlanCardSource === 'saved_card' &&
        !conektaPlanSavedPaymentSource
      const lacksConektaPlanAuthorization = paymentOption === 'conekta' &&
        activePaymentMode === 'partial' &&
        !conektaPlanCanBeAuthorized
      const lacksRebillPlanSavedCard = paymentOption === 'rebill' &&
        activePaymentMode === 'partial' &&
        stripePlanCardSource === 'saved_card' &&
        !rebillPlanSavedPaymentSource
      const lacksRebillPlanAuthorization = paymentOption === 'rebill' &&
        activePaymentMode === 'partial' &&
        !rebillPlanCanBeAuthorized
      const validatingClipGateway = paymentOption === 'clip' && singlePaymentOptionsStage === 'gateway_config'
      const lacksClipContact = validatingClipGateway && !clipContactReady
      const lacksClipCurrency = validatingClipGateway && !clipCurrencyAvailable
      const stripePlanWillRegisterOfflineFirstPayment = firstPaymentEnabled && isOfflineFirstPaymentMethod(firstPaymentMethod)
      const confirmLabel = needsPaymentPlanMethodChoice
        ? 'Continuar'
        : activePaymentMode === 'partial' && singlePaymentOptionsStage === 'saved_cards'
        ? 'Programar con tarjeta'
        : activePaymentMode === 'partial' && singlePaymentOptionsStage === 'gateway'
          ? paymentOption === 'send'
            ? 'Crear y enviar enlace'
            : paymentOption === 'rebill'
              ? 'Crear plan Rebill'
            : stripePlanWillRegisterOfflineFirstPayment
              ? 'Registrar pago y enviar enlace de domiciliación'
              : 'Crear link de domiciliación'
        : needsGatewayChoice
          ? 'Continuar'
        : singlePaymentOptionsStage === 'gateway'
          ? 'Continuar'
        : paymentOption === 'conekta_saved_card' && conektaMsiEnabled
        ? `Cobrar a ${conektaInstallmentLimit} MSI`
        : paymentOption === 'stripe_saved_card' || paymentOption === 'conekta_saved_card' || paymentOption === 'rebill_saved_card'
          ? 'Cobrar tarjeta'
        : paymentOption === 'rebill' && activePaymentMode === 'partial'
          ? 'Crear plan Rebill'
        : (paymentOption === 'stripe' || paymentOption === 'conekta') && activePaymentMode === 'partial'
          ? stripePlanCardSource === 'saved_card'
            ? 'Programar con tarjeta'
            : stripePlanWillRegisterOfflineFirstPayment
              ? 'Registrar pago y enviar enlace de domiciliación'
              : 'Crear link de domiciliación'
        : paymentOption === 'stripe'
        ? 'Crear link Stripe'
        : paymentOption === 'conekta'
          ? 'Crear link Conekta'
        : paymentOption === 'mercadopago'
          ? 'Crear link Mercado Pago'
        : paymentOption === 'clip'
          ? 'Crear link CLIP'
        : paymentOption === 'rebill'
          ? (rebillMsiEnabled ? `Crear link Rebill hasta ${rebillInstallmentLimit} meses` : 'Crear link Rebill')
        : paymentOption === 'send'
          ? activePaymentMode === 'partial' ? 'Crear y enviar enlace' : 'Enviar enlace'
          : 'Registrar pago'

      return (
        <div className={styles.footer} data-modal-footer="">
          {!isEmbedded && (
            <Button
              variant="secondary"
              onClick={returnToPreviousPaymentOptionsStage}
              disabled={loading}
            >
              Regresar
            </Button>
          )}
          <div className={styles.confirmButtonWrapper}>
            <Button
              variant="primary"
              onClick={() => {
                if (needsPaymentPlanMethodChoice) {
                  if (stripePlanCardSource === 'saved_card') {
                    if (defaultPaymentPlanSavedCardOption) {
                      setPaymentOption(defaultPaymentPlanSavedCardOption)
                    }
                    setSinglePaymentOptionsStage('saved_cards')
                    return
                  }

                  if (defaultPaymentPlanGatewayOption) {
                    setPaymentOption(defaultPaymentPlanGatewayOption)
                  }
                  setSinglePaymentOptionsStage(hasMultiplePaymentPlanGateways ? 'gateway' : 'confirm')
                  return
                }
                if (needsGatewayChoice) {
                  setSinglePaymentOptionsStage('gateway')
                  return
                }
                if (needsGatewayConfiguration) {
                  setSinglePaymentOptionsStage('gateway_config')
                  return
                }
                handleConfirm()
              }}
              disabled={
                loading ||
                lacksPaymentPlanGateway ||
                lacksPaymentPlanSavedCards ||
                lacksDeliveryChannel ||
                lacksSavedCard ||
                lacksStripePlanSavedCard ||
                lacksStripePlanAuthorization ||
                lacksConektaPlanSavedCard ||
                lacksConektaPlanAuthorization ||
                lacksRebillPlanSavedCard ||
                lacksRebillPlanAuthorization ||
                lacksClipContact ||
                lacksClipCurrency ||
                needsStripeInstallmentAvailability ||
                needsClipInstallmentAvailability ||
                needsConektaInstallmentSelection
              }
              title={
                lacksDeliveryChannel
                  ? 'El contacto no tiene email ni teléfono para enviar el enlace'
                  : lacksPaymentPlanGateway
                    ? 'Conecta una pasarela para enviar el link de autorización'
                  : lacksPaymentPlanSavedCards
                    ? `Este ${customerLowerLabel} no tiene tarjetas guardadas`
                  : lacksSavedCard
                    ? 'Selecciona una tarjeta guardada'
                  : lacksStripePlanSavedCard
                    ? 'Selecciona una tarjeta guardada para el plan'
                  : lacksStripePlanAuthorization
                    ? 'Usa una tarjeta guardada o marca el primer pago como tarjeta/link'
                  : lacksConektaPlanSavedCard
                    ? 'Selecciona una tarjeta guardada para el plan'
                  : lacksConektaPlanAuthorization
                    ? 'Usa una tarjeta guardada o marca el primer pago como tarjeta/link'
                  : lacksRebillPlanSavedCard
                    ? 'Selecciona una tarjeta guardada para el plan'
                  : lacksRebillPlanAuthorization
                    ? 'Usa una tarjeta guardada o marca el primer pago como tarjeta/link'
                  : lacksClipContact
                    ? `CLIP requiere email y teléfono del ${customerLowerLabel}`
                  : lacksClipCurrency
                    ? 'CLIP solo acepta cobros en MXN'
                  : needsStripeInstallmentAvailability
                    ? 'Stripe requiere MXN y mínimo 300 MXN para meses sin intereses'
                  : needsClipInstallmentAvailability
                    ? 'CLIP requiere MXN y mínimo 300 MXN para meses sin intereses'
                  : needsConektaInstallmentSelection
                    ? 'Selecciona un plazo disponible para Conekta'
                  : undefined
              }
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Procesando...
                </>
              ) : (
                confirmLabel
              )}
            </Button>
            {/* Tooltip personalizado para mejor UX */}
            {lacksDeliveryChannel && (
              <div className={styles.tooltipInfo}>
                <AlertCircle size={14} />
                <span>El contacto necesita email o teléfono para enviar</span>
              </div>
            )}
            {lacksSavedCard && (
              <div className={styles.tooltipInfo}>
                <AlertCircle size={14} />
                <span>Selecciona una tarjeta guardada</span>
              </div>
            )}
            {lacksPaymentPlanGateway && (
              <div className={styles.tooltipInfo}>
                <AlertCircle size={14} />
                <span>Conecta una pasarela para enviar autorización</span>
              </div>
            )}
            {lacksPaymentPlanSavedCards && (
              <div className={styles.tooltipInfo}>
                <AlertCircle size={14} />
                <span>Este {customerLowerLabel} no tiene tarjetas guardadas</span>
              </div>
            )}
            {lacksStripePlanSavedCard && (
              <div className={styles.tooltipInfo}>
                <AlertCircle size={14} />
                <span>Selecciona una tarjeta guardada para programar</span>
              </div>
            )}
            {lacksStripePlanAuthorization && (
              <div className={styles.tooltipInfo}>
                <AlertCircle size={14} />
                <span>Usa tarjeta guardada o primer pago con tarjeta/link</span>
              </div>
            )}
            {lacksConektaPlanSavedCard && (
              <div className={styles.tooltipInfo}>
                <AlertCircle size={14} />
                <span>Selecciona una tarjeta guardada para programar</span>
              </div>
            )}
            {lacksConektaPlanAuthorization && (
              <div className={styles.tooltipInfo}>
                <AlertCircle size={14} />
                <span>Usa tarjeta guardada o primer pago con tarjeta/link</span>
              </div>
            )}
            {lacksRebillPlanSavedCard && (
              <div className={styles.tooltipInfo}>
                <AlertCircle size={14} />
                <span>Selecciona una tarjeta guardada para programar</span>
              </div>
            )}
            {lacksRebillPlanAuthorization && (
              <div className={styles.tooltipInfo}>
                <AlertCircle size={14} />
                <span>Usa tarjeta guardada o primer pago con tarjeta/link</span>
              </div>
            )}
            {needsConektaInstallmentSelection && (
              <div className={styles.tooltipInfo}>
                <AlertCircle size={14} />
                <span>Selecciona un plazo disponible para Conekta</span>
              </div>
            )}
            {lacksClipContact && (
              <div className={styles.tooltipInfo}>
                <AlertCircle size={14} />
                <span>CLIP requiere email y teléfono</span>
              </div>
            )}
            {lacksClipCurrency && (
              <div className={styles.tooltipInfo}>
                <AlertCircle size={14} />
                <span>CLIP solo acepta MXN</span>
              </div>
            )}
          </div>
        </div>
      )
    }

    return (
      <div className={styles.footer} data-modal-footer="">
        {variant !== 'embedded' && (
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={loading}
          >
            Cancelar
          </Button>
        )}
        <Button
          variant="primary"
          onClick={handleContinue}
          disabled={loading || firstPaymentMethodMissing}
          title={firstPaymentMethodMissing ? 'Selecciona un método de pago para continuar' : undefined}
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Preparando...
            </>
          ) : (
            activePaymentMode === 'partial' ? 'Crear parcialidades' : 'Continuar'
          )}
        </Button>
      </div>
    )
  }

  if (variant === 'embedded') {
    if (!isOpen) return null

    return (
      <div
        className={`${styles.embeddedRoot} ${showEmbeddedBackButton ? '' : styles.embeddedRootNoBack}`}
        data-payment-mode={activePaymentMode}
        data-payment-layout={layout}
      >
        {showEmbeddedBackButton && step !== 'processing' && (
          <button
            type="button"
            className={styles.embeddedBackButton}
            data-hidden={embeddedBackHidden ? 'true' : undefined}
            onClick={handleEmbeddedBack}
          >
            <ChevronLeft size={20} aria-hidden="true" />
            <span>Atrás</span>
          </button>
        )}
        <div
          ref={(el) => {
            embeddedScrollRef.current = el
            setEmbeddedScrollEl(el)
          }}
          className={styles.embeddedScroll}
          data-phone-chat-scrollable="true"
          data-phone-scrollable="true"
        >
          {step === 'processing' && renderProcessing()}
          {step === 'form' && renderForm()}
          {step === 'options' && renderPaymentOptions()}
          {step === 'link_ready' && renderPaymentLinkReady()}
          {step !== 'processing' && (
            <div className={styles.embeddedActions}>
              {step === 'form' && (
                <div className={styles.embeddedTotalRow}>
                  <span>
                    Total a cobrar
                    {currentTaxBreakdown.includesTax && <small>{getConfiguredTaxName(paymentTaxes)} · {formatCurrency(taxAmount, currency)}</small>}
                  </span>
                  <strong>{formatCurrency(totalAmount, currency)}</strong>
                </div>
              )}
              {renderFooter()}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        step === 'link_ready'
          ? 'Enlace de pago listo'
          : step === 'options'
          ? singlePaymentOptionsStage === 'saved_cards'
            ? 'Selecciona tarjeta guardada'
            : singlePaymentOptionsStage === 'gateway'
              ? 'Elige pasarela'
              : activePaymentMode === 'partial' && singlePaymentOptionsStage === 'confirm'
                ? paymentOption === 'rebill' ? 'Confirmar plan Rebill' : 'Confirmar autorización'
              : activePaymentMode !== 'partial' && singlePaymentOptionsStage === 'gateway_config' && paymentOption === 'mercadopago'
                ? 'Configura Mercado Pago'
              : activePaymentMode !== 'partial' && singlePaymentOptionsStage === 'gateway_config' && paymentOption === 'clip'
                ? 'Configura CLIP'
              : activePaymentMode !== 'partial' && singlePaymentOptionsStage === 'gateway_config' && paymentOption === 'rebill'
                ? 'Configura Rebill'
                : 'Elige cómo cobrar'
          : activePaymentMode === 'partial' ? 'Registrar cobro parcial' : 'Registrar nuevo cobro'
      }
      size="md"
      type="custom"
      flushContent
      closeOnBackdropClick={false}
      closeOnEscape={false}
      showCloseButton={step !== 'processing'}
    >
      {step === 'processing' && renderProcessing()}
      {step === 'form' && renderForm()}
      {step === 'options' && renderPaymentOptions()}
      {step === 'link_ready' && renderPaymentLinkReady()}
      {renderFooter()}
    </Modal>
  )
}
