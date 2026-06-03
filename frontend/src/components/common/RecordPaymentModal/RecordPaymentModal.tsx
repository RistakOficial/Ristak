import React, { useEffect, useMemo, useState } from 'react'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { TabList } from '../TabList'
import { CustomSelect } from '../CustomSelect'
import {
  Search,
  Loader2,
  X,
  DollarSign,
  Link as LinkIcon,
  Check,
  AlertCircle,
  Send,
  Calendar,
  Percent,
  Plus,
  Trash2,
  ShieldCheck
} from 'lucide-react'
import styles from './RecordPaymentModal.module.css'
import { useNotification } from '@/contexts/NotificationContext'
import { formatCurrency as formatMxCurrency } from '@/utils/format'
import { highLevelService } from '@/services/highLevelService'
import { transactionsService } from '@/services/transactionsService'

const IVA_RATE = 0.16
const DEFAULT_INVOICE_TITLE = 'Pago'
const CONTACT_SEARCH_DELAY_MS = 90

const formatCurrency = (value: number, _currency = 'MXN'): string => formatMxCurrency(value)

const normalizeAmount = (value: string | number): number => {
  if (typeof value === 'number') {
    return Math.round(value * 100) / 100
  }
  if (!value) return 0
  const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''))
  if (Number.isNaN(parsed)) return 0
  return Math.round(parsed * 100) / 100
}

type PaymentOption = 'send' | 'manual'
type PaymentMode = 'single' | 'partial'
type InstallmentValueType = 'percentage' | 'amount'
type FirstPaymentMethod = '' | 'cash' | 'bank_transfer' | 'deposit' | 'card'
type RemainingFrequency = 'custom' | 'weekly' | 'biweekly' | 'monthly'
type SendMethod = 'whatsapp' | 'sms' | 'email' | 'email_whatsapp' | 'email_sms' | 'all'
type InvoiceSendMethod = 'email' | 'sms' | 'both'

interface InstallmentDraft {
  id: string
  type: InstallmentValueType
  value: string
  dueDate: string
}

interface RecordPaymentModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess?: () => void
  initialPaymentMode?: PaymentMode
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
  name: string
  description?: string
}

interface Price {
  _id: string
  id: string
  name: string
  amount: number
  price: number
  currency: string
}

interface InvoiceSummary {
  contactId: string
  contactName: string
  contactEmail?: string
  amount: number
  subtotal: number
  taxAmount: number
  includesTax: boolean
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
      type: 'percentage',
      value: '30',
      dueDate: toDateInputValue(addMonths(today, 1))
    },
    {
      id: createInstallmentId(),
      type: 'percentage',
      value: '30',
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

const formatPercentValue = (value: number) => {
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

const isOfflineFirstPaymentMethod = (method: FirstPaymentMethod) => (
  method === 'cash' || method === 'bank_transfer' || method === 'deposit'
)

export const RecordPaymentModal: React.FC<RecordPaymentModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  initialPaymentMode = 'single',
  variant = 'modal'
}) => {
  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState<'form' | 'options' | 'processing'>('form')

  // Contact search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchingContact, setSearchingContact] = useState(false)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [showContactDropdown, setShowContactDropdown] = useState(false)

  // Charge type
  const [chargeType, setChargeType] = useState<'direct' | 'product'>('direct')

  // Direct charge
  const [amount, setAmount] = useState('')
  const [paymentTitle, setPaymentTitle] = useState('')
  const [description, setDescription] = useState('')
  const [currency, setCurrency] = useState('MXN')
  const [includeIVA, setIncludeIVA] = useState(false)

  // Partial payments
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('single')
  const [firstPaymentEnabled, setFirstPaymentEnabled] = useState(true)
  const [firstPaymentType, setFirstPaymentType] = useState<InstallmentValueType>('percentage')
  const [firstPaymentValue, setFirstPaymentValue] = useState('40')
  const [firstPaymentDate, setFirstPaymentDate] = useState(toDateInputValue(new Date()))
  const [firstPaymentMethod, setFirstPaymentMethod] = useState<FirstPaymentMethod>('')
  const [remainingAutomatic, setRemainingAutomatic] = useState(true)
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

  // Payment options
  const [invoicePayload, setInvoicePayload] = useState<Record<string, any> | null>(null)
  const [invoiceSummary, setInvoiceSummary] = useState<InvoiceSummary | null>(null)
  const [paymentOption, setPaymentOption] = useState<PaymentOption>('send')
  const [sendMethod, setSendMethod] = useState<SendMethod>(DEFAULT_SEND_METHOD)
  const [manualPaymentData, setManualPaymentData] = useState<ManualPaymentData>(defaultManualPaymentData)
  const [transferInfoUrl, setTransferInfoUrl] = useState<string | null>(null)

  const { showToast } = useNotification()

  const canChoosePaymentMode = chargeType === 'direct' || Boolean(selectedProduct && selectedPrice)
  const activePaymentMode: PaymentMode = canChoosePaymentMode ? paymentMode : 'single'
  const subtotalAmount = useMemo(() => (
    chargeType === 'product'
      ? normalizeAmount(customAmount)
      : normalizeAmount(amount)
  ), [amount, chargeType, customAmount])

  const taxAmount = includeIVA ? normalizeAmount(subtotalAmount * IVA_RATE) : 0
  const totalAmount = includeIVA ? normalizeAmount(subtotalAmount + taxAmount) : subtotalAmount
  const firstPaymentAmount = firstPaymentEnabled
    ? resolvePartialAmount(firstPaymentType, firstPaymentValue, totalAmount)
    : 0
  const resolvedRemainingInstallments = useMemo(() => {
    return remainingInstallments.map((installment, index) => ({
      ...installment,
      sequence: index + 1,
      amount: resolvePartialAmount(installment.type, installment.value, totalAmount),
      percentage: installment.type === 'percentage' ? normalizeAmount(installment.value) : null
    }))
  }, [remainingInstallments, totalAmount])
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

  useEffect(() => {
    if (sendMethodOptions.length === 0) return
    if (!selectedSendMethodOption) {
      setSendMethod(getDefaultSendMethod(sendMethodOptions))
    }
  }, [sendMethodOptions, selectedSendMethodOption])

  const resetForm = () => {
    setStep('form')
    setLoading(false)
    setSearchQuery('')
    setSearchingContact(false)
    setContacts([])
    setSelectedContact(null)
    setShowContactDropdown(false)
    setChargeType('direct')
    setAmount('')
    setPaymentTitle('')
    setDescription('')
    setCurrency('MXN')
    setIncludeIVA(false)
    setPaymentMode(initialPaymentMode)
    setFirstPaymentEnabled(true)
    setFirstPaymentType('percentage')
    setFirstPaymentValue('40')
    setFirstPaymentDate(toDateInputValue(new Date()))
    setFirstPaymentMethod('')
    setRemainingAutomatic(true)
    setRemainingFrequency('monthly')
    setRemainingInstallments(defaultPartialInstallments())
    setAutoDistributeRemaining(true)
    setSelectedProduct(null)
    setSelectedPrice(null)
    setPrices([])
    setProducts([])
    setCustomAmount('')
    setInvoicePayload(null)
    setInvoiceSummary(null)
    setPaymentOption('send')
    setSendMethod(DEFAULT_SEND_METHOD)
    setManualPaymentData(defaultManualPaymentData())
  }

  const loadConfig = async () => {
    try {
      const response = await fetch('/api/highlevel/config')
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

  useEffect(() => {
    if (!isOpen) {
      resetForm()
      return
    }

    resetForm()
    loadConfig()
  }, [isOpen, initialPaymentMode])

  // Search contacts
  useEffect(() => {
    const query = searchQuery.trim()

    if (query.length < 2) {
      setContacts([])
      setShowContactDropdown(false)
      setSearchingContact(false)
      return
    }

    const controller = new AbortController()
    setSearchingContact(true)
    setShowContactDropdown(true)

    const timer = window.setTimeout(async () => {
      setSearchingContact(true)
      try {
        const response = await fetch('/api/highlevel/contacts/search', {
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

        const formattedContacts = (data.contacts || []).map((contact: any) => ({
          id: contact.id,
          name: contact.name || 'Sin nombre',
          email: contact.email || '',
          phone: contact.phone || '',
          firstName: contact.firstName || '',
          lastName: contact.lastName || ''
        }))

        if (!controller.signal.aborted) {
          setContacts(formattedContacts)
          setShowContactDropdown(true)
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
    }, CONTACT_SEARCH_DELAY_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [searchQuery])

  useEffect(() => {
    if (isOpen && chargeType === 'product' && products.length === 0) {
      loadProducts()
    }
  }, [isOpen, chargeType])

  useEffect(() => {
    if (selectedProduct) {
      loadPrices(selectedProduct.id || selectedProduct._id)
    }
  }, [selectedProduct])

  useEffect(() => {
    if (selectedPrice) {
      const priceAmount = selectedPrice.amount || selectedPrice.price
      setCustomAmount(priceAmount ? String(priceAmount) : '')
      setCurrency(selectedPrice.currency || 'MXN')
    }
  }, [selectedPrice])

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
      const percentages = getRemainingPercentages(
        prev.length,
        firstPaymentEnabled,
        firstPaymentType,
        firstPaymentValue,
        totalAmount
      )

      return prev.map((installment, index) => ({
        ...installment,
        type: 'percentage',
        value: formatPercentValue(percentages[index] || 0)
      }))
    })
  }, [
    autoDistributeRemaining,
    firstPaymentEnabled,
    firstPaymentType,
    firstPaymentValue,
    activePaymentMode,
    remainingInstallments.length,
    totalAmount
  ])

  const loadProducts = async () => {
    setLoadingProducts(true)
    try {
      const response = await fetch('/api/highlevel/products?limit=100')
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
      const response = await fetch(`/api/highlevel/products/${productId}/prices`)
      if (!response.ok) throw new Error('Error al obtener precios')
      const data = await response.json()
      setPrices(data.prices || [])
    } catch (error) {
      showToast('error', 'No se pudieron cargar los precios')
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
    setContacts([])
  }

  const handleClearContact = () => {
    setSelectedContact(null)
    setSearchQuery('')
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
          type: 'percentage',
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

  const submitPartialFlow = async (
    payload: Record<string, any>,
    summary: InvoiceSummary,
    channels: Record<string, boolean>
  ) => {
    const response = await fetch('/api/highlevel/payment-flows/installments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPartialFlowPayload(payload, summary, channels))
    })

    const data = await response.json()
    if (!response.ok) {
      throw new Error(data.error || 'No se pudo crear el flujo de parcialidades')
    }

    const statusMessage = data.currentState === 'waiting_card_authorization'
      ? 'Parcialidades creadas. El sistema esperará la autorización de tarjeta antes de activar los pagos automáticos.'
      : 'Parcialidades creadas correctamente.'

    showToast('success', 'Éxito', statusMessage)

    onSuccess?.()
    onClose()
  }

  const buildInvoicePayload = (preparedTaxAmount: number, finalCurrency: string, contactName: string, invoiceTitle: string, items: any[], contactId: string, contactEmail: string, contactPhone: string) => {
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
      ...(includeIVA && {
        tax: {
          name: 'IVA',
          rate: IVA_RATE * 100,
          amount: preparedTaxAmount
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
      let finalCurrency = currency
      let subtotal = 0
      const resolvedTitle = paymentTitle.trim() || DEFAULT_INVOICE_TITLE
      const resolvedDescription = description.trim()

      if (chargeType === 'product' && selectedProduct && selectedPrice) {
        const parsedAmount = normalizeAmount(customAmount)
        subtotal = parsedAmount
        finalCurrency = selectedPrice.currency || currency

        items = [
          {
            name: selectedProduct.name,
            description: resolvedDescription || selectedProduct.description || selectedPrice.name || selectedProduct.name || resolvedTitle,
            priceId: selectedPrice.id || selectedPrice._id,
            productId: selectedProduct.id || selectedProduct._id,
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
            currency
          }
        ]
      }

      const taxAmount = includeIVA ? normalizeAmount(subtotal * IVA_RATE) : 0
      const totalAmount = includeIVA ? normalizeAmount(subtotal + taxAmount) : subtotal

      const payload = buildInvoicePayload(
        taxAmount,
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
        subtotal,
        taxAmount,
        includesTax: includeIVA,
        currency: finalCurrency,
        description: resolvedDescription || (chargeType === 'product' && selectedProduct ? selectedProduct.name : resolvedTitle)
      }

      setInvoicePayload(payload)
      setInvoiceSummary(summary)

      if (activePaymentMode === 'partial') {
        setPaymentOption('send')
        setStep('options')
        return
      }

      setManualPaymentData(defaultManualPaymentData())
      setPaymentOption('send')

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

    try {
      if (paymentMode === 'partial') {
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

        const response = await fetch('/api/highlevel/invoices', {
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
          const response = await fetch(`/api/highlevel/invoices/${invoiceId}/record-payment`, {
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
        await fetch(`/api/highlevel/invoices/${invoiceId}/sync`, { method: 'POST' })
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
            dueDate: invoicePayload.dueDate
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

    const taxAmount = includeIVA ? normalizeAmount(subtotalAmount * IVA_RATE) : 0
    const totalAmount = includeIVA ? normalizeAmount(subtotalAmount + taxAmount) : subtotalAmount

    const renderPaymentModeField = () => (
      <div className={styles.field}>
        <label className={styles.label}>Tipo de pago</label>
        <div style={{ marginTop: '4px' }}>
          <TabList
            tabs={[
              { value: 'single', label: 'Único' },
              { value: 'partial', label: 'Parcialidades' }
            ]}
            activeTab={paymentMode}
            onTabChange={(value) => {
              const nextPaymentMode = value as PaymentMode
              if (nextPaymentMode === 'partial' && paymentMode !== 'partial') {
                setFirstPaymentMethod('')
              }
              setPaymentMode(nextPaymentMode)
            }}
            variant="compact"
            className={styles.fullWidthTabList}
          />
        </div>
      </div>
    )

    return (
      <div className={styles.content}>
        <div className={styles.field}>
          <label className={styles.label}>Cliente</label>

          {selectedContact ? (
            <div className={styles.selectedContact}>
              <div className={styles.contactInfo}>
                <p className={styles.contactName}>{selectedContact.name || 'Sin nombre'}</p>
                <p className={styles.contactDetail}>{selectedContact.email || selectedContact.phone}</p>
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
                />
                {searchingContact && <Loader2 size={16} className={styles.loadingIcon} />}
              </div>

              {showContactDropdown && (
                <div className={styles.dropdown}>
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
                        onClick={() => handleSelectContact(contact)}
                      >
                        <p className={styles.dropdownName}>{contact.name || 'Sin nombre'}</p>
                        <p className={styles.dropdownDetail}>
                          {contact.email || contact.phone || 'Sin información de contacto'}
                        </p>
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

        <div className={styles.field}>
          <label className={styles.label}>Tipo de cobro</label>
          <div style={{ marginTop: '4px' }}>
            <TabList
              tabs={[
                { value: 'direct', label: 'Cobro directo' },
                { value: 'product', label: 'Productos guardados' }
              ]}
              activeTab={chargeType}
              onTabChange={(value) => {
                if (value === 'direct') {
                  setChargeType('direct')
                  setSelectedProduct(null)
                  setSelectedPrice(null)
                  setPrices([])
                  setCustomAmount('')
                  setCurrency('MXN')
                } else {
                  setChargeType('product')
                  setAmount('')
                }
              }}
              variant="compact"
              className={styles.fullWidthTabList}
            />
          </div>
        </div>

        {chargeType === 'direct' && renderPaymentModeField()}

        {chargeType === 'product' && (
          <>
            <div className={styles.field}>
              <label className={styles.label}>Producto</label>
              <CustomSelect
                options={[
                  { value: '', label: 'Selecciona un producto' },
                  ...products.map((product) => ({
                    value: product.id || product._id || '',
                    label: product.name
                  }))
                ]}
                value={selectedProduct?.id || selectedProduct?._id || ''}
                onChange={(value) => {
                  const product = products.find(p => (p.id || p._id) === value)
                  setSelectedProduct(product || null)
                  setSelectedPrice(null)
                  setPrices([])
                }}
                disabled={loadingProducts}
                placeholder="Selecciona un producto"
              />
              {loadingProducts && <p className={styles.hint}>Cargando productos...</p>}
            </div>

            {selectedProduct && (
              <div className={styles.field}>
                <label className={styles.label}>Precio</label>
                <CustomSelect
                  options={[
                    { value: '', label: 'Selecciona un precio' },
                    ...prices.map((price) => ({
                      value: price.id || price._id || '',
                      label: `${price.name || 'Precio'} - ${formatCurrency(price.amount || price.price, price.currency)}`
                    }))
                  ]}
                  value={selectedPrice?.id || selectedPrice?._id || ''}
                  onChange={(value) => {
                    const price = prices.find(p => (p.id || p._id) === value)
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
                    <input
                      type="number"
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
              <input
                type="number"
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

        <div className={styles.field}>
          <label className={styles.label}>IVA</label>
          <div style={{ marginTop: '4px' }}>
            <TabList
              tabs={[
                { value: 'sin', label: 'Sin IVA' },
                { value: 'con', label: 'Aplicar IVA 16%' }
              ]}
              activeTab={includeIVA ? 'con' : 'sin'}
              onTabChange={(value) => setIncludeIVA(value === 'con')}
              variant="compact"
              className={styles.fullWidthTabList}
            />
          </div>
        </div>

        {activePaymentMode === 'partial' && (
          <div className={styles.planSection}>
            <div className={styles.planIntro}>
              <div className={styles.planIntroText}>
                <p>Plan de parcialidades</p>
                <span>Define el enganche y los cobros automáticos hasta cubrir el total.</span>
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
                    <span>El enganche con el que arranca el plan.</span>
                  </div>
                </div>
                <TabList
                  tabs={[
                    { value: 'yes', label: 'Con enganche' },
                    { value: 'no', label: 'Sin enganche' }
                  ]}
                  activeTab={firstPaymentEnabled ? 'yes' : 'no'}
                  onTabChange={(value) => {
                    setFirstPaymentEnabled(value === 'yes')
                    setAutoDistributeRemaining(true)
                  }}
                  variant="compact"
                />
              </div>

              {firstPaymentEnabled && (
                <div className={styles.planStepBody}>
                  <div className={styles.fieldGrid}>
                    <div className={styles.manualField}>
                      <label>Tipo de valor</label>
                      <select
                        value={firstPaymentType}
                        onChange={(e) => {
                          setFirstPaymentType(e.target.value as InstallmentValueType)
                          setAutoDistributeRemaining(true)
                        }}
                        className={styles.select}
                      >
                        <option value="percentage">Porcentaje</option>
                        <option value="amount">Monto fijo</option>
                      </select>
                    </div>
                    <div className={styles.manualField}>
                      <label>{firstPaymentType === 'percentage' ? 'Porcentaje' : 'Monto'}</label>
                      <div className={styles.amountInput}>
                        {firstPaymentType === 'percentage'
                          ? <Percent size={16} className={styles.dollarIcon} />
                          : <DollarSign size={16} className={styles.dollarIcon} />}
                        <input
                          type="number"
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
                        <Calendar size={16} className={styles.dollarIcon} />
                        <input
                          type="date"
                          value={firstPaymentDate}
                          min={toDateInputValue(new Date())}
                          onChange={(e) => setFirstPaymentDate(e.target.value)}
                          className={styles.input}
                        />
                      </div>
                    </div>
                    <div className={styles.manualField}>
                      <label>Método de pago</label>
                      <select
                        value={firstPaymentMethod}
                        onChange={(e) => setFirstPaymentMethod(e.target.value as FirstPaymentMethod)}
                        className={`${styles.select} ${firstPaymentMethodMissing ? styles.selectError : ''}`}
                        aria-invalid={firstPaymentMethodMissing}
                      >
                        <option value="" disabled>Seleccionar método</option>
                        <option value="bank_transfer">Transferencia</option>
                        <option value="cash">Efectivo</option>
                        <option value="deposit">Depósito</option>
                        <option value="card">Tarjeta / link</option>
                      </select>
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
                  <div className={styles.manualField}>
                    <label>Frecuencia de cobro</label>
                    <select
                      value={remainingFrequency}
                      onChange={(e) => setRemainingFrequency(e.target.value as RemainingFrequency)}
                      className={styles.select}
                    >
                      <option value="monthly">Mensual</option>
                      <option value="biweekly">Quincenal</option>
                      <option value="weekly">Semanal</option>
                      <option value="custom">Personalizada</option>
                    </select>
                  </div>
                  <div className={styles.calcChip}>
                    <span>Suma de pagos restantes</span>
                    <strong>{formatCurrency(remainingTotalAmount, currency)}</strong>
                  </div>
                </div>

                <p className={styles.planHint}>
                  {remainingFrequency === 'custom'
                    ? 'Ajusta el monto y la fecha de cada pago. El valor en % o $ se aplica sobre el total.'
                    : 'Las fechas se calculan automáticamente. Cambia a “Personalizada” para editarlas a mano.'}
                </p>

                <div className={styles.installmentTable}>
                  <div className={styles.installmentHead}>
                    <span>#</span>
                    <span>Tipo</span>
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
                          <span className={styles.cellLabel}>Tipo</span>
                          <select
                            value={installment.type}
                            onChange={(e) => updateRemainingInstallment(installment.id, { type: e.target.value as InstallmentValueType })}
                            className={styles.select}
                          >
                            <option value="percentage">%</option>
                            <option value="amount">$</option>
                          </select>
                        </label>
                        <label className={styles.installmentCell}>
                          <span className={styles.cellLabel}>Valor</span>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={installment.value}
                            onChange={(e) => updateRemainingInstallment(installment.id, { value: e.target.value })}
                            className={styles.input}
                            aria-label={`Valor de parcialidad ${installment.sequence}`}
                          />
                        </label>
                        <label className={`${styles.installmentCell} ${styles.installmentDate}`}>
                          <span className={styles.cellLabel}>Fecha de cobro</span>
                          <input
                            type="date"
                            value={installment.dueDate}
                            onChange={(e) => updateRemainingInstallment(installment.id, { dueDate: e.target.value })}
                            className={styles.input}
                            disabled={remainingFrequency !== 'custom'}
                            aria-label={`Fecha de parcialidad ${installment.sequence}`}
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
                {partialNeedsCardAuthorization
                  ? `GoHighLevel validará si existe una tarjeta guardada. Si no existe, se enviará un cobro separado de ${formatCurrency(cardSetupAmount, currency)} para domiciliar. El plan no se activa hasta que esa tarjeta quede autorizada.`
                  : 'El primer pago con tarjeta autoriza la tarjeta en GoHighLevel. El plan no se activa hasta que ese pago sea exitoso y la tarjeta quede guardada.'}
              </span>
            </div>
          </div>
        )}

        <div className={styles.summaryCard}>
          <div className={styles.summaryHeader}>
            <span>Resumen del cobro</span>
            <span className={styles.summaryBadge}>
              {chargeType === 'product' ? 'Producto' : 'Cobro directo'}
            </span>
          </div>
          <div className={styles.summaryBody}>
            <div className={styles.summaryRow}>
              <span>Subtotal</span>
              <span>{formatCurrency(subtotalAmount, currency)}</span>
            </div>
            {includeIVA && (
              <div className={styles.summaryRow}>
                <span>IVA (16%)</span>
                <span className={styles.summaryTax}>+ {formatCurrency(taxAmount, currency)}</span>
              </div>
            )}
          </div>
          <div className={styles.summaryFooter}>
            <span>Total a cobrar</span>
            <span className={styles.summaryTotal}>{formatCurrency(totalAmount, currency)}</span>
          </div>
        </div>
      </div>
    )
  }

  const renderPaymentOptions = () => {
    if (!invoiceSummary) return null

    if (paymentMode === 'partial') {
      const authorizationLabel = partialNeedsCardAuthorization
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
                <span>{resolvedRemainingInstallments.length} pagos automáticos</span>
              </div>
              <div className={styles.summaryRow}>
                <span>Autorización</span>
                <span className={styles.summaryNoteValue}>{authorizationLabel}</span>
              </div>
            </div>
          </div>

          <div className={styles.paymentOptions}>
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
                        onChange={(value) => setSendMethod(value as SendMethod)}
                        options={sendMethodOptions}
                        portal
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )
    }

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
                <span>IVA (16%)</span>
                <span className={styles.summaryTax}>+ {formatCurrency(invoiceSummary.taxAmount, invoiceSummary.currency)}</span>
              </div>
            </div>
          ) : (
            <p className={styles.summaryDetail}>Este cobro no incluye IVA</p>
          )}
          {invoiceSummary.description && (
            <div className={styles.summaryDescription}>
              <span>Concepto</span>
              <p>{invoiceSummary.description}</p>
            </div>
          )}
        </div>

        <div className={styles.paymentOptions}>
          {/* Enviar enlace de pago por... (con selector integrado) */}
          <div
            className={`${styles.optionButton} ${paymentOption === 'send' ? styles.optionButtonActive : ''}`}
            onClick={() => setPaymentOption('send')}
          >
            <div className={styles.optionInfo}>
              <div className={styles.optionIcon}>
                <Send size={18} />
              </div>
              <div>
                <p>Enviar enlace de pago por</p>
                <span>
                  {(!selectedContact?.email && !selectedContact?.phone) ? (
                    <span style={{ color: 'var(--color-status-error)' }}>⚠️ Sin email ni teléfono</span>
                  ) : (
                    'Envía automáticamente al cliente'
                  )}
                </span>
              </div>
            </div>
            {/* Selector integrado en el mismo botón */}
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
                      onChange={(value) => setSendMethod(value as SendMethod)}
                      options={sendMethodOptions}
                      portal
                    />
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Registrar pago manual */}
          <button
            type="button"
            className={`${styles.optionButton} ${paymentOption === 'manual' ? styles.optionButtonActive : ''}`}
            onClick={() => setPaymentOption('manual')}
          >
            <div className={styles.optionInfo}>
              <div className={styles.optionIcon}>
                <DollarSign size={18} />
              </div>
              <div>
                <p>Registrar pago manual</p>
                <span>Marca el invoice como pagado (efectivo, transferencia, etc.)</span>
              </div>
            </div>
            {paymentOption === 'manual' && <Check size={18} className={styles.optionCheck} />}
          </button>
        </div>

        {paymentOption === 'manual' && (
          <div className={styles.manualFields}>
            <div className={styles.manualGrid}>
              <div className={styles.manualField}>
                <label>Fecha de pago</label>
                <input
                  type="date"
                  value={manualPaymentData.paymentDate}
                  onChange={(e) => setManualPaymentData({ ...manualPaymentData, paymentDate: e.target.value })}
                  className={styles.input}
                />
              </div>
              <div className={styles.manualField}>
                <label>Método de pago</label>
                <select
                  value={manualPaymentData.paymentMethod}
                  onChange={(e) => setManualPaymentData({ ...manualPaymentData, paymentMethod: e.target.value })}
                  className={styles.select}
                >
                  <option value="cash">Efectivo</option>
                  <option value="bank_transfer">Transferencia bancaria</option>
                  <option value="card">Tarjeta</option>
                  <option value="check">Cheque</option>
                  <option value="other">Otro</option>
                </select>
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
                  placeholder="Numero de transferencia, cheque, etc."
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

  const renderFooter = () => {
    if (step === 'processing') {
      return null
    }

    if (step === 'options') {
      const requiresDeliveryChannel = paymentOption === 'send'
      const lacksDeliveryChannel = requiresDeliveryChannel && !selectedContact?.email && !selectedContact?.phone
      const confirmLabel = paymentOption === 'send'
        ? activePaymentMode === 'partial' ? 'Crear y enviar enlace' : 'Enviar enlace'
        : 'Registrar pago'

      return (
        <div className={styles.footer}>
          <Button
            variant="secondary"
            onClick={() => {
              setStep('form')
              setInvoicePayload(null)
              setInvoiceSummary(null)
              setPaymentOption('send')
            }}
            disabled={loading}
          >
            Regresar
          </Button>
          <div className={styles.confirmButtonWrapper}>
            <Button
              variant="primary"
              onClick={() => handleConfirm()}
              disabled={
                loading ||
                lacksDeliveryChannel
              }
              title={
                lacksDeliveryChannel
                  ? 'El contacto no tiene email ni teléfono para enviar el enlace'
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
          </div>
        </div>
      )
    }

    return (
      <div className={styles.footer}>
        <Button
          variant="secondary"
          onClick={onClose}
          disabled={loading}
        >
          Cancelar
        </Button>
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
      <div className={styles.embeddedRoot}>
        <div className={styles.embeddedScroll} data-phone-scrollable="true">
          {step === 'processing' && renderProcessing()}
          {step === 'form' && renderForm()}
          {step === 'options' && renderPaymentOptions()}
        </div>
        {renderFooter()}
      </div>
    )
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        step === 'options'
          ? 'Elige cómo cobrar'
          : activePaymentMode === 'partial' ? 'Registrar cobro parcial' : 'Registrar nuevo cobro'
      }
      size="md"
      type="custom"
      showCloseButton={step !== 'processing'}
    >
      {step === 'processing' && renderProcessing()}
      {step === 'form' && renderForm()}
      {step === 'options' && renderPaymentOptions()}
      {renderFooter()}
    </Modal>
  )
}
