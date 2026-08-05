import { CalendarDays, CreditCard, Repeat2 } from 'lucide-react'
import { Button } from '../Button'
import { Loading } from '../Loading'
import { Modal } from '../Modal'
import styles from './PaymentFlowSelectorModal.module.css'

export type PaymentFlowChoice = 'single' | 'partial' | 'subscription'

export interface PaymentFlowSelectorModalProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (choice: PaymentFlowChoice) => void
  loading?: boolean
  canUsePaymentPlans: boolean
  canUseSubscriptions: boolean
  canUsePaymentLinks: boolean
  hasOnlinePaymentPlanProvider: boolean
}

export function PaymentFlowSelectorModal({
  isOpen,
  onClose,
  onSelect,
  loading = false,
  canUsePaymentPlans,
  canUseSubscriptions,
  canUsePaymentLinks,
  hasOnlinePaymentPlanProvider
}: PaymentFlowSelectorModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="¿Qué tipo de cobro quieres realizar?"
      subtitle="Elige el flujo y después configura el monto, fechas y método de pago."
      type="custom"
      size="md"
    >
      {loading ? (
        <Loading compact message="Revisando pasarelas disponibles…" />
      ) : (
        <div className={styles.choices}>
          <Button
            type="button"
            variant="secondary"
            fullWidth
            className={styles.choice}
            leftIcon={<CreditCard size={20} aria-hidden="true" />}
            onClick={() => onSelect('single')}
          >
            <span className={styles.copy}>
              <strong>Cobro único</strong>
              <small>{canUsePaymentLinks
                ? 'Envía un link, cobra una tarjeta o registra un pago manual.'
                : 'Registra efectivo, transferencia, depósito u otro pago confirmado.'}</small>
            </span>
          </Button>

          {canUsePaymentPlans ? (
            <Button
              type="button"
              variant="secondary"
              fullWidth
              className={styles.choice}
              leftIcon={<CalendarDays size={20} aria-hidden="true" />}
              onClick={() => onSelect('partial')}
            >
              <span className={styles.copy}>
                <strong>Plan de pagos</strong>
                <small>{hasOnlinePaymentPlanProvider
                  ? 'Crea parcialidades offline o programa cobros con una pasarela conectada.'
                  : 'Crea parcialidades offline y registra cada pago conforme lo recibas.'}</small>
              </span>
            </Button>
          ) : null}

          {canUseSubscriptions ? (
            <Button
              type="button"
              variant="secondary"
              fullWidth
              className={styles.choice}
              leftIcon={<Repeat2 size={20} aria-hidden="true" />}
              onClick={() => onSelect('subscription')}
            >
              <span className={styles.copy}>
                <strong>Suscripción</strong>
                <small>Crea un cobro recurrente con una pasarela compatible.</small>
              </span>
            </Button>
          ) : null}
        </div>
      )}
    </Modal>
  )
}
