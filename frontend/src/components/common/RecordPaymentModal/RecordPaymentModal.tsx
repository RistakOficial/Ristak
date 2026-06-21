import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { TabList } from '../TabList'
import { CustomSelect } from '../CustomSelect'
import { NumberInput } from '../NumberInput'
import { PhoneDateField } from '@/components/phone/PhoneDateField'
import { PhoneSelect } from '@/components/phone/PhoneSelect'
import { PhoneSegmentedTabs } from '@/components/phone/ui'
import {
  Search,
  Loader2,
  X,
  ChevronLeft,
  ChevronRight,
  CreditCard,
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
  Copy,
  ExternalLink,
  Mail,
  MessageCircle,
  WalletCards
} from 'lucide-react'
import styles from './RecordPaymentModal.module.css'
import { useNotification } from '@/contexts/NotificationContext'
import { useAccountCurrency } from '@/hooks'
import { apiUrl } from '@/services/apiBaseUrl'
import { getIntegrationsStatus } from '@/services/integrationsService'
import { formatCurrency as formatMxCurrency } from '@/utils/format'
import { highLevelService } from '@/services/highLevelService'
import { transactionsService } from '@/services/transactionsService'
import { mercadoPagoPaymentsService } from '@/services/mercadoPagoPaymentsService'
import { stripePaymentsService, type StripeSavedPaymentMethod } from '@/services/stripePaymentsService'
import {
  defaultPaymentSettings,
  paymentSettingsService,
  type PaymentTaxSettings
} from '@/services/paymentSettingsService'
import { contactsService, type PaymentLinkDeliveryChannelKey, type PaymentLinkDeliveryOptions } from '@/services/contactsService'
import { emailService } from '@/services/emailService'

const DEFAULT_INVOICE_TITLE = 'Pago'
const CONTACT_SEARCH_DELAY_MS = 90

const formatCurrency = (value: number, currency = 'MXN'): string => formatMxCurrency(value, currency)

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

type PaymentOption = 'send' | 'manual' | 'stripe' | 'stripe_saved_card' | 'mercadopago'
type PaymentMode = 'single' | 'partial'
type SinglePaymentAction = 'payment_link' | 'saved_card' | 'manual'
type SinglePaymentOptionsStage = 'method' | 'gateway'
type InstallmentValueType = 'percentage' | 'amount'
type FirstPaymentMethod = '' | 'cash' | 'bank_transfer' | 'deposit' | 'card'
type RemainingFrequency = 'custom' | 'weekly' | 'biweekly' | 'monthly'
type StripePlanCardSource = 'new_card' | 'saved_card'
type SendMethod = 'whatsapp' | 'sms' | 'email' | 'email_whatsapp' | 'email_sms' | 'all'
type InvoiceSendMethod = 'email' | 'sms' | 'both'
type PaymentSegmentedOption = { value: string; label: string }
type RecordPaymentStep = 'form' | 'options' | 'processing' | 'link_ready'
type CreatedPaymentLinkKind = 'single' | 'first_payment' | 'card_setup'

const INSTALLMENT_VALUE_TYPE_OPTIONS = [
  { value: 'amount', label: 'Monto fijo' },
  { value: 'percentage', label: 'Porcentaje' }
]

const FIRST_PAYMENT_METHOD_OPTIONS = [
  { value: '', label: 'Seleccionar método', disabled: true },
  { value: 'bank_transfer', label: 'Transferencia' },
  { value: 'cash', label: 'Efectivo' },
  { value: 'deposit', label: 'Depósito' },
  { value: 'card', label: 'Tarjeta / link' }
]

const REMAINING_FREQUENCY_OPTIONS = [
  { value: 'monthly', label: 'Mensual' },
  { value: 'biweekly', label: 'Quincenal' },
  { value: 'weekly', label: 'Semanal' },
  { value: 'custom', label: 'Personalizada' }
]

const LINK_READY_SUCCESS_CONTEXT: RecordPaymentSuccessContext = {
  keepOpen: true,
  paymentLinkReady: true
}

const MANUAL_PAYMENT_METHOD_OPTIONS = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'bank_transfer', label: 'Transferencia bancaria' },
  { value: 'card', label: 'Tarjeta' },
  { value: 'check', label: 'Cheque' },
  { value: 'other', label: 'Otro' }
]

interface InstallmentDraft {
  id: string
  type: InstallmentValueType
  value: string
  dueDate: string
}

export interface RecordPaymentSuccessContext {
  keepOpen?: boolean
  paymentLinkReady?: boolean
}

interface RecordPaymentModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess?: (context?: RecordPaymentSuccessContext) => void
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

const EMAIL_SEND_METHODS = new Set<SendMethod>(['email', 'email_whatsapp', 'email_sms', 'all'])
const PHONE_SEND_METHODS = new Set<SendMethod>(['whatsapp', 'sms', 'email_whatsapp', 'email_sms', 'all'])
const SMS_SEND_METHODS = new Set<SendMethod>(['sms', 'email_sms', 'all'])
const WHATSAPP_SEND_METHODS = new Set<SendMethod>(['whatsapp', 'email_whatsapp', 'all'])
const DEFAULT_SEND_METHOD: SendMethod = 'all'
const PAYMENT_LINK_DELIVERY_CHANNELS: PaymentLinkDeliveryChannelKey[] = ['whatsapp', 'messenger', 'email']

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

interface CreatedPaymentLink {
  kind: CreatedPaymentLinkKind
  title: string
  description: string
  paymentUrl: string
  amount: number
  currency: string
  contact: Contact
  paymentId?: string | null
  publicPaymentId?: string | null
}

const defaultManualPaymentData = (): ManualPaymentData => ({
  paymentDate: new Date().toISOString().split('T')[0],
  paymentMethod: 'bank_transfer',
  reference: '',
  notes: ''
})

const toDateInputValue = (date: Date) => date.toISOString().split('T')[0]

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

const defaultPartialInstallments = (): InstallmentDraft[] => {
  const today = new Date()
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

const getNextDueDate = (baseDate: string, frequency: RemainingFrequency, index: number) => {
  const base = baseDate ? new Date(`${baseDate}T00:00:00`) : new Date()

  if (frequency === 'weekly') {
    return toDateInputValue(addDays(base, 7 * index))
  }

  if (frequency === 'biweekly') {
    return toDateInputValue(addDays(base, 14 * index))
  }

  return toDateInputValue(addMonths(base, index))
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
  variant = 'modal'
}) => {
  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState<RecordPaymentStep>('form')

  // Contact search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchingContact, setSearchingContact] = useState(false)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [showContactDropdown, setShowContactDropdown] = useState(false)
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
  const [firstPaymentDate, setFirstPaymentDate] = useState(toDateInputValue(new Date()))
  const [firstPaymentMethod, setFirstPaymentMethod] = useState<FirstPaymentMethod>('')
  const [remainingAutomatic, setRemainingAutomatic] = useState(true)
  const [remainingValueType, setRemainingValueType] = useState<InstallmentValueType>('amount')
  const [remainingFrequency, setRemainingFrequency] = useState<RemainingFrequency>('monthly')
  const [remainingInstallments, setRemainingInstallments] = useState<InstallmentDraft[]>(defaultPartialInstallments)
  const [autoDistributeRemaining, setAutoDistributeRemaining] = useState(true)

  // Business details (required by GHL)
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

  // Payment options
  const [invoicePayload, setInvoicePayload] = useState<Record<string, any> | null>(null)
  const [invoiceSummary, setInvoiceSummary] = useState<InvoiceSummary | null>(null)
  const [singlePaymentAction, setSinglePaymentAction] = useState<SinglePaymentAction>('payment_link')
  const [singlePaymentOptionsStage, setSinglePaymentOptionsStage] = useState<SinglePaymentOptionsStage>('method')
  const [paymentOption, setPaymentOption] = useState<PaymentOption>('send')
  const [sendMethod, setSendMethod] = useState<SendMethod>(DEFAULT_SEND_METHOD)
  const [manualPaymentData, setManualPaymentData] = useState<ManualPaymentData>(defaultManualPaymentData)
  const [transferInfoUrl, setTransferInfoUrl] = useState<string | null>(null)
  const [savedPaymentMethods, setSavedPaymentMethods] = useState<StripeSavedPaymentMethod[]>([])
  const [selectedSavedPaymentMethodId, setSelectedSavedPaymentMethodId] = useState('')
  const [stripePlanCardSource, setStripePlanCardSource] = useState<StripePlanCardSource>('new_card')
  const [createdPaymentLink, setCreatedPaymentLink] = useState<CreatedPaymentLink | null>(null)
  const [paymentLinkDeliveryOptions, setPaymentLinkDeliveryOptions] = useState<PaymentLinkDeliveryOptions | null>(null)
  const [loadingPaymentLinkDeliveryOptions, setLoadingPaymentLinkDeliveryOptions] = useState(false)
  const [sendingPaymentLinkChannel, setSendingPaymentLinkChannel] = useState<PaymentLinkDeliveryChannelKey | null>(null)

  // Estado de conexión con HighLevel. Cuando NO está conectado, Ristak opera en
  // modo local: productos y pagos manuales siguen funcionando; enlaces y
  // parcialidades remotas quedan desactivados.
  const [highLevelConnected, setHighLevelConnected] = useState(false)
  const [stripeConnected, setStripeConnected] = useState(false)
  const [mercadoPagoConnected, setMercadoPagoConnected] = useState(false)

  const { showToast } = useNotification()
  const [accountCurrency] = useAccountCurrency()
  const embeddedScrollRef = useRef<HTMLDivElement | null>(null)
  const renderPaymentSelect = ({
    value,
    onChange,
    options,
    title,
    placeholder,
    invalid = false
  }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string; disabled?: boolean }>;
    title: string;
    placeholder?: string;
    invalid?: boolean;
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
      />
    ) : (
      <CustomSelect
        value={value}
        onValueChange={onChange}
        options={options.filter((option) => !option.disabled)}
        placeholder={placeholder || title}
        className={styles.customSelectControl}
        portal
      />
    )
  )

  const canUsePaymentPlans = highLevelConnected || stripeConnected
  const canChoosePaymentMode = canUsePaymentPlans && (chargeType === 'direct' || Boolean(selectedProduct && selectedPrice))
  const activePaymentMode: PaymentMode = canChoosePaymentMode ? paymentMode : 'single'
  const subtotalAmount = useMemo(() => (
    chargeType === 'product'
      ? normalizeAmount(customAmount)
      : normalizeAmount(amount)
  ), [amount, chargeType, customAmount])

  const currentTaxBreakdown = useMemo(() => (
    calculateConfiguredTax(subtotalAmount, paymentTaxes, includeIVA, taxCalculationMode)
  ), [includeIVA, paymentTaxes, subtotalAmount, taxCalculationMode])
  const taxAmount = currentTaxBreakdown.taxAmount
  const totalAmount = currentTaxBreakdown.totalAmount
  const firstPaymentAmount = firstPaymentEnabled
    ? resolvePartialAmount(firstPaymentType, firstPaymentValue, totalAmount)
    : 0
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
  const partialAllocatedPct = totalAmount > 0
    ? Math.min(100, Math.max(0, (partialPlanTotal / totalAmount) * 100))
    : 0
  const partialPlanStatus: 'ok' | 'under' | 'over' = Math.abs(partialPlanDifference) <= 0.5
    ? 'ok'
    : partialPlanDifference > 0
      ? 'under'
      : 'over'
  const firstPaymentMethodMissing = activePaymentMode === 'partial' && firstPaymentEnabled && !firstPaymentMethod
  const partialNeedsCardAuthorization = activePaymentMode === 'partial' && remainingAutomatic && (
    !firstPaymentEnabled || isOfflineFirstPaymentMethod(firstPaymentMethod)
  )
  const sendMethodOptions = useMemo(() => getSendMethodOptions(selectedContact), [selectedContact?.email, selectedContact?.phone])
  const selectedSendMethodOption = sendMethodOptions.find(option => option.value === sendMethod)
  const savedPaymentMethodOptions = useMemo(() => (
    savedPaymentMethods.map((method) => ({
      value: method.stripePaymentMethodId,
      label: getSavedCardDescription(method)
    }))
  ), [savedPaymentMethods])
  const selectedSavedPaymentMethod = savedPaymentMethods.find((method) => (
    method.stripePaymentMethodId === selectedSavedPaymentMethodId || method.id === selectedSavedPaymentMethodId
  )) || null
  const stripePlanSavedPaymentMethod = stripePlanCardSource === 'saved_card'
    ? selectedSavedPaymentMethod || savedPaymentMethods[0] || null
    : null
  const firstPaymentCanAuthorizeStripePlan = firstPaymentEnabled && firstPaymentMethod === 'card'
  const stripePlanNeedsSetupLink = stripePlanCardSource === 'new_card' && !firstPaymentCanAuthorizeStripePlan
  const stripePlanCanBeAuthorized = stripePlanCardSource === 'saved_card'
    ? Boolean(stripePlanSavedPaymentMethod)
    : firstPaymentCanAuthorizeStripePlan || stripePlanNeedsSetupLink
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

  const paymentLinkGatewayLabels = [
    stripeConnected ? 'Stripe' : null,
    mercadoPagoConnected ? 'Mercado Pago' : null,
    highLevelConnected ? 'HighLevel' : null
  ].filter(Boolean) as string[]
  const paymentLinkGatewayCount = paymentLinkGatewayLabels.length
  const hasPaymentLinkGateways = paymentLinkGatewayCount > 0
  const hasMultiplePaymentLinkGateways = paymentLinkGatewayCount > 1
  const defaultPaymentLinkOption: PaymentOption | null = stripeConnected
    ? 'stripe'
    : mercadoPagoConnected
      ? 'mercadopago'
      : highLevelConnected
        ? 'send'
        : null

  const getDefaultPaymentOption = (): PaymentOption => {
    if (stripeConnected) return 'stripe'
    if (mercadoPagoConnected) return 'mercadopago'
    return highLevelConnected ? 'send' : 'manual'
  }

  const getDefaultSinglePaymentAction = (): SinglePaymentAction => {
    if (hasPaymentLinkGateways) return 'payment_link'
    if (stripeConnected && savedPaymentMethods.length > 0) return 'saved_card'
    return 'manual'
  }

  const selectSinglePaymentLinkAction = () => {
    setSinglePaymentAction('payment_link')
    setPaymentOption(defaultPaymentLinkOption || 'manual')
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
    setShowContactDropdown(false)
    setContactPickerOpen(false)
    setChargeType('direct')
    setAmount('')
    setPaymentTitle('')
    setDescription('')
    setCurrency(accountCurrency)
    setIncludeIVA(Boolean(paymentTaxes.enabled))
    setTaxCalculationMode(paymentTaxes.calculationMode || defaultPaymentSettings.taxes.calculationMode)
    setPaymentMode(initialPaymentMode)
    setFirstPaymentEnabled(false)
    setFirstPaymentType('amount')
    setFirstPaymentValue('')
    setFirstPaymentDate(toDateInputValue(new Date()))
    setFirstPaymentMethod('')
    setRemainingAutomatic(true)
    setRemainingValueType('amount')
    setRemainingFrequency('monthly')
    setRemainingInstallments(defaultPartialInstallments())
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
    setInvoicePayload(null)
    setInvoiceSummary(null)
    setSinglePaymentAction(getDefaultSinglePaymentAction())
    setSinglePaymentOptionsStage('method')
    setPaymentOption(getDefaultPaymentOption())
    setSendMethod(resolvedInitialContact ? getDefaultSendMethod(getSendMethodOptions(resolvedInitialContact)) : DEFAULT_SEND_METHOD)
    setManualPaymentData(defaultManualPaymentData())
    setSavedPaymentMethods([])
    setSelectedSavedPaymentMethodId('')
    setStripePlanCardSource('new_card')
    setCreatedPaymentLink(null)
    setPaymentLinkDeliveryOptions(null)
    setLoadingPaymentLinkDeliveryOptions(false)
    setSendingPaymentLinkChannel(null)
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
    try {
      const data = await getIntegrationsStatus()
      setHighLevelConnected(Boolean(data?.highlevel?.connected))
      setStripeConnected(Boolean(data?.stripe?.connected))
      setMercadoPagoConnected(Boolean(data?.mercadopago?.connected))
    } catch (error) {
      setHighLevelConnected(false)
      setStripeConnected(false)
      setMercadoPagoConnected(false)
    }
  }

  // En modo local completo (sin pasarela) forzamos pago único manual.
  // HighLevel y Stripe pueden manejar links/planes desde Ristak.
  // Mercado Pago maneja links y suscripciones, no parcialidades.
  useEffect(() => {
    if (!highLevelConnected && !stripeConnected && !mercadoPagoConnected) {
      setPaymentMode('single')
      setSinglePaymentAction('manual')
      setSinglePaymentOptionsStage('method')
      setPaymentOption('manual')
    }
  }, [highLevelConnected, mercadoPagoConnected, stripeConnected])

  useEffect(() => {
    if (isOpen && stripeConnected && activePaymentMode === 'partial' && firstPaymentEnabled && !firstPaymentMethod) {
      setFirstPaymentMethod('card')
    }
  }, [isOpen, stripeConnected, activePaymentMode, firstPaymentEnabled, firstPaymentMethod])

  useEffect(() => {
    if (!paymentTaxes.enabled && includeIVA) {
      setIncludeIVA(false)
    }
  }, [includeIVA, paymentTaxes.enabled])

  useEffect(() => {
    let cancelled = false

    if (!isOpen || !stripeConnected || !selectedContact?.id) {
      setSavedPaymentMethods([])
      setSelectedSavedPaymentMethodId('')
      if (paymentOption === 'stripe_saved_card') {
        setSinglePaymentAction(getDefaultSinglePaymentAction())
        setPaymentOption(getDefaultPaymentOption())
      }
      return () => {
        cancelled = true
      }
    }

    stripePaymentsService.getSavedPaymentMethods(selectedContact.id)
      .then((methods) => {
        if (cancelled) return
        setSavedPaymentMethods(methods)
        setSelectedSavedPaymentMethodId((current) => {
          const stillExists = methods.some((method) => (
            method.stripePaymentMethodId === current || method.id === current
          ))
          if (stillExists) return current
          const preferred = methods.find((method) => method.isDefault) || methods[0]
          return preferred?.stripePaymentMethodId || ''
        })
        if (!methods.length && paymentOption === 'stripe_saved_card') {
          setSinglePaymentAction(getDefaultSinglePaymentAction())
          setPaymentOption(getDefaultPaymentOption())
        }
      })
      .catch(() => {
        if (cancelled) return
        setSavedPaymentMethods([])
        setSelectedSavedPaymentMethodId('')
        if (paymentOption === 'stripe_saved_card') {
          setSinglePaymentAction(getDefaultSinglePaymentAction())
          setPaymentOption(getDefaultPaymentOption())
        }
      })

    return () => {
      cancelled = true
    }
  }, [isOpen, stripeConnected, selectedContact?.id, paymentOption])

  useEffect(() => {
    if (!isOpen) {
      resetForm()
      return
    }

    resetForm()
    loadConfig()
    loadPaymentTaxSettings()
    loadIntegrationStatus()
  }, [isOpen, initialPaymentMode, initialContact?.id, initialContact?.email, initialContact?.phone, initialContact?.name, accountCurrency])

  // Search contacts
  useEffect(() => {
    if (contactLocked) {
      setContacts([])
      setShowContactDropdown(false)
      setContactPickerOpen(false)
      setSearchingContact(false)
      return
    }

    if (isEmbedded && !contactPickerOpen) {
      setContacts([])
      setShowContactDropdown(false)
      setSearchingContact(false)
      return
    }

    const query = searchQuery.trim()
    const shouldLoadRecentContacts = isEmbedded && contactPickerOpen && query.length < 2

    if (query.length < 2 && !shouldLoadRecentContacts) {
      setContacts([])
      setShowContactDropdown(false)
      setSearchingContact(false)
      return
    }

    const controller = new AbortController()
    setSearchingContact(true)
    setShowContactDropdown(!isEmbedded)

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
          setShowContactDropdown(!isEmbedded)
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
      dueDate: getNextDueDate(firstPaymentDate, remainingFrequency, index + 1)
    })))
  }, [activePaymentMode, firstPaymentDate, remainingFrequency])

  useEffect(() => {
    if (activePaymentMode !== 'partial' || !autoDistributeRemaining) return

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
    firstPaymentEnabled,
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

  const loadPaymentLinkDeliveryOptions = async (contactId: string) => {
    setLoadingPaymentLinkDeliveryOptions(true)
    try {
      const options = await contactsService.getPaymentLinkDeliveryOptions(contactId)
      setPaymentLinkDeliveryOptions(options)
    } catch {
      setPaymentLinkDeliveryOptions(null)
    } finally {
      setLoadingPaymentLinkDeliveryOptions(false)
    }
  }

  const showPaymentLinkReady = (link: CreatedPaymentLink) => {
    setCreatedPaymentLink(link)
    setPaymentLinkDeliveryOptions(null)
    setSendingPaymentLinkChannel(null)
    setStep('link_ready')
    void loadPaymentLinkDeliveryOptions(link.contact.id)
  }

  const getCreatedPaymentLinkShareText = (link: CreatedPaymentLink) => {
    const contactName = getContactDisplayName(link.contact)
    const amountText = link.amount > 0 ? ` por ${formatCurrency(link.amount, link.currency)}` : ''
    const intro = link.kind === 'card_setup'
      ? `Hola ${contactName}, te comparto el enlace para domiciliar tu tarjeta${amountText} y activar tu plan de pagos:`
      : link.kind === 'first_payment'
        ? `Hola ${contactName}, te comparto el enlace del primer pago${amountText}. Al pagarlo se guarda tu tarjeta para los siguientes cobros programados:`
        : `Hola ${contactName}, te comparto tu enlace de pago${amountText}:`

    return `${intro}\n${link.paymentUrl}`
  }

  const getCreatedPaymentLinkEmailSubject = (link: CreatedPaymentLink) => {
    if (link.kind === 'card_setup') return `Domiciliación de tarjeta - ${businessName}`
    if (link.kind === 'first_payment') return `Primer pago - ${businessName}`
    return `Enlace de pago - ${businessName}`
  }

  const handleCopyCreatedPaymentLink = async () => {
    if (!createdPaymentLink?.paymentUrl) return

    const copied = await copyTextToClipboard(createdPaymentLink.paymentUrl)
    showToast(
      copied ? 'success' : 'error',
      copied ? 'Enlace copiado' : 'No se pudo copiar el enlace'
    )
  }

  const handleOpenCreatedPaymentLink = () => {
    if (!createdPaymentLink?.paymentUrl || typeof window === 'undefined') return
    window.open(createdPaymentLink.paymentUrl, '_blank', 'noopener,noreferrer')
  }

  const getPaymentLinkChannelIcon = (channel: PaymentLinkDeliveryChannelKey) => {
    if (channel === 'email') return <Mail size={16} />
    if (channel === 'messenger') return <Send size={16} />
    return <MessageCircle size={16} />
  }

  const handleSendCreatedPaymentLink = async (channel: PaymentLinkDeliveryChannelKey) => {
    if (!createdPaymentLink) return

    const deliveryChannel = paymentLinkDeliveryOptions?.channels[channel]
    if (!deliveryChannel?.available) {
      showToast('error', 'Canal no disponible', deliveryChannel?.reason || 'Este contacto no tiene ese canal conectado.')
      return
    }

    setSendingPaymentLinkChannel(channel)
    try {
      const message = getCreatedPaymentLinkShareText(createdPaymentLink)
      const externalId = `payment_link_${createdPaymentLink.kind}_${channel}_${Date.now()}`

      if (channel === 'email') {
        await emailService.send({
          contactId: createdPaymentLink.contact.id,
          to: deliveryChannel.value || createdPaymentLink.contact.email,
          subject: getCreatedPaymentLinkEmailSubject(createdPaymentLink),
          text: message,
          externalId,
          includeSignature: true
        })
      } else {
        await highLevelService.sendConversationMessage({
          contactId: createdPaymentLink.contact.id,
          channel: channel === 'messenger' ? 'messenger' : 'whatsapp_api',
          message,
          toNumber: channel === 'whatsapp' ? (deliveryChannel.value || createdPaymentLink.contact.phone) : undefined,
          externalId
        })
      }

      showToast('success', 'Enlace enviado', `Se mandó por ${deliveryChannel.label}.`)
    } catch (error: any) {
      showToast('error', `No se pudo enviar por ${deliveryChannel.label}`, error.message || 'Intenta copiar el enlace y mandarlo manualmente.')
    } finally {
      setSendingPaymentLinkChannel(null)
    }
  }

  const handleSelectContact = (contact: Contact) => {
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
    setShowContactDropdown(false)
    setContactPickerOpen(false)
    setContacts([])
  }

  const handleClearContact = () => {
    if (contactLocked) return
    setSelectedContact(null)
    setSearchQuery('')
    setContacts([])
    setShowContactDropdown(false)
    setContactPickerOpen(false)
  }

  const openContactPicker = () => {
    if (contactLocked) return
    setSearchQuery('')
    setContacts([])
    setShowContactDropdown(false)
    setContactPickerOpen(true)
  }

  const closeContactPicker = () => {
    setContactPickerOpen(false)
    setSearchQuery('')
    setContacts([])
    setShowContactDropdown(false)
    setSearchingContact(false)
  }

  const returnToPaymentForm = () => {
    setStep('form')
    setInvoicePayload(null)
    setInvoiceSummary(null)
    setSinglePaymentAction(getDefaultSinglePaymentAction())
    setSinglePaymentOptionsStage('method')
    setPaymentOption(getDefaultPaymentOption())
    setCreatedPaymentLink(null)
    setPaymentLinkDeliveryOptions(null)
    setSendingPaymentLinkChannel(null)
  }

  const handleEmbeddedBack = () => {
    if (contactPickerOpen) {
      closeContactPicker()
      return
    }

    if (step === 'options') {
      if (activePaymentMode !== 'partial' && singlePaymentOptionsStage === 'gateway') {
        setSinglePaymentOptionsStage('method')
        return
      }
      returnToPaymentForm()
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
      const nextIndex = prev.length + 1
      return [
        ...prev,
        {
          id: createInstallmentId(),
          type: effectiveRemainingValueType,
          value: '0',
          dueDate: getNextDueDate(firstPaymentDate, remainingFrequency === 'custom' ? 'monthly' : remainingFrequency, nextIndex)
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

  const buildPartialFlowPayload = (payload: Record<string, any>, summary: InvoiceSummary, channels: Record<string, boolean>) => ({
    contact: selectedContact,
    totalAmount: summary.amount,
    currency: summary.currency,
    description: summary.description,
    invoicePayload: payload,
    firstPayment: {
      enabled: firstPaymentEnabled,
      type: firstPaymentType,
      value: normalizeAmount(firstPaymentValue),
      amount: firstPaymentAmount,
      date: firstPaymentDate,
      method: firstPaymentEnabled ? firstPaymentMethod : 'none'
    },
    remainingAutomatic,
    remainingFrequency,
    remainingPayments: resolvedRemainingInstallments.map(installment => ({
      sequence: installment.sequence,
      type: installment.type,
      value: normalizeAmount(installment.value),
      amount: installment.amount,
      percentage: installment.percentage,
      dueDate: installment.dueDate,
      frequency: remainingFrequency
    })),
    channels
  })

  const buildStripePaymentPlanPayload = (payload: Record<string, any>, summary: InvoiceSummary) => ({
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
      enabled: firstPaymentEnabled,
      amount: firstPaymentAmount,
      date: firstPaymentDate,
      method: firstPaymentEnabled ? firstPaymentMethod || 'card' : 'none'
    },
    remainingFrequency,
    remainingPayments: resolvedRemainingInstallments.map(installment => ({
      sequence: installment.sequence,
      type: installment.type,
      value: normalizeAmount(installment.value),
      amount: installment.amount,
      percentage: installment.percentage,
      dueDate: installment.dueDate,
      frequency: remainingFrequency
    })),
    paymentMethodId: stripePlanSavedPaymentMethod?.stripePaymentMethodId || '',
    cardSetupAmount,
    source: 'record_payment_modal_stripe_plan'
  })

  const submitPartialFlow = async (
    payload: Record<string, any>,
    summary: InvoiceSummary,
    channels: Record<string, boolean>
  ) => {
    const response = await fetch(apiUrl('/api/highlevel/payment-flows/installments'), {
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
        description: 'Comparte este enlace para que el cliente domicilie su tarjeta. El plan se activa cuando pague y guarde la tarjeta.',
        paymentUrl: data.cardSetupPaymentLink,
        amount: cardSetupAmount,
        currency: summary.currency,
        contact: selectedContact,
        paymentId: data.cardSetupInvoiceId
      })
      showToast('success', 'Parcialidades creadas', 'El enlace de domiciliación está listo para copiar o enviar.')
      onSuccess?.(LINK_READY_SUCCESS_CONTEXT)
      return
    }

    if (selectedContact && data.firstPaymentLink) {
      showPaymentLinkReady({
        kind: 'first_payment',
        title: 'Primer pago listo',
        description: 'Comparte este enlace para que el cliente pague el primer cobro. Al pagarlo se guarda la tarjeta y se activan los siguientes cobros programados.',
        paymentUrl: data.firstPaymentLink,
        amount: firstPaymentAmount,
        currency: summary.currency,
        contact: selectedContact,
        paymentId: data.firstPaymentInvoiceId
      })
      showToast('success', 'Parcialidades creadas', 'El enlace del primer pago está listo para copiar o enviar.')
      onSuccess?.(LINK_READY_SUCCESS_CONTEXT)
      return
    }

    const statusMessage = data.currentState === 'waiting_card_authorization'
      ? 'Parcialidades creadas. El sistema esperará la autorización de tarjeta antes de activar los pagos automáticos.'
      : 'Parcialidades creadas correctamente.'

    showToast('success', 'Éxito', statusMessage)

    onSuccess?.()
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

    const dueDate = new Date(Date.now() + (invoiceDueDays || 7) * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]

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
      issueDate: new Date().toISOString().split('T')[0],
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

      if (firstPaymentEnabled && firstPaymentAmount <= 0) {
        showToast('error', 'Configura un primer pago mayor a 0')
        return
      }

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

      if (Math.abs(partialPlanDifference) > 0.5) {
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
        'Cliente'

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
        setPaymentOption(stripeConnected ? 'stripe' : 'send')
        setStripePlanCardSource('new_card')
        setStep('options')
        return
      }

      setManualPaymentData(defaultManualPaymentData())
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

    if (paymentOption === 'stripe' && activePaymentMode === 'partial') {
      if (!selectedContact) {
        showToast('error', 'Selecciona un contacto')
        setStep('options')
        setLoading(false)
        return
      }

      try {
        const result = await stripePaymentsService.createPaymentPlan(
          buildStripePaymentPlanPayload(invoicePayload, invoiceSummary)
        )

        if (result.cardSetupLink) {
          const setupAmount = result.cardSetupAmount || cardSetupAmount
          const manualFirstPaymentRegistered = firstPaymentEnabled && isOfflineFirstPaymentMethod(firstPaymentMethod)
          showPaymentLinkReady({
            kind: 'card_setup',
            title: 'Enlace de domiciliación listo',
            description: `${manualFirstPaymentRegistered ? 'El primer pago manual ya quedó registrado. ' : ''}Comparte este enlace para que el cliente domicilie su tarjeta. El plan se activa cuando pague y guarde la tarjeta.`,
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
          onSuccess?.(LINK_READY_SUCCESS_CONTEXT)
          return
        } else if (result.firstPaymentLink) {
          showPaymentLinkReady({
            kind: 'first_payment',
            title: 'Primer pago listo',
            description: 'Comparte este enlace para que el cliente pague el primer cobro. Al pagarlo se guarda la tarjeta y se activan los siguientes cobros programados.',
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
          onSuccess?.(LINK_READY_SUCCESS_CONTEXT)
          return
        } else {
          showToast(
            'success',
            'Plan de Stripe creado',
            `${result.scheduledPayments.length} cobros quedaron programados con tarjeta guardada.`
          )
        }

        onSuccess?.()
        onClose()
      } catch (stripePlanError: any) {
        showToast('error', 'No se pudo crear el plan con Stripe', stripePlanError.message || 'Revisa la tarjeta guardada o manda primer pago por link.')
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
          lineItems: Array.isArray(invoicePayload.items) ? invoicePayload.items : []
        })

        showPaymentLinkReady({
          kind: 'single',
          title: 'Enlace de pago listo',
          description: 'Comparte este enlace para que el cliente pague con tarjeta desde la página pública segura.',
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
          'El enlace público está listo para copiar o enviar.'
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
          lineItems: Array.isArray(invoicePayload.items) ? invoicePayload.items : []
        })

        showPaymentLinkReady({
          kind: 'single',
          title: 'Enlace Mercado Pago listo',
          description: 'Comparte este enlace para que el cliente pague con Mercado Pago. Ristak actualizará el estado por webhook.',
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

    // Modo local (sin HighLevel): registrar el pago directamente en Ristak.
    if (!highLevelConnected) {
      if (!selectedContact) {
        showToast('error', 'Selecciona un contacto')
        setStep('options')
        setLoading(false)
        return
      }

      try {
        await transactionsService.createTransaction({
          date: manualPaymentData.paymentDate || new Date().toISOString(),
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
        })

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
              paymentDate: manualPaymentData.paymentDate,
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
          await transactionsService.createTransaction({
            date: manualPaymentData.paymentDate || new Date().toISOString(),
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
          })

          showToast('success', 'Pago registrado localmente', 'Cuando conectes HighLevel, Ristak lo importará y lo enlazará para evitar duplicados.')
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
      // Las parcialidades necesitan una pasarela conectada. En modo local solo hay pago único.
      if (!canUsePaymentPlans || lockPaymentMode) return null

      return (
      <div className={styles.field}>
        <label className={styles.label}>Tipo de pago</label>
        <div className={styles.segmentedTabsField}>
          {renderPaymentSegmentedTabs({
            ariaLabel: 'Tipo de pago',
            options: [
              { value: 'single', label: 'Único' },
              { value: 'partial', label: 'Parcialidades' }
            ],
            value: paymentMode,
            onChange: (value) => {
              const nextPaymentMode = value as PaymentMode
              if (nextPaymentMode === 'partial' && paymentMode !== 'partial') {
                setFirstPaymentMethod('')
              }
              setPaymentMode(nextPaymentMode)
            }
          })}
        </div>
      </div>
      )
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
                <span>Cliente</span>
                <strong>Seleccionar contacto</strong>
              </div>
              <button type="button" onClick={closeContactPicker} aria-label="Cerrar búsqueda">
                <ChevronLeft size={19} />
              </button>
            </header>

            <div className={styles.contactSearchBox} data-ristak-unstyled>
              <Search size={16} className={styles.searchIcon} />
              <input
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
          <div className={styles.field}>
            <label className={styles.label}>Cliente</label>

            {isEmbedded ? (
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
            ) : selectedContact ? (
              <div className={styles.selectedContact}>
                <div className={styles.contactInfo}>
                  <p className={styles.contactName}>{getContactDisplayName(selectedContact)}</p>
                  <p className={styles.contactDetail}>{getContactDisplayDetail(selectedContact)}</p>
                </div>
                <button
                  type="button"
                  onClick={handleClearContact}
                  className={styles.clearButton}
                  title="Cambiar contacto"
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
              <div className={styles.searchWrapper}>
                <div className={styles.searchInput}>
                  <Search size={16} className={styles.searchIcon} />
                  <input
                    type="text"
                    placeholder="Buscar por nombre, email o teléfono..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className={styles.input}
                    aria-label="Buscar contacto para cobrar"
                  />
                  {searchingContact && <Loader2 size={16} className={styles.loadingIcon} />}
                </div>

                {showContactDropdown && (
                  <div
                    className={styles.dropdown}
                    data-phone-scrollable="true"
                    data-ristak-dropdown-panel="true"
                  >
                    {searchingContact && contacts.length === 0 ? (
                      <div className={styles.dropdownEmpty}>
                        Buscando contactos...
                      </div>
                    ) : contacts.length > 0 ? (
                      contacts.map((contact) => (
                        <button
                          key={contact.id}
	                          type="button"
	                          className={styles.dropdownItem}
                            data-ristak-dropdown-item="true"
	                          onClick={() => handleSelectContact(contact)}
                        >
                          <p className={styles.dropdownName}>{getContactDisplayName(contact)}</p>
                          <p className={styles.dropdownDetail}>{getContactDisplayDetail(contact)}</p>
                        </button>
                      ))
                    ) : (
                      <div className={styles.dropdownEmpty}>
                        No se encontraron contactos
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.label}>Tipo de cobro</label>
          <div className={styles.segmentedTabsField}>
            {renderPaymentSegmentedTabs({
              ariaLabel: 'Tipo de cobro',
              options: [
                { value: 'direct', label: 'Personalizado' },
                { value: 'product', label: 'Precios guardados' }
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

                <div className={styles.fieldGrid}>
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
                    <label className={styles.label}>Moneda de cuenta</label>
                    <div className={styles.currencyNote}>
                      <span>Moneda de cuenta</span>
                      <strong>{accountCurrency}</strong>
                    </div>
                  </div>
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
                  <p className={styles.hint}>Puedes modificar el precio según tu negociación con el cliente</p>
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
                <p>Plan de parcialidades</p>
                <span>Define si habrá enganche y programa los cobros automáticos hasta cubrir el total.</span>
              </div>
              <div className={styles.planTotalChip}>
                <span>Total a financiar</span>
                <strong>{formatCurrency(totalAmount, currency)}</strong>
              </div>
            </div>

            <div className={styles.planStep}>
              <div className={styles.planStepHead}>
                <div className={styles.planStepTitle}>
                  <span className={styles.stepNumber}>1</span>
                  <div>
                    <p>Primer pago</p>
                    <span>Activa un enganche si el plan debe iniciar con un primer pago.</span>
                  </div>
                </div>
                {renderPaymentSegmentedTabs({
                  ariaLabel: 'Primer pago',
                  options: [
                    { value: 'no', label: 'Sin enganche' },
                    { value: 'yes', label: 'Con enganche' }
                  ],
                  value: firstPaymentEnabled ? 'yes' : 'no',
                  onChange: (value) => {
                    setFirstPaymentEnabled(value === 'yes')
                    setAutoDistributeRemaining(true)
                  },
                  desktopFullWidth: false
                })}
              </div>

              {firstPaymentEnabled && (
                <div className={styles.planStepBody}>
                  <div className={styles.fieldGrid}>
                    <div className={styles.manualField}>
                      <label>Tipo de valor</label>
                      {renderPaymentSelect({
                        value: firstPaymentType,
                        onChange: (value) => {
                          setFirstPaymentType(value as InstallmentValueType)
                          setAutoDistributeRemaining(true)
                        },
                        options: INSTALLMENT_VALUE_TYPE_OPTIONS,
                        title: 'Tipo de valor'
                      })}
                    </div>
                    <div className={styles.manualField}>
                      <label>{firstPaymentType === 'percentage' ? 'Porcentaje' : 'Monto fijo'}</label>
                      <div className={styles.amountInput}>
                        {firstPaymentType === 'percentage'
                          ? <Percent size={16} className={styles.dollarIcon} />
                          : <DollarSign size={16} className={styles.dollarIcon} />}
                        <NumberInput
                          step="0.01"
                          min="0"
                          value={firstPaymentValue}
                          onChange={(e) => {
                            setFirstPaymentValue(e.target.value)
                            setAutoDistributeRemaining(true)
                          }}
                          className={styles.input}
                        />
                      </div>
                    </div>
                    <div className={styles.manualField}>
                      <label>Fecha límite</label>
                      <div className={styles.dateInput}>
                        <PhoneDateField
                          value={firstPaymentDate}
                          min={toDateInputValue(new Date())}
                          onChange={setFirstPaymentDate}
                          title="Fecha límite"
                          buttonClassName={styles.phoneDateButton}
                        />
                      </div>
                    </div>
                    <div className={styles.manualField}>
                      <label>Método de pago</label>
                      {renderPaymentSelect({
                        value: firstPaymentMethod,
                        onChange: (value) => setFirstPaymentMethod(value as FirstPaymentMethod),
                        options: FIRST_PAYMENT_METHOD_OPTIONS,
                        title: 'Método de pago',
                        placeholder: 'Seleccionar método',
                        invalid: firstPaymentMethodMissing
                      })}
                    </div>
                  </div>
                  {firstPaymentMethodMissing && (
                    <div className={styles.fieldWarning} role="alert">
                      <AlertCircle size={14} />
                      <span>Selecciona el método de pago antes de continuar</span>
                    </div>
                  )}
                  <div className={styles.calcChip}>
                    <span>Monto del enganche</span>
                    <strong>{formatCurrency(firstPaymentAmount, currency)}</strong>
                  </div>
                </div>
              )}
            </div>

            <div className={styles.planStep}>
              <div className={styles.planStepHead}>
                <div className={styles.planStepTitle}>
                  <span className={styles.stepNumber}>2</span>
                  <div>
                    <p>Pagos restantes</p>
                    <span>Se cobran solos a la tarjeta del cliente.</span>
                  </div>
                </div>
                <span className={styles.autoTag}>
                  <ShieldCheck size={13} />
                  Automáticos
                </span>
              </div>

              <div className={styles.planStepBody}>
                <div className={styles.fieldGrid}>
                  {!firstPaymentEnabled && (
                    <div className={styles.manualField}>
                      <label>Tipo de valor</label>
                      {renderPaymentSelect({
                        value: remainingValueType,
                        onChange: (value) => {
                          setRemainingValueType(value as InstallmentValueType)
                          setAutoDistributeRemaining(true)
                        },
                        options: INSTALLMENT_VALUE_TYPE_OPTIONS,
                        title: 'Tipo de valor'
                      })}
                    </div>
                  )}
                  <div className={styles.manualField}>
                    <label>Frecuencia de cobro</label>
                    {renderPaymentSelect({
                      value: remainingFrequency,
                      onChange: (value) => setRemainingFrequency(value as RemainingFrequency),
                      options: remainingFrequencyOptions,
                      title: 'Frecuencia de cobro'
                    })}
                  </div>
                  <div className={styles.calcChip}>
                    <span>Suma de pagos restantes</span>
                    <strong>{formatCurrency(remainingTotalAmount, currency)}</strong>
                  </div>
                </div>

                <p className={styles.planHint}>
                  {remainingFrequency === 'custom'
                    ? `Ajusta ${effectiveRemainingValueType === 'percentage' ? 'el porcentaje' : 'el monto fijo'} y la fecha de cada pago.`
                    : 'Las fechas se calculan automáticamente. Cambia a “Personalizada” para editarlas a mano.'}
                </p>

                <div className={styles.installmentTable}>
                  <div className={styles.installmentHead}>
                    <span>#</span>
                    <span>Valor</span>
                    <span>Fecha de cobro</span>
                    <span className={styles.alignRight}>Monto</span>
                    <span aria-hidden="true" />
                  </div>

                  <div className={styles.installmentList}>
                    {resolvedRemainingInstallments.map((installment) => (
                      <div key={installment.id} className={styles.installmentRow}>
                        <div className={styles.installmentSeq}>{installment.sequence}</div>
                        <label className={styles.installmentCell}>
                          <span className={styles.cellLabel}>{effectiveRemainingValueType === 'percentage' ? 'Porcentaje' : 'Monto fijo'}</span>
                          <div className={styles.amountInput}>
                            {effectiveRemainingValueType === 'percentage'
                              ? <Percent size={16} className={styles.dollarIcon} />
                              : <DollarSign size={16} className={styles.dollarIcon} />}
                            <NumberInput
                              step="0.01"
                              min="0"
                              value={installment.value}
                              onChange={(e) => updateRemainingInstallment(installment.id, { value: e.target.value })}
                              className={styles.input}
                              aria-label={`${effectiveRemainingValueType === 'percentage' ? 'Porcentaje' : 'Monto fijo'} de parcialidad ${installment.sequence}`}
                            />
                          </div>
                        </label>
                        <label className={`${styles.installmentCell} ${styles.installmentDate}`}>
                          <span className={styles.cellLabel}>Fecha de cobro</span>
                          <PhoneDateField
                            value={installment.dueDate}
                            onChange={(value) => updateRemainingInstallment(installment.id, { dueDate: value })}
                            disabled={remainingFrequency !== 'custom'}
                            title={`Fecha de parcialidad ${installment.sequence}`}
                            ariaLabel={`Fecha de parcialidad ${installment.sequence}`}
                            buttonClassName={styles.phoneDateButton}
                          />
                        </label>
                        <div className={styles.installmentMonto}>
                          <span className={styles.cellLabel}>Monto</span>
                          <strong>{formatCurrency(installment.amount, currency)}</strong>
                        </div>
                        <button
                          type="button"
                          className={`${styles.iconButton} ${styles.installmentDelete}`}
                          onClick={() => removeRemainingInstallment(installment.id)}
                          disabled={remainingInstallments.length <= 1}
                          title="Eliminar parcialidad"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  className={styles.addInstallment}
                  onClick={addRemainingInstallment}
                >
                  <Plus size={16} />
                  Agregar pago
                </button>
              </div>
            </div>

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
              <span>
                {stripeConnected
                  ? (savedPaymentMethods.length > 0
                      ? 'En el siguiente paso eliges si Stripe usa una tarjeta guardada o si manda link de domiciliación para otra tarjeta.'
                      : firstPaymentEnabled && firstPaymentMethod === 'card'
                        ? 'Si el primer pago es con tarjeta/link de Stripe, esa tarjeta quedará guardada y activará los cobros futuros.'
                        : `Stripe enviará una liga de domiciliación por ${formatCurrency(cardSetupAmount, currency)}. El plan no se activa hasta que esa tarjeta quede autorizada.`)
                  : (partialNeedsCardAuthorization
                      ? `GoHighLevel validará si existe una tarjeta guardada. Si no existe, se enviará un cobro separado de ${formatCurrency(cardSetupAmount, currency)} para domiciliar. El plan no se activa hasta que esa tarjeta quede autorizada.`
                      : 'El primer pago con tarjeta autoriza la tarjeta en GoHighLevel. El plan no se activa hasta que ese pago sea exitoso y la tarjeta quede guardada.')}
              </span>
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
                {chargeType === 'product' ? 'Precios guardados' : 'Personalizado'}
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
      const stripeSavedCardLabel = stripePlanSavedPaymentMethod
        ? `Stripe usará ${getSavedCardDescription(stripePlanSavedPaymentMethod)} para los cobros programados.`
        : 'Selecciona una tarjeta guardada para programar este plan.'
      const stripeNewCardLabel = firstPaymentEnabled && firstPaymentMethod === 'card'
          ? 'Stripe enviará el primer link; cuando se pague, guardará la tarjeta y activará los cobros futuros.'
          : `Stripe enviará domiciliación por ${formatCurrency(cardSetupAmount, invoiceSummary.currency)}; al pagarse, guardará la tarjeta y activará el plan.`
      const stripeAuthorizationLabel = stripePlanCardSource === 'saved_card'
        ? stripeSavedCardLabel
        : stripeNewCardLabel
      const authorizationLabel = paymentOption === 'stripe'
        ? stripeAuthorizationLabel
        : partialNeedsCardAuthorization
          ? `GoHighLevel usará tarjeta guardada si existe; si no, enviará domiciliación por ${formatCurrency(cardSetupAmount, invoiceSummary.currency)}.`
          : 'El primer pago con tarjeta funcionará como autorización.'

      return (
        <div className={styles.optionsContent}>
          <div className={styles.summaryCard}>
            <div className={styles.summaryHeader}>
              <div>
                <span>Cliente</span>
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
                <span>Pagos restantes</span>
                <span>{resolvedRemainingInstallments.length} pagos programados</span>
              </div>
              <div className={styles.summaryRow}>
                <span>Autorización</span>
                <span className={styles.summaryNoteValue}>{authorizationLabel}</span>
              </div>
            </div>
          </div>

          <div className={styles.paymentOptions}>
            {stripeConnected && (
              <button
                type="button"
                className={`${styles.optionButton} ${paymentOption === 'stripe' && stripePlanCardSource === 'new_card' ? styles.optionButtonActive : ''}`}
                onClick={() => {
                  setPaymentOption('stripe')
                  setStripePlanCardSource('new_card')
                }}
              >
                <div className={styles.optionInfo}>
                  <div className={styles.optionIcon}>
                    <CreditCard size={18} />
                  </div>
                  <div>
                    <p>Enviar link para nueva tarjeta</p>
                    <span>{stripeNewCardLabel}</span>
                  </div>
                </div>

                {paymentOption === 'stripe' && stripePlanCardSource === 'new_card' && (
                  <Check size={18} className={styles.optionCheck} />
                )}
              </button>
            )}

            {stripeConnected && savedPaymentMethods.length > 0 && (
              <button
                type="button"
                className={`${styles.optionButton} ${paymentOption === 'stripe' && stripePlanCardSource === 'saved_card' ? styles.optionButtonActive : ''}`}
                onClick={() => {
                  setPaymentOption('stripe')
                  setStripePlanCardSource('saved_card')
                }}
              >
                <div className={styles.optionInfo}>
                  <div className={styles.optionIcon}>
                    <ShieldCheck size={18} />
                  </div>
                  <div>
                    <p>Usar tarjeta guardada</p>
                    <span>{stripeSavedCardLabel}</span>
                  </div>
                </div>

                {paymentOption === 'stripe' && stripePlanCardSource === 'saved_card' && (
                  <div className={styles.optionAction}>
                    <Check size={18} className={styles.optionCheck} />
                    {savedPaymentMethods.length > 1 && (
                      <div className={styles.savedCardSelector} onClick={(e) => e.stopPropagation()}>
                        <CustomSelect
                          value={selectedSavedPaymentMethodId}
                          onValueChange={setSelectedSavedPaymentMethodId}
                          options={savedPaymentMethodOptions}
                          portal
                        />
                      </div>
                    )}
                  </div>
                )}
              </button>
            )}

            {highLevelConnected && (
              <div
                className={`${styles.optionButton} ${paymentOption === 'send' ? styles.optionButtonActive : ''}`}
                onClick={() => setPaymentOption('send')}
              >
                <div className={styles.optionInfo}>
                  <div className={styles.optionIcon}>
                    <Send size={18} />
                  </div>
                  <div>
                    <p>Enviar enlace por</p>
                    <span>
                      {(!selectedContact?.email && !selectedContact?.phone) ? (
                        <span style={{ color: 'var(--color-status-error)' }}>Sin email ni teléfono</span>
                      ) : (
                        'Usa los canales del contacto'
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
          </div>
        </div>
      )
    }

    const showGatewayPicker = singlePaymentOptionsStage === 'gateway' && singlePaymentAction === 'payment_link' && hasMultiplePaymentLinkGateways
    const paymentLinkActionDescription = hasMultiplePaymentLinkGateways
      ? `Después eliges ${paymentLinkGatewayLabels.join(', ')}.`
      : defaultPaymentLinkOption === 'stripe'
        ? 'Usa Stripe para generar el enlace de pago.'
        : defaultPaymentLinkOption === 'mercadopago'
          ? 'Usa Mercado Pago Checkout Pro para generar el link.'
          : defaultPaymentLinkOption === 'send'
            ? 'Usa HighLevel para enviar el enlace al cliente.'
            : 'Conecta una pasarela para enviar enlaces de pago.'

    return (
      <div className={styles.optionsContent}>
        <div className={styles.summaryCard}>
          <div className={styles.summaryHeader}>
            <div>
              <span>Cliente</span>
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

        <div className={styles.paymentOptions}>
          {showGatewayPicker ? (
            <>
              {stripeConnected && (
                <button
                  type="button"
                  className={`${styles.optionButton} ${paymentOption === 'stripe' ? styles.optionButtonActive : ''}`}
                  onClick={() => setPaymentOption('stripe')}
                >
                  <div className={styles.optionInfo}>
                    <div className={styles.optionIcon}>
                      <CreditCard size={18} />
                    </div>
                    <div>
                      <p>Stripe</p>
                      <span>Genera tu página pública de invoice con campo seguro de tarjeta.</span>
                    </div>
                  </div>
                  {paymentOption === 'stripe' && <Check size={18} className={styles.optionCheck} />}
                </button>
              )}

              {mercadoPagoConnected && (
                <button
                  type="button"
                  className={`${styles.optionButton} ${paymentOption === 'mercadopago' ? styles.optionButtonActive : ''}`}
                  onClick={() => setPaymentOption('mercadopago')}
                >
                  <div className={styles.optionInfo}>
                    <div className={styles.optionIcon}>
                      <WalletCards size={18} />
                    </div>
                    <div>
                      <p>Mercado Pago</p>
                      <span>Genera tu página pública de pago con Mercado Pago integrado.</span>
                    </div>
                  </div>
                  {paymentOption === 'mercadopago' && <Check size={18} className={styles.optionCheck} />}
                </button>
              )}

              {highLevelConnected && (
                <div
                  className={`${styles.optionButton} ${paymentOption === 'send' ? styles.optionButtonActive : ''}`}
                  onClick={() => setPaymentOption('send')}
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
                          'Envía automáticamente al cliente.'
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
          ) : (
            <>
              {stripeConnected && savedPaymentMethods.length > 0 && (
                <button
                  type="button"
                  className={`${styles.optionButton} ${singlePaymentAction === 'saved_card' && paymentOption === 'stripe_saved_card' ? styles.optionButtonActive : ''}`}
                  onClick={() => {
                    setSinglePaymentAction('saved_card')
                    setPaymentOption('stripe_saved_card')
                  }}
                >
                  <div className={styles.optionInfo}>
                    <div className={styles.optionIcon}>
                      <ShieldCheck size={18} />
                    </div>
                    <div>
                      <p>Cobrar tarjeta guardada</p>
                      <span>{getSavedCardDescription(selectedSavedPaymentMethod || savedPaymentMethods[0])}</span>
                    </div>
                  </div>
                  {singlePaymentAction === 'saved_card' && paymentOption === 'stripe_saved_card' && (
                    <div className={styles.optionAction}>
                      <Check size={18} className={styles.optionCheck} />
                      {savedPaymentMethods.length > 1 && (
                        <div className={styles.savedCardSelector} onClick={(e) => e.stopPropagation()}>
                          <CustomSelect
                            value={selectedSavedPaymentMethodId}
                            onValueChange={setSelectedSavedPaymentMethodId}
                            options={savedPaymentMethodOptions}
                            portal
                          />
                        </div>
                      )}
                    </div>
                  )}
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
                  {singlePaymentAction === 'payment_link' && <Check size={18} className={styles.optionCheck} />}
                </button>
              )}

              <button
                type="button"
                className={`${styles.optionButton} ${singlePaymentAction === 'manual' && paymentOption === 'manual' ? styles.optionButtonActive : ''}`}
                onClick={() => {
                  setSinglePaymentAction('manual')
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

        {!showGatewayPicker && singlePaymentAction === 'manual' && paymentOption === 'manual' && (
          <div className={styles.manualFields}>
            <div className={styles.manualGrid}>
              <div className={styles.manualField}>
                <label>Fecha de pago</label>
                <PhoneDateField
                  value={manualPaymentData.paymentDate}
                  onChange={(value) => setManualPaymentData({ ...manualPaymentData, paymentDate: value })}
                  title="Fecha de pago"
                  buttonClassName={styles.phoneDateButton}
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
            {manualPaymentData.paymentMethod === 'bank_transfer' && (
              <div className={styles.manualTransferInfo}>
                <div className={styles.manualTransferHeader}>
                  <div className={styles.manualTransferIcon}>
                    <LinkIcon size={18} />
                  </div>
                  <div className={styles.manualTransferText}>
                    <p>Enlace para transferencias</p>
                    <span>Comparte este enlace con el cliente para completar el depósito.</span>
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
            )}
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

    const availableChannels = PAYMENT_LINK_DELIVERY_CHANNELS
      .map(channel => paymentLinkDeliveryOptions?.channels[channel])
      .filter((channel): channel is NonNullable<typeof channel> => Boolean(channel?.available))

    return (
      <div className={styles.paymentLinkReady}>
        <div className={styles.paymentLinkReadyHeader}>
          <div className={styles.paymentLinkReadyIcon}>
            <LinkIcon size={20} aria-hidden="true" />
          </div>
          <div className={styles.paymentLinkReadyTitle}>
            <p>{createdPaymentLink.title}</p>
            <span>{createdPaymentLink.description}</span>
          </div>
        </div>

        <div className={styles.paymentLinkMeta}>
          <div>
            <span>Cliente</span>
            <strong>{getContactDisplayName(createdPaymentLink.contact)}</strong>
          </div>
          <div>
            <span>Monto</span>
            <strong>{formatCurrency(createdPaymentLink.amount, createdPaymentLink.currency)}</strong>
          </div>
        </div>

        <div className={styles.paymentLinkBox}>
          <label>Enlace público de pago</label>
          <div className={styles.paymentLinkActions}>
            <div className={styles.paymentLinkUrl}>{createdPaymentLink.paymentUrl}</div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leftIcon={<Copy size={15} />}
              onClick={handleCopyCreatedPaymentLink}
            >
              Copiar
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leftIcon={<ExternalLink size={15} />}
              onClick={handleOpenCreatedPaymentLink}
            >
              Abrir
            </Button>
          </div>
        </div>

        <div className={styles.paymentLinkDelivery}>
          <div className={styles.paymentLinkDeliveryHeader}>
            <p>Enviar por</p>
            <span>Solo aparecen los canales conectados para este contacto.</span>
          </div>

          {loadingPaymentLinkDeliveryOptions ? (
            <div className={styles.paymentLinkDeliveryLoading}>
              <Loader2 size={16} aria-hidden="true" />
              Revisando canales...
            </div>
          ) : availableChannels.length > 0 ? (
            <div className={styles.paymentLinkChannelActions}>
              {availableChannels.map(channel => (
                <Button
                  key={channel.key}
                  type="button"
                  variant="secondary"
                  size="sm"
                  leftIcon={getPaymentLinkChannelIcon(channel.key)}
                  loading={sendingPaymentLinkChannel === channel.key}
                  disabled={Boolean(sendingPaymentLinkChannel)}
                  onClick={() => handleSendCreatedPaymentLink(channel.key)}
                >
                  {channel.label}
                </Button>
              ))}
            </div>
          ) : (
            <p className={styles.paymentLinkDeliveryEmpty}>
              Este contacto no tiene canales conectados para envío directo. Copia el enlace y mándalo manualmente.
            </p>
          )}
        </div>
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
            disabled={Boolean(sendingPaymentLinkChannel)}
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
      const requiresDeliveryChannel = paymentOption === 'send' && !needsGatewayChoice
      const lacksDeliveryChannel = requiresDeliveryChannel && !selectedContact?.email && !selectedContact?.phone
      const lacksSavedCard = paymentOption === 'stripe_saved_card' && !selectedSavedPaymentMethodId
      const lacksStripePlanSavedCard = paymentOption === 'stripe' &&
        activePaymentMode === 'partial' &&
        stripePlanCardSource === 'saved_card' &&
        !stripePlanSavedPaymentMethod
      const lacksStripePlanAuthorization = paymentOption === 'stripe' &&
        activePaymentMode === 'partial' &&
        !stripePlanCanBeAuthorized
      const stripePlanWillRegisterOfflineFirstPayment = firstPaymentEnabled && isOfflineFirstPaymentMethod(firstPaymentMethod)
      const confirmLabel = needsGatewayChoice
        ? 'Elegir pasarela'
        : paymentOption === 'stripe_saved_card'
        ? 'Cobrar tarjeta'
        : paymentOption === 'stripe' && activePaymentMode === 'partial'
          ? stripePlanCardSource === 'saved_card'
            ? 'Programar con tarjeta'
            : stripePlanWillRegisterOfflineFirstPayment
              ? 'Registrar pago y enviar enlace de domiciliación'
              : 'Crear link de domiciliación'
        : paymentOption === 'stripe'
        ? 'Crear link Stripe'
        : paymentOption === 'mercadopago'
          ? 'Crear link Mercado Pago'
        : paymentOption === 'send'
          ? activePaymentMode === 'partial' ? 'Crear y enviar enlace' : 'Enviar enlace'
          : 'Registrar pago'

      return (
        <div className={styles.footer} data-modal-footer="">
          {!isEmbedded && (
            <Button
              variant="secondary"
              onClick={() => {
                if (activePaymentMode !== 'partial' && singlePaymentOptionsStage === 'gateway') {
                  setSinglePaymentOptionsStage('method')
                  return
                }
                returnToPaymentForm()
              }}
              disabled={loading}
            >
              Regresar
            </Button>
          )}
          <div className={styles.confirmButtonWrapper}>
            <Button
              variant="primary"
              onClick={() => {
                if (needsGatewayChoice) {
                  setSinglePaymentOptionsStage('gateway')
                  return
                }
                handleConfirm()
              }}
              disabled={
                loading ||
                lacksDeliveryChannel ||
                lacksSavedCard ||
                lacksStripePlanSavedCard ||
                lacksStripePlanAuthorization
              }
              title={
                lacksDeliveryChannel
                  ? 'El contacto no tiene email ni teléfono para enviar el enlace'
                  : lacksSavedCard
                    ? 'Selecciona una tarjeta guardada'
                  : lacksStripePlanSavedCard
                    ? 'Selecciona una tarjeta guardada para el plan'
                  : lacksStripePlanAuthorization
                    ? 'Usa una tarjeta guardada o marca el primer pago como tarjeta/link'
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
      <div className={`${styles.embeddedRoot} ${showEmbeddedBackButton ? '' : styles.embeddedRootNoBack}`}>
        {showEmbeddedBackButton && step !== 'processing' && (
          <button
            type="button"
            className={styles.embeddedBackButton}
            onClick={handleEmbeddedBack}
          >
            <ChevronLeft size={20} aria-hidden="true" />
            <span>Atrás</span>
          </button>
        )}
        <div ref={embeddedScrollRef} className={styles.embeddedScroll} data-phone-chat-scrollable="true" data-phone-scrollable="true">
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
          ? activePaymentMode !== 'partial' && singlePaymentOptionsStage === 'gateway'
            ? 'Elige pasarela'
            : 'Elige cómo cobrar'
          : activePaymentMode === 'partial' ? 'Registrar cobro parcial' : 'Registrar nuevo cobro'
      }
      size="md"
      type="custom"
      flushContent
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
