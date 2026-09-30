import { useEffect, useId, useState } from 'react'
import { Button } from '../Button'
import { CustomSelect } from '../CustomSelect'
import { Loading } from '../Loading'
import { stripePaymentsService } from '@/services/stripePaymentsService'
import { conektaPaymentsService } from '@/services/conektaPaymentsService'
import { rebillPaymentsService } from '@/services/rebillPaymentsService'

type CardProvider = 'stripe' | 'conekta' | 'rebill'
interface SavedCardChoice { key: string; provider: CardProvider; methodId: string; label: string }

interface Props {
  planId: string
  contactId: string
  currentMode: 'offline' | 'automatic'
  connected: Record<CardProvider, boolean>
  disabled?: boolean
  controlsClassName?: string
  fieldClassName?: string
  onApply: (changes: { collectionMode: 'offline' | 'automatic'; paymentProvider?: CardProvider; paymentMethodId?: string }) => Promise<void>
}

export function PaymentPlanCollectionControls({ planId, contactId, currentMode, connected, disabled, controlsClassName, fieldClassName, onApply }: Props) {
  const id = useId()
  const [mode, setMode] = useState(currentMode)
  const [cards, setCards] = useState<SavedCardChoice[]>([])
  const [cardKey, setCardKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { setMode(currentMode); setCardKey(''); setError('') }, [planId, currentMode])
  useEffect(() => {
    let cancelled = false
    setCards([])
    setCardKey('')
    if (mode !== 'automatic' || !contactId) { setLoading(false); return }
    setLoading(true)
    const requests: Array<{ provider: CardProvider; read: () => Promise<SavedCardChoice[]> }> = [
      { provider: 'stripe', read: async () => (await stripePaymentsService.getSavedPaymentMethods(contactId)).map(card => ({ key: `stripe:${card.id}`, provider: 'stripe', methodId: card.stripePaymentMethodId, label: `Stripe · ${card.label}` })) },
      { provider: 'conekta', read: async () => (await conektaPaymentsService.getSavedPaymentSources(contactId)).map(card => ({ key: `conekta:${card.id}`, provider: 'conekta', methodId: card.conektaPaymentSourceId, label: `Conekta · ${card.label}` })) },
      { provider: 'rebill', read: async () => (await rebillPaymentsService.getSavedPaymentSources(contactId)).map(card => ({ key: `rebill:${card.id}`, provider: 'rebill', methodId: card.rebillCardId, label: `Rebill · ${card.label}` })) }
    ].filter(request => connected[request.provider as CardProvider]) as Array<{ provider: CardProvider; read: () => Promise<SavedCardChoice[]> }>
    Promise.allSettled(requests.map(request => request.read())).then(results => {
      if (cancelled) return
      setCards(results.flatMap(result => result.status === 'fulfilled' ? result.value : []))
      setError(results.some(result => result.status === 'rejected') ? 'No se pudieron consultar todas las tarjetas. Vuelve a abrir el plan para actualizar.' : '')
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [mode, contactId, connected.stripe, connected.conekta, connected.rebill])

  const apply = async () => {
    const card = cards.find(item => item.key === cardKey)
    if (mode === 'automatic' && !card) return
    setError('')
    try {
      await onApply({ collectionMode: mode, ...(card ? { paymentProvider: card.provider, paymentMethodId: card.methodId } : {}) })
    } catch (failure: any) {
      setError(failure?.message || 'No se pudo cambiar la forma de cobro.')
    }
  }

  return (
    <>
      <div className={controlsClassName}>
        <div className={fieldClassName}>
          <label htmlFor={`${id}-mode`}>Forma de cobro del plan</label>
          <CustomSelect id={`${id}-mode`} aria-label="Forma de cobro del plan" value={mode} disabled={disabled} onChange={event => setMode(event.target.value as typeof mode)}>
            <option value="offline">Offline · sólo recordatorios</option>
            <option value="automatic">Domiciliar tarjeta guardada</option>
          </CustomSelect>
        </div>
        {mode === 'automatic' && (
          <div className={fieldClassName}>
            <label htmlFor={`${id}-card`}>Tarjeta autorizada para este plan</label>
            {loading ? <Loading compact /> : (
              <CustomSelect id={`${id}-card`} aria-label="Tarjeta autorizada para este plan" value={cardKey} disabled={disabled || !cards.length} onChange={event => setCardKey(event.target.value)}>
                <option value="">{cards.length ? 'Elige una tarjeta' : 'Sin tarjetas guardadas compatibles'}</option>
                {cards.map(card => <option key={card.key} value={card.key}>{card.label}</option>)}
              </CustomSelect>
            )}
          </div>
        )}
        <Button type="button" variant="secondary" disabled={disabled || loading || (mode === 'automatic' ? !cardKey : mode === currentMode)} onClick={apply}>
          Aplicar forma de cobro
        </Button>
      </div>
      <p role={error ? 'alert' : undefined}>
        {error || (mode === 'offline'
          ? 'Una tarjeta guardada o un pago por enlace no activa domiciliación. Los avisos siguen los ajustes de recordatorios de Pagos.'
          : 'Aplica sólo si el cliente autorizó domiciliar este plan. Se cobrarán los pagos pendientes en sus fechas; los planes pausados siguen pausados.')}
      </p>
    </>
  )
}
