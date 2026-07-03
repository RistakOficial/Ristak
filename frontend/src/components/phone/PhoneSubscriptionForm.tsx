import React, { useEffect, useMemo, useState } from 'react'
import { Check, ChevronRight, Copy, ExternalLink, Loader2, Repeat2, Search, User, X } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import type { PaymentGatewayProvider } from '@/hooks'
import { PaymentPlatformLogo } from '@/components/common/PaymentPlatformLogo'
import { contactsService } from '@/services/contactsService'
import {
  subscriptionsService,
  type PaymentSubscription,
  type SubscriptionInterval
} from '@/services/subscriptionsService'
import type { Contact } from '@/types'
import { PhonePaymentFormShell } from './PhonePaymentFormShell'
import {
  PhoneButton,
  PhoneDateField,
  PhoneSelect,
  PhoneTextArea,
  PhoneTextField,
  type PhoneSelectOption
} from './ui'
import styles from './PhoneSubscriptionForm.module.css'

interface PhoneSubscriptionFormProps {
  providers: PaymentGatewayProvider[]
  currency: string
  initialContact?: Partial<Contact> | null
  lockInitialContact?: boolean
  onCancel?: () => void
  onSaved?: (subscription: PaymentSubscription) => void
}

interface SubscriptionDraft {
  name: string
  description: string
  amount: string
  intervalType: SubscriptionInterval
  intervalCount: string
  startDate: string
}

type SubscriptionGatewayProvider = Exclude<PaymentGatewayProvider, 'clip' | 'rebill'>

const PROVIDER_LABELS: Record<SubscriptionGatewayProvider, string> = {
  stripe: 'Stripe',
  conekta: 'Conekta',
  mercadopago: 'Mercado Pago'
}

const PROVIDER_DESCRIPTIONS: Record<SubscriptionGatewayProvider, string> = {
  stripe: 'Suscripciones con Stripe.',
  conekta: 'Domiciliación con tarjeta guardada.',
  mercadopago: 'Autorización por enlace de Mercado Pago.'
}

const INTERVAL_OPTIONS: Array<PhoneSelectOption & { value: SubscriptionInterval }> = [
  { value: 'daily', label: 'Diaria' },
  { value: 'weekly', label: 'Semanal' },
  { value: 'monthly', label: 'Mensual' },
  { value: 'yearly', label: 'Anual' }
]

function getTodayInputValue() {
  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function createDraft(): SubscriptionDraft {
  return {
    name: '',
    description: '',
    amount: '',
    intervalType: 'monthly',
    intervalCount: '1',
    startDate: getTodayInputValue()
  }
}

function normalizeAmount(value: string) {
  const amount = Number(String(value || '').replace(',', '.'))
  return Number.isFinite(amount) ? amount : 0
}

function formatCurrency(value: number, currency = 'MXN') {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2
  }).format(value || 0)
}

function getIntervalSummary(intervalType: SubscriptionInterval, intervalCountValue: string) {
  const count = Math.max(1, Number(intervalCountValue) || 1)
  const singular: Record<SubscriptionInterval, string> = {
    daily: 'día',
    weekly: 'semana',
    monthly: 'mes',
    yearly: 'año'
  }
  const plural: Record<SubscriptionInterval, string> = {
    daily: 'días',
    weekly: 'semanas',
    monthly: 'meses',
    yearly: 'años'
  }

  return count === 1 ? `Cada ${singular[intervalType]}` : `Cada ${count} ${plural[intervalType]}`
}

function getMercadoPagoAuthorizationLink(subscription: PaymentSubscription) {
  if (subscription.paymentMode === 'test') {
    return subscription.mercadoPagoSandboxInitPoint || subscription.mercadoPagoInitPoint || ''
  }
  return subscription.mercadoPagoInitPoint || subscription.mercadoPagoSandboxInitPoint || ''
}

function isSubscriptionGatewayProvider(provider: PaymentGatewayProvider): provider is SubscriptionGatewayProvider {
  return provider !== 'clip' && provider !== 'rebill'
}

function getSubscriptionActivationLink(subscription: PaymentSubscription, provider: SubscriptionGatewayProvider) {
  if (provider === 'mercadopago') return getMercadoPagoAuthorizationLink(subscription)
  return ''
}

function getPaymentMethodForProvider(provider: SubscriptionGatewayProvider) {
  if (provider === 'mercadopago') return 'mercadopago_subscription'
  if (provider === 'conekta') return 'conekta_subscription'
  return 'stripe_saved_card'
}

function getContactName(contact?: Partial<Contact> | null) {
  return contact?.name || contact?.email || contact?.phone || 'Contacto'
}

function getContactDetail(contact?: Partial<Contact> | null) {
  return contact?.email || contact?.phone || 'Sin correo o teléfono'
}

export const PhoneSubscriptionForm: React.FC<PhoneSubscriptionFormProps> = ({
  providers,
  currency,
  initialContact = null,
  lockInitialContact = false,
  onCancel,
  onSaved
}) => {
  const { showToast } = useNotification()
  const subscriptionProviders = useMemo(() => providers.filter(isSubscriptionGatewayProvider), [providers])
  const providerOptions = useMemo<PhoneSelectOption[]>(() => (
    subscriptionProviders.map((provider) => ({
      value: provider,
      label: PROVIDER_LABELS[provider],
      description: PROVIDER_DESCRIPTIONS[provider]
    }))
  ), [subscriptionProviders])
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [contactPickerOpen, setContactPickerOpen] = useState(false)
  const [contactQuery, setContactQuery] = useState('')
  const [contactResults, setContactResults] = useState<Contact[]>([])
  const [contactSearching, setContactSearching] = useState(false)
  const [provider, setProvider] = useState<SubscriptionGatewayProvider>(() => subscriptionProviders[0] || 'stripe')
  const [providerStepOpen, setProviderStepOpen] = useState(false)
  const [draft, setDraft] = useState<SubscriptionDraft>(() => createDraft())
  const [saving, setSaving] = useState(false)
  const [savedSubscription, setSavedSubscription] = useState<PaymentSubscription | null>(null)
  const [authorizationLink, setAuthorizationLink] = useState('')

  const lockedContactId = lockInitialContact ? initialContact?.id || '' : ''
  const resolvedContact = lockInitialContact ? initialContact : selectedContact
  const resolvedContactId = lockInitialContact ? lockedContactId : selectedContact?.id || ''
  const resolvedContactName = getContactName(resolvedContact)
  const resolvedContactEmail = resolvedContact?.email || ''
  const resolvedContactPhone = resolvedContact?.phone || ''
  const selectedProvider = subscriptionProviders.includes(provider) ? provider : subscriptionProviders[0] || 'stripe'
  const providerNeedsStoredContact = providerStepOpen && (selectedProvider === 'stripe' || selectedProvider === 'conekta')
  const knownProviderForDetails = providerOptions.length === 1 ? subscriptionProviders[0] : providerStepOpen ? selectedProvider : null
  const amount = normalizeAmount(draft.amount)
  const providerLabel = providerStepOpen ? PROVIDER_LABELS[selectedProvider] || 'Pasarela' : 'Sin pasarela'
  const intervalSummary = getIntervalSummary(draft.intervalType, draft.intervalCount)
  const formSummary = {
    label: 'Cobro recurrente',
    detail: providerStepOpen ? `${providerLabel} · ${intervalSummary}` : intervalSummary,
    amount: formatCurrency(amount, currency)
  }

  useEffect(() => {
    if (subscriptionProviders.length > 0 && !subscriptionProviders.includes(provider)) {
      setProvider(subscriptionProviders[0])
    }
  }, [provider, subscriptionProviders])

  useEffect(() => {
    if (knownProviderForDetails === 'conekta' && draft.intervalType === 'daily') {
      setDraft((current) => ({ ...current, intervalType: 'monthly' }))
    }
  }, [draft.intervalType, knownProviderForDetails])

  useEffect(() => {
    if (!contactPickerOpen || typeof document === 'undefined') return

    const previousValue = document.body.getAttribute('data-payment-contact-picker')
    document.body.setAttribute('data-payment-contact-picker', 'open')

    return () => {
      if (previousValue) {
        document.body.setAttribute('data-payment-contact-picker', previousValue)
      } else {
        document.body.removeAttribute('data-payment-contact-picker')
      }
    }
  }, [contactPickerOpen])

  useEffect(() => {
    if (!contactPickerOpen || lockInitialContact || selectedContact) {
      setContactResults([])
      setContactSearching(false)
      return
    }

    const query = contactQuery.trim()
    if (query.length < 2) {
      setContactResults([])
      setContactSearching(false)
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setContactSearching(true)
      try {
        const results = await contactsService.searchContacts(query, controller.signal)
        if (!controller.signal.aborted) setContactResults(results.slice(0, 8))
      } finally {
        if (!controller.signal.aborted) setContactSearching(false)
      }
    }, 120)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [contactPickerOpen, contactQuery, lockInitialContact, selectedContact])

  const updateDraft = <Key extends keyof SubscriptionDraft>(key: Key, value: SubscriptionDraft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const selectContact = (contact: Contact) => {
    setSelectedContact(contact)
    setContactQuery('')
    setContactResults([])
    setContactPickerOpen(false)
  }

  const clearSelectedContact = () => {
    setSelectedContact(null)
    setContactQuery('')
    setContactResults([])
  }

  const handleCopyAuthorizationLink = async () => {
    if (!authorizationLink) return
    try {
      await navigator.clipboard.writeText(authorizationLink)
      showToast('success', 'Link copiado', 'Ya puedes enviarlo al cliente para autorizar la suscripción.')
    } catch {
      showToast('error', 'No se pudo copiar', 'Copia el enlace manualmente.')
    }
  }

  const finishSavedSubscription = () => {
    if (savedSubscription) onSaved?.(savedSubscription)
  }

  const validateDraft = (targetProvider?: SubscriptionGatewayProvider) => {
    if (!providerOptions.length) {
      showToast('warning', 'Pasarela no conectada', 'Conecta Stripe, Conekta o Mercado Pago para crear suscripciones.')
      return false
    }
    if (!draft.name.trim()) {
      showToast('warning', 'Falta el nombre', 'Escribe cómo se llama la suscripción.')
      return false
    }
    if (amount <= 0) {
      showToast('warning', 'Falta el monto', 'Escribe un monto válido para la suscripción.')
      return false
    }

    if (targetProvider && (targetProvider === 'stripe' || targetProvider === 'conekta') && !resolvedContactId) {
      showToast('warning', 'Falta el contacto', `${PROVIDER_LABELS[targetProvider]} necesita un contacto guardado para activar la suscripción.`)
      return false
    }
    if (targetProvider === 'mercadopago' && !resolvedContactEmail) {
      showToast('warning', 'Falta el email', 'Mercado Pago necesita email para que el cliente autorice la suscripción.')
      return false
    }
    if (targetProvider === 'conekta' && draft.intervalType === 'daily') {
      showToast('warning', 'Frecuencia no soportada', 'Conekta no acepta suscripciones diarias.')
      return false
    }

    return true
  }

  const createSubscriptionWithProvider = async (targetProvider: SubscriptionGatewayProvider) => {
    if (!validateDraft(targetProvider)) return

    setSaving(true)
    try {
      const paymentMethod = getPaymentMethodForProvider(targetProvider)
      const subscription = await subscriptionsService.createSubscription({
        contactId: resolvedContactId || null,
        contactName: resolvedContactName,
        contactEmail: resolvedContactEmail || null,
        contactPhone: resolvedContactPhone || null,
        name: draft.name.trim(),
        description: draft.description.trim(),
        status: targetProvider === 'mercadopago' ? 'incomplete' : 'active',
        amount,
        currency,
        intervalType: draft.intervalType,
        intervalCount: Math.max(1, Number(draft.intervalCount) || 1),
        startDate: draft.startDate || getTodayInputValue(),
        nextRunAt: targetProvider === 'mercadopago' ? null : draft.startDate || getTodayInputValue(),
        paymentMethod,
        paymentProvider: targetProvider
      })
      const link = getSubscriptionActivationLink(subscription, targetProvider)
      setSavedSubscription(subscription)
      setAuthorizationLink(link)
      setProviderStepOpen(false)

      if (link) {
        showToast('success', 'Link listo', 'Copia el enlace para que el cliente active la suscripción.')
        return
      }

      showToast('success', 'Suscripción creada', `${draft.name.trim()} quedó guardada.`)
      onSaved?.(subscription)
    } catch (error) {
      showToast('error', 'No se guardó la suscripción', error instanceof Error ? error.message : 'Intenta otra vez.')
    } finally {
      setSaving(false)
    }
  }

  const handleSubmit = async () => {
    if (!validateDraft()) return

    if (!providerStepOpen && providerOptions.length > 1) {
      setProvider(selectedProvider)
      setProviderStepOpen(true)
      return
    }

    await createSubscriptionWithProvider(selectedProvider)
  }

  const handleBack = () => {
    if (providerStepOpen) {
      setProviderStepOpen(false)
      return
    }

    onCancel?.()
  }

  const renderContactPicker = () => {
    if (lockInitialContact) {
      return (
        <div className={styles.fieldGroup}>
          <span className={styles.fieldLabel}>Cliente</span>
          <div className={`${styles.contactPickerTrigger} ${styles.lockedContact}`}>
            <span className={styles.contactPickerIcon}>
              <User size={22} aria-hidden="true" />
            </span>
            <span className={styles.contactPickerCopy}>
              <strong>{resolvedContactName}</strong>
              <small>{getContactDetail(resolvedContact)}</small>
            </span>
          </div>
        </div>
      )
    }

    return (
      <div className={styles.fieldGroup}>
        <span className={styles.fieldLabel}>Cliente</span>
        <div className={styles.contactPickerControl}>
          <button
            type="button"
            className={styles.contactPickerTrigger}
            onClick={() => setContactPickerOpen(true)}
          >
            <span className={styles.contactPickerIcon}>
              {selectedContact ? <User size={22} aria-hidden="true" /> : <Search size={22} aria-hidden="true" />}
            </span>
            <span className={styles.contactPickerCopy}>
              <strong>{selectedContact ? getContactName(selectedContact) : 'Seleccionar contacto'}</strong>
              <small>{selectedContact ? getContactDetail(selectedContact) : 'Busca por nombre, teléfono o correo'}</small>
            </span>
            <ChevronRight size={20} className={styles.contactPickerChevron} aria-hidden="true" />
          </button>
          {selectedContact && (
            <button
              type="button"
              className={styles.contactPickerClear}
              onClick={clearSelectedContact}
              aria-label="Quitar contacto seleccionado"
            >
              <X size={18} aria-hidden="true" />
            </button>
          )}
        </div>
        {providerNeedsStoredContact && !resolvedContactId && (
          <small className={styles.hint}>{PROVIDER_LABELS[provider]} necesita un contacto guardado.</small>
        )}
      </div>
    )
  }

  const renderContactSheet = () => {
    if (!contactPickerOpen || lockInitialContact) return null

    return (
      <div
        className={styles.sheetOverlay}
        role="presentation"
        onClick={() => setContactPickerOpen(false)}
      >
        <section
          className={styles.sheet}
          role="dialog"
          aria-modal="true"
          aria-label="Seleccionar contacto"
          data-phone-payments-sheet="true"
          onClick={(event) => event.stopPropagation()}
        >
          <header className={styles.sheetHeader}>
            <div>
              <span>Cliente</span>
              <strong>Seleccionar contacto</strong>
            </div>
            <button
              type="button"
              onClick={() => setContactPickerOpen(false)}
              aria-label="Cerrar selector de contacto"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </header>

          <PhoneTextField
            type="search"
            value={contactQuery}
            onChange={setContactQuery}
            placeholder="Buscar contacto guardado..."
            leading={<Search size={18} aria-hidden="true" />}
            autoFocus
            className={styles.sheetSearch}
            ariaLabel="Buscar contacto guardado"
          />

          <div
            className={styles.contactResults}
            role="listbox"
            aria-label="Resultados de contacto"
            data-phone-scrollable="true"
          >
            {contactSearching ? (
              <span className={styles.resultsState}>
                <Loader2 size={17} className={styles.spinIcon} aria-hidden="true" />
                Buscando...
              </span>
            ) : contactResults.length > 0 ? (
              contactResults.map((contact) => (
                <button
                  key={contact.id}
                  type="button"
                  role="option"
                  onClick={() => selectContact(contact)}
                >
                  <span className={styles.resultIcon}>
                    <User size={18} aria-hidden="true" />
                  </span>
                  <span>
                    <strong>{getContactName(contact)}</strong>
                    <small>{getContactDetail(contact)}</small>
                  </span>
                </button>
              ))
            ) : contactQuery.trim().length >= 2 ? (
              <span className={styles.resultsState}>No encontramos contactos guardados con esa búsqueda.</span>
            ) : (
              <span className={styles.resultsState}>Busca por nombre, email o teléfono.</span>
            )}
          </div>
        </section>
      </div>
    )
  }

  if (authorizationLink && savedSubscription) {
    return (
      <PhonePaymentFormShell
        title="Suscripción lista"
        subtitle="Envíale el link al cliente para que active la suscripción."
        icon={<Repeat2 size={22} aria-hidden="true" />}
        ariaLabel="Autorización de suscripción lista"
        onBack={finishSavedSubscription}
        summary={formSummary}
        footer={(
          <PhoneButton size="lg" fullWidth onClick={finishSavedSubscription}>
            Listo
          </PhoneButton>
        )}
      >
        <div className={styles.successCopy}>
          <strong>Autorización pendiente</strong>
          <span>Cuando el cliente complete el enlace, la suscripción quedará activa.</span>
        </div>
        <div className={styles.authorizationLink}>{authorizationLink}</div>
        <div className={styles.linkActions}>
          <PhoneButton variant="secondary" icon={<Copy size={17} />} onClick={handleCopyAuthorizationLink} fullWidth>
            Copiar link
          </PhoneButton>
          <PhoneButton
            variant="secondary"
            icon={<ExternalLink size={17} />}
            onClick={() => window.open(authorizationLink, '_blank', 'noopener,noreferrer')}
            fullWidth
          >
            Abrir
          </PhoneButton>
        </div>
      </PhonePaymentFormShell>
    )
  }

  if (providerStepOpen) {
    return (
      <PhonePaymentFormShell
        title="Elige pasarela"
        subtitle="Selecciona dónde quieres crear el enlace o autorización de la suscripción."
        icon={<Repeat2 size={22} aria-hidden="true" />}
        ariaLabel="Elegir pasarela de suscripción"
        onBack={handleBack}
        summary={formSummary}
        footer={(
          <PhoneButton size="lg" loading={saving} onClick={handleSubmit} fullWidth>
            Crear enlace de pago
          </PhoneButton>
        )}
      >
        <div className={styles.providerChoices}>
          {providerOptions.map((option) => {
            const value = option.value as SubscriptionGatewayProvider
            const active = selectedProvider === value
            return (
              <button
                key={value}
                type="button"
                className={`${styles.providerChoice} ${active ? styles.providerChoiceActive : ''}`}
                onClick={() => setProvider(value)}
              >
                <span className={styles.providerChoiceIcon}>
                  <PaymentPlatformLogo platform={value} size="md" decorative />
                </span>
                <span className={styles.providerChoiceCopy}>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                {active && <Check size={18} className={styles.providerChoiceCheck} aria-hidden="true" />}
              </button>
            )
          })}
        </div>
      </PhonePaymentFormShell>
    )
  }

  return (
    <PhonePaymentFormShell
      title="Nueva suscripción"
      subtitle="Configura el cobro recurrente desde el celular."
      icon={<Repeat2 size={22} aria-hidden="true" />}
      ariaLabel="Crear suscripción"
      onBack={handleBack}
      summary={formSummary}
      footer={(
        <PhoneButton size="lg" loading={saving} onClick={handleSubmit} fullWidth>
          Crear enlace de pago
        </PhoneButton>
      )}
    >
      {renderContactPicker()}

      <PhoneTextField
        label="Nombre"
        value={draft.name}
        onChange={(value) => updateDraft('name', value)}
        placeholder="Ej. Membresía mensual"
        className={styles.textField}
      />

      <PhoneTextField
        label={`Monto (${currency})`}
        value={draft.amount}
        onChange={(value) => updateDraft('amount', value)}
        type="number"
        placeholder="0.00"
        leading={<span aria-hidden="true">$</span>}
        className={styles.textField}
      />

      <div className={styles.formGrid}>
        <label className={styles.selectField}>
          <span>Frecuencia</span>
          <PhoneSelect
            value={draft.intervalType}
            onChange={(value) => updateDraft('intervalType', value as SubscriptionInterval)}
            options={INTERVAL_OPTIONS.map((option) => ({
              ...option,
              disabled: knownProviderForDetails === 'conekta' && option.value === 'daily'
            }))}
            title="Frecuencia"
            buttonClassName={styles.controlButton}
          />
        </label>
        <PhoneTextField
          label="Cada"
          value={draft.intervalCount}
          onChange={(value) => updateDraft('intervalCount', value)}
          type="number"
          placeholder="1"
          className={styles.textField}
        />
      </div>

      <label className={styles.dateField}>
        <span>Inicio</span>
        <PhoneDateField
          value={draft.startDate}
          onChange={(value) => updateDraft('startDate', value)}
          min={getTodayInputValue()}
          title="Fecha de inicio"
          ariaLabel="Fecha de inicio de la suscripción"
          buttonClassName={styles.controlButton}
        />
      </label>

      <PhoneTextArea
        label="Notas"
        value={draft.description}
        onChange={(value) => updateDraft('description', value)}
        placeholder="Notas internas de esta suscripción."
        rows={3}
        className={`${styles.textField} ${styles.textArea}`}
      />

      {renderContactSheet()}
    </PhonePaymentFormShell>
  )
}
