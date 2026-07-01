import React, { useEffect, useMemo, useState } from 'react'
import { Modal } from '@/components/common/Modal'
import { Button } from '@/components/common/Button'
import { NumberInput } from '@/components/common/NumberInput'
import { CustomSelect } from '@/components/common/CustomSelect'
import { useNotification } from '@/contexts/NotificationContext'
import { useAccountCurrency } from '@/hooks'
import { CURRENCY_OPTIONS, normalizeCurrencyCode } from '@/utils/accountLocale'
import {
  productsService,
  type ProductItem,
  type ProductPayload
} from '@/services/productsService'
import styles from './ProductFormModal.module.css'

export interface ProductFormModalProps {
  isOpen: boolean
  onClose: () => void
  onCreated?: (product: ProductItem) => void
  defaultName?: string
  defaultAmount?: number
  defaultCurrency?: string
}

const currencyOptions = CURRENCY_OPTIONS.map((option) => ({
  value: option.value,
  label: option.label
}))

const toAmountDraft = (value?: number) => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? String(value) : ''
)

export const ProductFormModal: React.FC<ProductFormModalProps> = ({
  isOpen,
  onClose,
  onCreated,
  defaultName = '',
  defaultAmount,
  defaultCurrency
}) => {
  const { showToast } = useNotification()
  const [accountCurrency] = useAccountCurrency()

  const resolvedCurrency = useMemo(
    () => normalizeCurrencyCode(defaultCurrency, accountCurrency),
    [defaultCurrency, accountCurrency]
  )

  const [name, setName] = useState(defaultName)
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState(() => toAmountDraft(defaultAmount))
  const [currency, setCurrency] = useState(resolvedCurrency)
  const [saving, setSaving] = useState(false)

  // Reseed the form each time the modal opens so prefill props are respected.
  useEffect(() => {
    if (!isOpen) return
    setName(defaultName)
    setDescription('')
    setAmount(toAmountDraft(defaultAmount))
    setCurrency(resolvedCurrency)
    setSaving(false)
  }, [isOpen, defaultName, defaultAmount, resolvedCurrency])

  const handleClose = () => {
    if (saving) return
    onClose()
  }

  const handleSubmit = async () => {
    const trimmedName = name.trim()
    const numericAmount = Number(amount)

    if (!trimmedName) {
      showToast('warning', 'Falta el nombre', 'Escribe cómo se llama el producto.')
      return
    }

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      showToast('warning', 'Falta el precio', 'Escribe un precio válido para poder cobrarlo.')
      return
    }

    const payload: ProductPayload = {
      name: trimmedName,
      description: description.trim(),
      currency,
      productType: 'digital',
      prices: [
        {
          name: 'Precio base',
          amount: numericAmount,
          currency,
          type: 'one_time'
        }
      ]
    }

    setSaving(true)
    try {
      const createdProduct = await productsService.createProduct(payload)
      showToast('success', 'Producto creado', `${trimmedName} ya aparece en tu catálogo.`)
      onCreated?.(createdProduct)
      onClose()
    } catch (error) {
      showToast(
        'error',
        'No se guardó el producto',
        error instanceof Error ? error.message : 'Intenta otra vez.'
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Nuevo producto"
      subtitle="Crea un producto rápido para tu catálogo."
      size="sm"
      type="custom"
    >
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          void handleSubmit()
        }}
      >
        <div className={styles.formGroup}>
          <label htmlFor="quick-product-name">Nombre del producto</label>
          <input
            id="quick-product-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Mensualidad, consulta, paquete..."
            autoFocus
            required
          />
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="quick-product-description">Descripción</label>
          <textarea
            id="quick-product-description"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Detalle visible para el equipo y para cobros."
          />
        </div>

        <div className={styles.priceRow}>
          <div className={styles.formGroup}>
            <label htmlFor="quick-product-amount">Precio</label>
            <NumberInput
              id="quick-product-amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              min="0"
              step="0.01"
              placeholder="0.00"
              required
            />
          </div>

          <div className={styles.formGroup}>
            <label>Moneda</label>
            <CustomSelect
              value={currency}
              onValueChange={setCurrency}
              options={currencyOptions}
              aria-label="Moneda del producto"
            />
          </div>
        </div>

        <div className={styles.footer}>
          <Button type="button" variant="ghost" onClick={handleClose} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" loading={saving}>
            Crear producto
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export default ProductFormModal
