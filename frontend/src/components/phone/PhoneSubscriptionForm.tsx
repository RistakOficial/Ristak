import React, { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Copy, ExternalLink, Repeat2 } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import type { PaymentGatewayProvider } from '@/hooks'
import { contactsService } from '@/services/contactsService'
import {
  subscriptionsService,
  type PaymentSubscription,
  type SubscriptionInterval
} from '@/services/subscriptionsService'
import type { Contact } from '@/types'
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

const PROVIDER_LABELS: Record<PaymentGatewayProvider, string> = {
  stripe: 'Stripe',
  conekta: 'Conekta',
  mercadopago: 'Mercado Pago'
}

const PROVIDER_DESCRIPTIONS: Record<PaymentGatewayProvider, string> = {
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
  return new Date().toISOString().slice(0, 10)
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

function getMercadoPagoAuthorizationLink(subscription: PaymentSubscription) {
  if (subscription.paymentMode === 'test') {
    return subscription.mercadoPagoSandboxInitPoint || subscription.mercadoPagoInitPoint || ''
  }
  return subscription.mercadoPagoInitPoint || subscription.mercadoPagoSandboxInitPoint || ''
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
  const providerOptions = useMemo<PhoneSelectOption[]>(() => (
    providers.map((provider) => ({
      value: provider,
      label: PROVIDER_LABELS[provider],
      description: PROVIDER_DESCRIPTIONS[provider]
    }))
  ), [providers])
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [contactQuery, setContactQuery] = useState('')
  const [contactResults, setContactResults] = useState<Contact[]>([])
  const [contactSearching, setContactSearching] = useState(false)
  const [provider, setProvider] = useState<PaymentGatewayProvider>(() => providers[0] || 'stripe')
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
  const providerNeedsStoredContact = provider === 'stripe' || provider === 'conekta'
  const amount = normalizeAmount(draft.amount)

  useEffect(() => {
    if (providers.length > 0 && !providers.includes(provider)) {
      setProvider(providers[0])
    }
  }, [provider, providers])

  useEffect(() => {
    if (provider === 'conekta' && draft.intervalType === 'daily') {
      setDraft((current) => ({ ...current, intervalType: 'monthly' }))
    }
  }, [draft.intervalType, provider])

  useEffect(() => {
    if (lockInitialContact || selectedContact) {
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
  }, [contactQuery, lockInitialContact, selectedContact])

  const updateDraft = <Key extends keyof SubscriptionDraft>(key: Key, value: SubscriptionDraft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }))
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

  const handleSubmit = async () => {
    if (!providerOptions.length) {
      showToast('warning', 'Pasarela no conectada', 'Conecta Stripe, Conekta o Mercado Pago para crear suscripciones.')
      return
    }
    if (!draft.name.trim()) {
      showToast('warning', 'Falta el nombre', 'Escribe cómo se llama la suscripción.')
      return
    }
    if (amount <= 0) {
      showToast('warning', 'Falta el monto', 'Escribe un monto válido para la suscripción.')
      return
    }
    if (providerNeedsStoredContact && !resolvedContactId) {
      showToast('warning', 'Falta el contacto', `${PROVIDER_LABELS[provider]} necesita un contacto guardado para activar la suscripción.`)
      return
    }
    if (provider === 'mercadopago' && !resolvedContactEmail) {
      showToast('warning', 'Falta el email', 'Mercado Pago necesita email para que el cliente autorice la suscripción.')
      return
    }
    if (provider === 'conekta' && draft.intervalType === 'daily') {
      showToast('warning', 'Frecuencia no soportada', 'Conekta no acepta suscripciones diarias.')
      return
    }

    setSaving(true)
    try {
      const paymentMethod = provider === 'mercadopago'
        ? 'mercadopago_subscription'
        : provider === 'conekta'
          ? 'conekta_subscription'
          : 'stripe_saved_card'
      const subscription = await subscriptionsService.createSubscription({
        contactId: resolvedContactId || null,
        contactName: resolvedContactName,
        contactEmail: resolvedContactEmail || null,
        contactPhone: resolvedContactPhone || null,
        name: draft.name.trim(),
        description: draft.description.trim(),
        status: provider === 'mercadopago' ? 'incomplete' : 'active',
        amount,
        currency,
        intervalType: draft.intervalType,
        intervalCount: Math.max(1, Number(draft.intervalCount) || 1),
        startDate: draft.startDate || getTodayInputValue(),
        nextRunAt: provider === 'mercadopago' ? null : draft.startDate || getTodayInputValue(),
        paymentMethod,
        paymentProvider: provider
      })
      const link = provider === 'mercadopago' ? getMercadoPagoAuthorizationLink(subscription) : ''
      setSavedSubscription(subscription)
      setAuthorizationLink(link)

      if (link) {
        showToast('success', 'Autorización lista', 'Copia el link para que el cliente active la suscripción.')
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

  if (authorizationLink && savedSubscription) {
    return (
      <section className={styles.successPanel} aria-label="Autorización de suscripción lista">
        <span className={styles.successIcon}>
          <Repeat2 size={22} />
        </span>
        <div className={styles.successCopy}>
          <strong>Suscripción lista para autorizar</strong>
          <span>Envíale este link al cliente para que active los cobros recurrentes.</span>
        </div>
        <div className={styles.authorizationLink}>{authorizationLink}</div>
        <div className={styles.actions}>
          <PhoneButton variant="secondary" icon={<Copy size={17} />} onClick={handleCopyAuthorizationLink}>
            Copiar link
          </PhoneButton>
          <PhoneButton
            variant="secondary"
            icon={<ExternalLink size={17} />}
            onClick={() => window.open(authorizationLink, '_blank', 'noopener,noreferrer')}
          >
            Abrir
          </PhoneButton>
        </div>
        <PhoneButton fullWidth onClick={() => onSaved?.(savedSubscription)}>
          Listo
        </PhoneButton>
      </section>
    )
  }

  return (
    <section className={styles.form} aria-label="Crear suscripción">
      <div className={styles.intro}>
        <span className={styles.introIcon}>
          <Repeat2 size={22} />
        </span>
        <div>
          <strong>Nueva suscripción</strong>
          <span>Configura el cobro recurrente desde el celular.</span>
        </div>
      </div>

      {lockInitialContact ? (
        <div className={styles.lockedContact}>
          <span>Contacto</span>
          <strong>{resolvedContactName}</strong>
          <small>{getContactDetail(resolvedContact)}</small>
        </div>
      ) : (
        <div className={styles.contactPicker}>
          {selectedContact ? (
            <div className={styles.selectedContact}>
              <span>Contacto</span>
              <strong>{getContactName(selectedContact)}</strong>
              <small>{getContactDetail(selectedContact)}</small>
              <button
                type="button"
                onClick={() => {
                  setSelectedContact(null)
                  setContactQuery('')
                }}
              >
                Cambiar
              </button>
            </div>
          ) : (
            <>
              <PhoneTextField
                label="Contacto"
                value={contactQuery}
                onChange={setContactQuery}
                placeholder="Buscar contacto guardado..."
                hint={providerNeedsStoredContact ? `${PROVIDER_LABELS[provider]} necesita un contacto guardado.` : 'Busca por nombre, email o teléfono.'}
              />
              {(contactSearching || contactResults.length > 0 || contactQuery.trim().length >= 2) && (
                <div className={styles.contactResults} role="listbox" aria-label="Resultados de contacto">
                  {contactSearching ? (
                    <span>Buscando...</span>
                  ) : contactResults.length > 0 ? (
                    contactResults.map((contact) => (
                      <button
                        key={contact.id}
                        type="button"
                        onClick={() => {
                          setSelectedContact(contact)
                          setContactResults([])
                        }}
                      >
                        <strong>{getContactName(contact)}</strong>
                        <small>{getContactDetail(contact)}</small>
                      </button>
                    ))
                  ) : (
                    <span>No encontramos contactos guardados con esa búsqueda.</span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <label className={styles.selectField}>
        <span>Pasarela</span>
        <PhoneSelect
          value={provider}
          onChange={(value) => setProvider(value as PaymentGatewayProvider)}
          options={providerOptions}
          title="Pasarela de suscripción"
          placeholder="Selecciona pasarela"
          disabled={providerOptions.length <= 1}
        />
      </label>

      <PhoneTextField
        label="Nombre"
        value={draft.name}
        onChange={(value) => updateDraft('name', value)}
        placeholder="Ej. Membresía mensual"
      />
      <PhoneTextField
        label={`Monto (${currency})`}
        value={draft.amount}
        onChange={(value) => updateDraft('amount', value)}
        type="number"
        placeholder="0.00"
      />

      <div className={styles.formGrid}>
        <label className={styles.selectField}>
          <span>Frecuencia</span>
          <PhoneSelect
            value={draft.intervalType}
            onChange={(value) => updateDraft('intervalType', value as SubscriptionInterval)}
            options={INTERVAL_OPTIONS.map((option) => ({
              ...option,
              disabled: provider === 'conekta' && option.value === 'daily'
            }))}
            title="Frecuencia"
          />
        </label>
        <PhoneTextField
          label="Cada"
          value={draft.intervalCount}
          onChange={(value) => updateDraft('intervalCount', value)}
          type="number"
          placeholder="1"
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
        />
      </label>

      <PhoneTextArea
        label="Notas"
        value={draft.description}
        onChange={(value) => updateDraft('description', value)}
        placeholder="Notas internas de esta suscripción."
        rows={3}
      />

      <div className={styles.actions}>
        {onCancel && (
          <PhoneButton variant="secondary" onClick={onCancel}>
            Atrás
          </PhoneButton>
        )}
        <PhoneButton loading={saving} onClick={handleSubmit} fullWidth={!onCancel}>
          Crear suscripción
        </PhoneButton>
      </div>
    </section>
  )
}
