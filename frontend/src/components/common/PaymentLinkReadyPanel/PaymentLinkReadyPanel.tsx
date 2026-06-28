import { useEffect, useMemo, useState } from 'react'
import { Copy, ExternalLink, Link as LinkIcon, Loader2, Mail, MessageCircle, Send } from 'lucide-react'
import { Button } from '../Button'
import { PaymentPlatformLogo, type PaymentPlatformLogoId } from '../PaymentPlatformLogo'
import { useNotification } from '@/contexts/NotificationContext'
import { contactsService, type PaymentLinkDeliveryChannelKey, type PaymentLinkDeliveryOptions } from '@/services/contactsService'
import { emailService } from '@/services/emailService'
import { whatsappApiService } from '@/services/whatsappApiService'
import { formatCurrency as formatMxCurrency } from '@/utils/format'
import styles from './PaymentLinkReadyPanel.module.css'

export type PaymentLinkReadyKind = 'single' | 'first_payment' | 'card_setup' | 'subscription_start'

export interface PaymentLinkReadyContact {
  id: string
  name?: string | null
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  phone?: string | null
}

export interface PaymentLinkReadyData {
  kind: PaymentLinkReadyKind
  title: string
  description: string
  provider?: PaymentPlatformLogoId
  paymentUrl: string
  amount: number
  currency: string
  contact: PaymentLinkReadyContact
  paymentId?: string | null
  publicPaymentId?: string | null
}

interface PaymentLinkReadyPanelProps {
  link: PaymentLinkReadyData
  businessName?: string
  getShareText?: (link: PaymentLinkReadyData) => string
  getEmailSubject?: (link: PaymentLinkReadyData) => string
}

const DELIVERY_CHANNELS: PaymentLinkDeliveryChannelKey[] = ['whatsapp', 'messenger', 'instagram', 'email']

function getContactDisplayName(contact?: PaymentLinkReadyContact | null) {
  return contact?.name ||
    `${contact?.firstName || ''} ${contact?.lastName || ''}`.trim() ||
    contact?.email ||
    contact?.phone ||
    'Sin nombre'
}

async function copyTextToClipboard(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
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

function getDefaultShareText(link: PaymentLinkReadyData) {
  const contactName = getContactDisplayName(link.contact)
  const amountText = link.amount > 0 ? ` por ${formatMxCurrency(link.amount, link.currency)}` : ''
  const intro = link.kind === 'card_setup'
    ? `Hola ${contactName}, te comparto el enlace para domiciliar tu tarjeta${amountText} y activar tu plan de pagos:`
    : link.kind === 'first_payment'
      ? `Hola ${contactName}, te comparto el enlace del primer pago${amountText}. Al pagarlo se guarda tu tarjeta para los siguientes cobros programados:`
      : link.kind === 'subscription_start'
        ? `Hola ${contactName}, te comparto el enlace del primer pago de tu suscripción${amountText}:`
        : `Hola ${contactName}, te comparto tu enlace de pago${amountText}:`

  return `${intro}\n${link.paymentUrl}`
}

function getDefaultEmailSubject(link: PaymentLinkReadyData, businessName = 'Ristak') {
  if (link.kind === 'card_setup') return `Domiciliación de tarjeta - ${businessName}`
  if (link.kind === 'first_payment') return `Primer pago - ${businessName}`
  if (link.kind === 'subscription_start') return `Primer pago de suscripción - ${businessName}`
  return `Enlace de pago - ${businessName}`
}

function getChannelIcon(channel: PaymentLinkDeliveryChannelKey) {
  if (channel === 'email') return <Mail size={16} />
  if (channel === 'messenger') return <Send size={16} />
  return <MessageCircle size={16} />
}

export function PaymentLinkReadyPanel({
  link,
  businessName = 'Ristak',
  getShareText = getDefaultShareText,
  getEmailSubject
}: PaymentLinkReadyPanelProps) {
  const { showToast } = useNotification()
  const [deliveryOptions, setDeliveryOptions] = useState<PaymentLinkDeliveryOptions | null>(null)
  const [loadingDeliveryOptions, setLoadingDeliveryOptions] = useState(false)
  const [sendingChannel, setSendingChannel] = useState<PaymentLinkDeliveryChannelKey | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadDeliveryOptions() {
      if (!link.contact.id) {
        setDeliveryOptions(null)
        return
      }

      setLoadingDeliveryOptions(true)
      try {
        const options = await contactsService.getPaymentLinkDeliveryOptions(link.contact.id)
        if (!cancelled) setDeliveryOptions(options)
      } catch {
        if (!cancelled) setDeliveryOptions(null)
      } finally {
        if (!cancelled) setLoadingDeliveryOptions(false)
      }
    }

    setDeliveryOptions(null)
    setSendingChannel(null)
    void loadDeliveryOptions()

    return () => {
      cancelled = true
    }
  }, [link.contact.id, link.paymentUrl])

  const availableChannels = useMemo(() => (
    DELIVERY_CHANNELS
      .map(channel => deliveryOptions?.channels[channel])
      .filter((channel): channel is NonNullable<typeof channel> => Boolean(channel?.available))
  ), [deliveryOptions])

  const handleCopy = async () => {
    const copied = await copyTextToClipboard(link.paymentUrl)
    showToast(
      copied ? 'success' : 'error',
      copied ? 'Enlace copiado' : 'No se pudo copiar el enlace'
    )
  }

  const handleOpen = () => {
    if (typeof window === 'undefined') return
    window.open(link.paymentUrl, '_blank', 'noopener,noreferrer')
  }

  const handleSend = async (channel: PaymentLinkDeliveryChannelKey) => {
    const deliveryChannel = deliveryOptions?.channels[channel]
    if (!deliveryChannel?.available) {
      showToast('error', 'Canal no disponible', deliveryChannel?.reason || 'Este contacto no tiene ese canal conectado.')
      return
    }

    setSendingChannel(channel)
    try {
      const message = getShareText(link)
      const externalId = `payment_link_${link.kind}_${channel}_${Date.now()}`

      if (channel === 'email') {
        await emailService.send({
          contactId: link.contact.id,
          to: deliveryChannel.value || link.contact.email || '',
          subject: getEmailSubject ? getEmailSubject(link) : getDefaultEmailSubject(link, businessName),
          text: message,
          externalId,
          includeSignature: true
        })
      } else if (channel === 'whatsapp') {
        await whatsappApiService.sendText({
          contactId: link.contact.id,
          to: deliveryChannel.value || link.contact.phone || '',
          text: message,
          externalId
        })
      } else {
        await whatsappApiService.sendMetaSocialText({
          contactId: link.contact.id,
          platform: channel,
          message,
          externalId
        })
      }

      showToast('success', 'Enlace enviado', `Se mandó por ${deliveryChannel.label}.`)
    } catch (error) {
      showToast('error', `No se pudo enviar por ${deliveryChannel.label}`, error instanceof Error ? error.message : 'Intenta copiar el enlace y mandarlo manualmente.')
    } finally {
      setSendingChannel(null)
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.icon}>
          {link.provider ? (
            <PaymentPlatformLogo platform={link.provider} size="md" decorative />
          ) : (
            <LinkIcon size={20} aria-hidden="true" />
          )}
        </div>
        <div className={styles.title}>
          <p>{link.title}</p>
          <span>{link.description}</span>
        </div>
      </div>

      <div className={styles.meta}>
        <div>
          <span>Cliente</span>
          <strong>{getContactDisplayName(link.contact)}</strong>
        </div>
        <div>
          <span>Monto</span>
          <strong>{formatMxCurrency(link.amount, link.currency)}</strong>
        </div>
      </div>

      <div className={styles.linkBox}>
        <label>Enlace público de pago</label>
        <div className={styles.linkActions}>
          <div className={styles.url}>{link.paymentUrl}</div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            leftIcon={<Copy size={15} />}
            onClick={handleCopy}
          >
            Copiar
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            leftIcon={<ExternalLink size={15} />}
            onClick={handleOpen}
          >
            Abrir
          </Button>
        </div>
      </div>

      <div className={styles.delivery}>
        <div className={styles.deliveryHeader}>
          <p>Enviar por</p>
          <span>Solo aparecen los canales conectados para este contacto.</span>
        </div>

        {loadingDeliveryOptions ? (
          <div className={styles.deliveryLoading}>
            <Loader2 size={16} aria-hidden="true" />
            Revisando canales...
          </div>
        ) : availableChannels.length > 0 ? (
          <div className={styles.channelActions}>
            {availableChannels.map(channel => (
              <Button
                key={channel.key}
                type="button"
                variant="secondary"
                size="sm"
                leftIcon={getChannelIcon(channel.key)}
                loading={sendingChannel === channel.key}
                disabled={Boolean(sendingChannel)}
                onClick={() => handleSend(channel.key)}
              >
                {channel.label}
              </Button>
            ))}
          </div>
        ) : (
          <p className={styles.deliveryEmpty}>
            Este contacto no tiene canales conectados para envío directo. Copia el enlace y mándalo manualmente.
          </p>
        )}
      </div>
    </div>
  )
}
