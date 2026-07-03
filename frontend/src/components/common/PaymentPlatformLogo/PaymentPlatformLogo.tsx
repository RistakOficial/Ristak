import React from 'react'
import clipLogo from '@/assets/payment-platforms/clip.svg'
import conektaLogo from '@/assets/payment-platforms/conekta.webp'
import gigstackLogo from '@/assets/payment-platforms/gigstack.webp'
import mercadoPagoLogo from '@/assets/payment-platforms/mercadopago.webp'
import stripeLogo from '@/assets/payment-platforms/stripe.svg'
import { cn } from '@/utils/cn'
import styles from './PaymentPlatformLogo.module.css'

export type PaymentPlatformLogoId = 'stripe' | 'conekta' | 'mercadopago' | 'clip' | 'gigstack'

type PaymentPlatformLogoSize = 'sm' | 'md' | 'lg' | 'xl'

const platformLogos: Record<PaymentPlatformLogoId, { label: string; src: string }> = {
  stripe: { label: 'Stripe', src: stripeLogo },
  conekta: { label: 'Conekta', src: conektaLogo },
  mercadopago: { label: 'Mercado Pago', src: mercadoPagoLogo },
  clip: { label: 'CLIP', src: clipLogo },
  gigstack: { label: 'Gigstack', src: gigstackLogo }
}

interface PaymentPlatformLogoProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  platform: PaymentPlatformLogoId
  size?: PaymentPlatformLogoSize
  showLabel?: boolean
  decorative?: boolean
}

export const getPaymentPlatformLabel = (platform: PaymentPlatformLogoId) => platformLogos[platform].label

export const PaymentPlatformLogo: React.FC<PaymentPlatformLogoProps> = ({
  platform,
  size = 'md',
  showLabel = false,
  decorative = false,
  className,
  ...props
}) => {
  const logo = platformLogos[platform]

  return (
    <span
      {...props}
      className={cn(styles.root, showLabel && styles.withLabel, className)}
      data-platform={platform}
      data-size={size}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : logo.label}
      title={props.title || logo.label}
    >
      <img className={styles.image} src={logo.src} alt="" draggable={false} />
      {showLabel && <span className={styles.label}>{logo.label}</span>}
    </span>
  )
}
