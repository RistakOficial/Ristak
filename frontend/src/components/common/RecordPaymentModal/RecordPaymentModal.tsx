import React, { useEffect, useState } from 'react'
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
  CreditCard,
  Check,
  AlertCircle
} from 'lucide-react'
import styles from './RecordPaymentModal.module.css'
import { useNotification } from '@/contexts/NotificationContext'
import { formatCurrency } from '@/utils/format'

const IVA_RATE = 0.16

const normalizeAmount = (value: string | number): number => {
  if (typeof value === 'number') {
    return Math.round(value * 100) / 100
  }
  if (!value) return 0
  const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''))
  if (Number.isNaN(parsed)) return 0
  return Math.round(parsed * 100) / 100
}

type PaymentOption = 'link' | 'saved' | 'manual'

interface RecordPaymentModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess?: () => void
}

interface Contact {
  id: string
  name: string
  email: string
  phone: string
  firstName?: string
  lastName?: string
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

interface PaymentMethod {
  id: string
  brand: string
  last4: string
  expMonth: number
  expYear: number
  createdAt: string | null
}

const defaultManualPaymentData = (): ManualPaymentData => ({
  paymentDate: new Date().toISOString().split('T')[0],
  paymentMethod: 'bank_transfer',
  reference: '',
  notes: ''
})

export const RecordPaymentModal: React.FC<RecordPaymentModalProps> = ({
  isOpen,
  onClose,
  onSuccess
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
  const [description, setDescription] = useState('')
  const [currency, setCurrency] = useState('MXN')
  const [includeIVA, setIncludeIVA] = useState(false)

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
  const [invoiceTitle, setInvoiceTitle] = useState('PAGO')
  const [invoiceTermsNotes, setInvoiceTermsNotes] = useState<string | null>(null)
  const [invoiceDueDays, setInvoiceDueDays] = useState(7)

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
  const [paymentOption, setPaymentOption] = useState<PaymentOption>('link')
  const [checkingCards, setCheckingCards] = useState(false)
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([])
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<string | null>(null)
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [manualPaymentData, setManualPaymentData] = useState<ManualPaymentData>(defaultManualPaymentData)
  const [transferInfoUrl, setTransferInfoUrl] = useState<string | null>(null)

  // Stripe connection status
  const [stripeConnected, setStripeConnected] = useState(false)
  const [checkingStripe, setCheckingStripe] = useState(true)

  const { showToast } = useNotification()

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
    setDescription('')
    setCurrency('MXN')
    setIncludeIVA(false)
    setSelectedProduct(null)
    setSelectedPrice(null)
    setPrices([])
    setProducts([])
    setCustomAmount('')
    setInvoicePayload(null)
    setInvoiceSummary(null)
    setPaymentOption('link')
    setCheckingCards(false)
    setPaymentMethods([])
    setSelectedPaymentMethod(null)
    setCustomerId(null)
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
      setInvoiceTitle(config.invoiceTitle || 'PAGO')
      setInvoiceTermsNotes(config.invoiceTermsNotes || null)
      setInvoiceDueDays(config.invoiceDueDays || 7)
      setTransferInfoUrl(config.transferInfoUrl || null)
    } catch (error) {
    }
  }

  const checkStripeConnection = async () => {
    setCheckingStripe(true)
    try {
      const response = await fetch('/api/highlevel/stripe-config')
      if (response.ok) {
        const data = await response.json()
        setStripeConnected(data.configured || false)
      } else {
        setStripeConnected(false)
      }
    } catch (error) {
      setStripeConnected(false)
    } finally {
      setCheckingStripe(false)
    }
  }

  useEffect(() => {
    if (!isOpen) {
      resetForm()
      return
    }

    resetForm()
    loadConfig()
    checkStripeConnection()
  }, [isOpen])

  // Search contacts
  useEffect(() => {
    if (searchQuery.length < 2) {
      setContacts([])
      setShowContactDropdown(false)
      return
    }

    const timer = setTimeout(async () => {
      setSearchingContact(true)
      try {
        const response = await fetch('/api/highlevel/contacts/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            query: searchQuery,
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

        setContacts(formattedContacts)
        setShowContactDropdown(true)
      } catch (error) {
        setContacts([])
      } finally {
        setSearchingContact(false)
      }
    }, 300)

    return () => clearTimeout(timer)
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
    setSelectedContact(contact)
    setSearchQuery('')
    setShowContactDropdown(false)
    setContacts([])
  }

  const handleClearContact = () => {
    setSelectedContact(null)
    setSearchQuery('')
  }

  const buildInvoicePayload = (preparedSubtotal: number, preparedTaxAmount: number, finalCurrency: string, contactName: string, items: any[]) => {
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
      name: description || `Pago de ${contactName}`,
      title: invoiceTitle || 'PAGO',
      currency: finalCurrency,
      businessDetails,
      contactDetails: {
        id: selectedContact?.id,
        name: contactName,
        email: selectedContact?.email || '',
        phoneNo: selectedContact?.phone || ''
      },
      items,
      issueDate: new Date().toISOString().split('T')[0],
      dueDate,
      liveMode: true,
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

      if (chargeType === 'product' && selectedProduct && selectedPrice) {
        const parsedAmount = normalizeAmount(customAmount)
        subtotal = parsedAmount
        finalCurrency = selectedPrice.currency || currency

        items = [
          {
            name: selectedProduct.name,
            description: selectedProduct.description || selectedPrice.name || 'Producto',
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
            name: description || 'Pago',
            description: description || 'Pago',
            amount: parsedAmount,
            qty: 1,
            currency
          }
        ]
      }

      const taxAmount = includeIVA ? normalizeAmount(subtotal * IVA_RATE) : 0
      const totalAmount = includeIVA ? normalizeAmount(subtotal + taxAmount) : subtotal

      const payload = buildInvoicePayload(subtotal, taxAmount, finalCurrency, contactName, items)

      setInvoicePayload(payload)
      setInvoiceSummary({
        contactId: selectedContact.id,
        contactName,
        contactEmail: selectedContact.email || '',
        amount: totalAmount,
        subtotal,
        taxAmount,
        includesTax: includeIVA,
        currency: finalCurrency,
        description: description || (chargeType === 'product' && selectedProduct ? selectedProduct.name : 'Pago')
      })

      setPaymentMethods([])
      setSelectedPaymentMethod(null)
      setCustomerId(null)
      setManualPaymentData(defaultManualPaymentData())

      // Si Stripe no está conectado, ir directo a pago manual
      if (!stripeConnected) {
        setPaymentOption('manual')
      } else {
        setPaymentOption('link')
      }

      setStep('options')
    } catch (error: any) {
      showToast('error', error.message || 'No se pudo preparar el invoice')
    } finally {
      setLoading(false)
    }
  }

  const loadPaymentMethods = async (contactId: string) => {
    setCheckingCards(true)
    try {
      const response = await fetch(`/api/payment-methods/contact/${contactId}`)
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Error al obtener tarjetas guardadas')
      }

      const methods = data.paymentMethods || []
      setPaymentMethods(methods)
      setCustomerId(data.customerId || null)
      setSelectedPaymentMethod(methods.length > 0 ? methods[0].id : null)

      if (methods.length === 0 && data.message) {
        showToast('info', data.message)
      }
    } catch (error: any) {
      showToast('error', error.message || 'No se pudieron obtener las tarjetas guardadas')
      setPaymentMethods([])
      setCustomerId(null)
      setSelectedPaymentMethod(null)
    } finally {
      setCheckingCards(false)
    }
  }

  const handleConfirm = async () => {
    if (!invoiceSummary || !invoicePayload) {
      showToast('error', 'No se pudo procesar el pago. Intenta nuevamente.')
      return
    }

    setLoading(true)
    setStep('processing')

    try {
      let invoiceId = invoiceSummary.invoiceId

      if (!invoiceId) {
        const response = await fetch('/api/highlevel/invoices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(invoicePayload)
        })

        const data = await response.json()
        if (!response.ok) {
          throw new Error(data.error || 'Error al crear el invoice')
        }

        invoiceId = data.invoice?.id || data.invoice?._id

        if (!invoiceId) {
          throw new Error('No se pudo obtener el ID del invoice')
        }

        setInvoiceSummary(prev => (prev ? { ...prev, invoiceId } : prev))
      }

      switch (paymentOption) {
        case 'link': {
          const response = await fetch(`/api/highlevel/invoices/${invoiceId}/send`, {
            method: 'POST'
          })
          const data = await response.json()
          if (!response.ok) {
            throw new Error(data.error || 'No se pudo enviar el enlace de pago')
          }
          showToast('success', 'Éxito', 'Enlace de pago enviado al cliente')
          break
        }
        case 'saved': {
          if (!selectedPaymentMethod || !customerId) {
            throw new Error('Selecciona una tarjeta para continuar')
          }

          const response = await fetch('/api/payment-methods/charge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contactId: invoiceSummary.contactId,
              paymentMethodId: selectedPaymentMethod,
              amount: invoiceSummary.amount,
              currency: invoiceSummary.currency,
              invoiceId,
              description: invoiceSummary.description
            })
          })

          const data = await response.json()
          if (!response.ok) {
            throw new Error(data.error || 'No se pudo procesar el pago con tarjeta guardada')
          }

          showToast('success', 'Éxito', 'Pago procesado exitosamente')
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

      onSuccess?.()
      onClose()
    } catch (error: any) {
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
                  {contacts.length > 0 ? (
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
          <label className={styles.label}>Descripción (opcional)</label>
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

        {stripeConnected && (
          <>
        <div className={styles.paymentOptions}>
          <button
            type="button"
            className={`${styles.optionButton} ${paymentOption === 'link' ? styles.optionButtonActive : ''}`}
            onClick={() => setPaymentOption('link')}
          >
            <div className={styles.optionInfo}>
              <div className={styles.optionIcon}>
                <LinkIcon size={18} />
              </div>
              <div>
                <p>Enviar enlace de pago</p>
                <span>El cliente recibirá un enlace directo para pagar</span>
              </div>
            </div>
            {paymentOption === 'link' && <Check size={18} />}
          </button>

          {stripeConnected && (
            <>
              <button
                type="button"
                className={`${styles.optionButton} ${paymentOption === 'saved' ? styles.optionButtonActive : ''}`}
                onClick={() => {
                  setPaymentOption('saved')
                  loadPaymentMethods(invoiceSummary.contactId)
                }}
              >
                <div className={styles.optionInfo}>
                  <div className={styles.optionIcon}>
                    <CreditCard size={18} />
                  </div>
                  <div>
                    <p>Cobrar tarjeta guardada</p>
                    <span>
                      {checkingCards
                        ? 'Verificando tarjetas...'
                        : paymentMethods.length > 0
                          ? `${paymentMethods.length} tarjeta${paymentMethods.length > 1 ? 's' : ''} disponible${paymentMethods.length > 1 ? 's' : ''}`
                          : 'Comprueba si el cliente tiene tarjetas guardadas'}
                    </span>
                  </div>
                </div>
                {paymentOption === 'saved' && <Check size={18} />}
              </button>

              {paymentOption === 'saved' && (
                <div className={styles.cardList}>
                  {checkingCards ? (
                    <div className={styles.cardLoading}>
                      <Loader2 size={16} className={styles.processingIcon} />
                      <span>Buscando tarjetas guardadas...</span>
                    </div>
                  ) : paymentMethods.length > 0 ? (
                    paymentMethods.map((pm) => (
                      <button
                        key={pm.id}
                        type="button"
                        className={`${styles.cardButton} ${selectedPaymentMethod === pm.id ? styles.cardButtonActive : ''}`}
                        onClick={() => setSelectedPaymentMethod(pm.id)}
                      >
                        <div>
                          <p>{pm.brand?.toUpperCase()} •••• {pm.last4}</p>
                          <span>Vence {pm.expMonth}/{pm.expYear}</span>
                        </div>
                        {selectedPaymentMethod === pm.id && <Check size={16} />}
                      </button>
                    ))
                  ) : (
                    <div className={styles.cardEmpty}>
                      Este cliente no tiene tarjetas guardadas en Stripe.
                    </div>
                  )}
                </div>
              )}
            </>
          )}

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
            {paymentOption === 'manual' && <Check size={18} />}
          </button>
        </div>
          </>
        )}

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
      return (
        <div className={styles.footer}>
          <Button
            variant="secondary"
            onClick={() => {
              setStep('form')
              setInvoicePayload(null)
              setInvoiceSummary(null)
              setPaymentOption('link')
              setPaymentMethods([])
              setSelectedPaymentMethod(null)
              setCustomerId(null)
            }}
            disabled={loading}
          >
            Regresar
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={loading || (paymentOption === 'saved' && (!selectedPaymentMethod || checkingCards))}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Procesando...
              </>
            ) : (
              <>
                {paymentOption === 'link' && 'Enviar enlace'}
                {paymentOption === 'saved' && 'Cobrar tarjeta'}
                {paymentOption === 'manual' && 'Registrar pago'}
              </>
            )}
          </Button>
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
          disabled={loading}
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Preparando...
            </>
          ) : (
            'Continuar'
          )}
        </Button>
      </div>
    )
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        step === 'options'
          ? (stripeConnected ? 'Elige cómo cobrar' : 'Registrar pago manual')
          : 'Registrar nuevo cobro'
      }
      size="lg"
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
