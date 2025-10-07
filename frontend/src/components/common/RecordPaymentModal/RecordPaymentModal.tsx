import React, { useState, useEffect } from 'react'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { Search, Loader2, X, DollarSign } from 'lucide-react'
import styles from './RecordPaymentModal.module.css'
import { useNotification } from '@/contexts/NotificationContext'

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

export const RecordPaymentModal: React.FC<RecordPaymentModalProps> = ({
  isOpen,
  onClose,
  onSuccess
}) => {
  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState<'form' | 'processing'>('form')

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

  // Product charge
  const [products, setProducts] = useState<Product[]>([])
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [prices, setPrices] = useState<Price[]>([])
  const [selectedPrice, setSelectedPrice] = useState<Price | null>(null)
  const [customAmount, setCustomAmount] = useState('')
  const [loadingProducts, setLoadingProducts] = useState(false)

  const { showNotification } = useNotification()

  // Reset form when modal opens/closes
  useEffect(() => {
    if (!isOpen) {
      resetForm()
    }
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

        // Contacts come already transformed from the backend
        const contacts = (data.contacts || []).map((contact: any) => ({
          id: contact.id,
          name: contact.name || 'Sin nombre',
          email: contact.email || '',
          phone: contact.phone || '',
          firstName: contact.firstName || '',
          lastName: contact.lastName || ''
        }))

        setContacts(contacts)
        setShowContactDropdown(true)
      } catch (error) {
        console.error('Error buscando contactos:', error)
        setContacts([])
      } finally {
        setSearchingContact(false)
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [searchQuery])

  // Load products when switching to product charge
  useEffect(() => {
    if (isOpen && chargeType === 'product' && products.length === 0) {
      loadProducts()
    }
  }, [isOpen, chargeType])

  // Load prices when product is selected
  useEffect(() => {
    if (selectedProduct) {
      loadPrices(selectedProduct.id || selectedProduct._id)
    }
  }, [selectedProduct])

  // Auto-fill custom amount when price is selected
  useEffect(() => {
    if (selectedPrice) {
      setCustomAmount(String(selectedPrice.amount || selectedPrice.price || ''))
    }
  }, [selectedPrice])

  const loadProducts = async () => {
    setLoadingProducts(true)
    try {
      const response = await fetch('/api/highlevel/products?limit=100')
      const data = await response.json()
      setProducts(data.products || [])
    } catch (error) {
      console.error('Error cargando productos:', error)
      showNotification('error', 'No se pudieron cargar los productos')
    } finally {
      setLoadingProducts(false)
    }
  }

  const loadPrices = async (productId: string) => {
    try {
      const response = await fetch(`/api/highlevel/products/${productId}/prices`)
      const data = await response.json()
      setPrices(data.prices || [])
    } catch (error) {
      console.error('Error cargando precios:', error)
      showNotification('error', 'No se pudieron cargar los precios')
    }
  }

  const resetForm = () => {
    setStep('form')
    setSearchQuery('')
    setSelectedContact(null)
    setShowContactDropdown(false)
    setContacts([])
    setChargeType('direct')
    setAmount('')
    setDescription('')
    setSelectedProduct(null)
    setSelectedPrice(null)
    setCustomAmount('')
    setPrices([])
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

  const handleSubmit = async () => {
    // Validations
    if (!selectedContact) {
      showNotification('error', 'Selecciona un contacto')
      return
    }

    if (chargeType === 'direct') {
      if (!amount || parseFloat(amount) <= 0) {
        showNotification('error', 'Ingresa un monto válido')
        return
      }
    } else {
      if (!selectedProduct) {
        showNotification('error', 'Selecciona un producto')
        return
      }
      if (!selectedPrice) {
        showNotification('error', 'Selecciona un precio')
        return
      }
      if (!customAmount || parseFloat(customAmount) <= 0) {
        showNotification('error', 'Ingresa un monto válido')
        return
      }
    }

    setLoading(true)
    setStep('processing')

    try {
      const contactName = selectedContact.name ||
        `${selectedContact.firstName || ''} ${selectedContact.lastName || ''}`.trim() ||
        selectedContact.email ||
        selectedContact.phone ||
        'Cliente'

      // Build items based on charge type
      let items: any[]
      let finalCurrency = currency

      if (chargeType === 'product' && selectedPrice) {
        finalCurrency = selectedPrice.currency || currency
        items = [
          {
            name: selectedProduct!.name,
            description: selectedProduct!.description || selectedPrice.name || 'Producto',
            priceId: selectedPrice.id || selectedPrice._id,
            productId: selectedProduct!.id || selectedProduct!._id,
            amount: parseFloat(customAmount),
            qty: 1,
            currency: finalCurrency,
          }
        ]
      } else {
        items = [
          {
            name: description || 'Pago',
            description: description || 'Pago',
            amount: parseFloat(amount),
            qty: 1,
            currency: currency,
          }
        ]
      }

      const invoiceTotal = chargeType === 'product' ? parseFloat(customAmount) : parseFloat(amount)

      // Create invoice
      const invoiceResponse = await fetch('/api/highlevel/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: description || `Pago de ${contactName}`,
          title: 'PAGO',
          currency: finalCurrency,
          contactDetails: {
            id: selectedContact.id,
            name: contactName,
            email: selectedContact.email || '',
            phoneNo: selectedContact.phone || '',
          },
          items: items,
          issueDate: new Date().toISOString().split('T')[0],
          dueDate: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 1 day from now
          liveMode: true,
        })
      })

      if (!invoiceResponse.ok) {
        throw new Error('Error al crear el pago')
      }

      const invoiceData = await invoiceResponse.json()
      const invoiceId = invoiceData.invoice?.id || invoiceData.invoice?._id

      if (!invoiceId) {
        throw new Error('No se pudo obtener el ID del pago')
      }

      // Record payment
      const paymentResponse = await fetch(`/api/highlevel/invoices/${invoiceId}/record-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: invoiceTotal,
          currency: finalCurrency,
          fulfilledAt: new Date().toISOString(),
          note: 'Pago registrado manualmente',
        })
      })

      if (!paymentResponse.ok) {
        throw new Error('Error al registrar el pago')
      }

      showNotification('success', 'Pago registrado correctamente')
      onSuccess?.()
      onClose()
    } catch (error: any) {
      console.error('Error:', error)
      showNotification('error', error.message || 'No se pudo registrar el pago')
      setStep('form')
    } finally {
      setLoading(false)
    }
  }

  const renderForm = () => (
    <div className={styles.content}>
      {/* Contact search */}
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

      {/* Charge type selector */}
      <div className={styles.field}>
        <label className={styles.label}>Tipo de cobro</label>
        <div className={styles.toggle}>
          <button
            type="button"
            onClick={() => {
              setChargeType('direct')
              setSelectedProduct(null)
              setSelectedPrice(null)
              setCustomAmount('')
            }}
            className={`${styles.toggleButton} ${chargeType === 'direct' ? styles.toggleButtonActive : ''}`}
          >
            Cobro directo
          </button>
          <button
            type="button"
            onClick={() => {
              setChargeType('product')
              setAmount('')
            }}
            className={`${styles.toggleButton} ${chargeType === 'product' ? styles.toggleButtonActive : ''}`}
          >
            Productos guardados
          </button>
        </div>
      </div>

      {/* Product selection */}
      {chargeType === 'product' && (
        <>
          <div className={styles.field}>
            <label className={styles.label}>Producto</label>
            <select
              value={selectedProduct?.id || selectedProduct?._id || ''}
              onChange={(e) => {
                const product = products.find(p => (p.id || p._id) === e.target.value)
                setSelectedProduct(product || null)
                setSelectedPrice(null)
                setPrices([])
              }}
              className={styles.select}
              disabled={loadingProducts}
            >
              <option value="">Selecciona un producto</option>
              {products.map((product) => (
                <option key={product.id || product._id} value={product.id || product._id}>
                  {product.name}
                </option>
              ))}
            </select>
            {loadingProducts && <p className={styles.hint}>Cargando productos...</p>}
          </div>

          {selectedProduct && (
            <>
              <div className={styles.field}>
                <label className={styles.label}>Precio</label>
                <select
                  value={selectedPrice?.id || selectedPrice?._id || ''}
                  onChange={(e) => {
                    const price = prices.find(p => (p.id || p._id) === e.target.value)
                    setSelectedPrice(price || null)
                  }}
                  className={styles.select}
                >
                  <option value="">Selecciona un precio</option>
                  {prices.map((price) => (
                    <option key={price.id || price._id} value={price.id || price._id}>
                      {price.name || 'Precio'} - ${price.amount || price.price} {price.currency}
                    </option>
                  ))}
                </select>
                {prices.length === 0 && (
                  <p className={styles.hint}>No hay precios disponibles para este producto</p>
                )}
              </div>

              {selectedPrice && (
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
        </>
      )}

      {/* Direct amount */}
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

      {/* Description */}
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
    </div>
  )

  const renderProcessing = () => (
    <div className={styles.processing}>
      <Loader2 size={48} className={styles.processingIcon} />
      <p className={styles.processingText}>Registrando pago...</p>
      <p className={styles.processingHint}>Por favor espera...</p>
    </div>
  )

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Registrar Pago Offline"
      size="lg"
      type="custom"
      showCloseButton={step === 'form'}
    >
      {step === 'form' && (
        <>
          {renderForm()}
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
              onClick={handleSubmit}
              disabled={loading}
            >
              Registrar Pago
            </Button>
          </div>
        </>
      )}
      {step === 'processing' && renderProcessing()}
    </Modal>
  )
}
