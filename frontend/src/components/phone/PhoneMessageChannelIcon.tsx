import React from 'react'
import { Mail, MessageCircle } from 'lucide-react'
import { FaFacebook, FaFacebookMessenger, FaInstagram } from 'react-icons/fa'
import { Icon } from '@/components/common'
import { cn } from '@/utils/cn'
import styles from './PhoneMessageChannelIcon.module.css'

export type PhoneMessageChannelIconKey =
  | 'whatsapp'
  | 'whatsapp_api'
  | 'messenger'
  | 'instagram'
  | 'email'
  | 'sms'
  | 'sms_qr'
  | 'facebook_comment'
  | 'instagram_comment'

type NormalizedPhoneMessageChannelIconKey = 'whatsapp' | 'messenger' | 'instagram' | 'email' | 'sms' | 'facebook_comment' | 'instagram_comment'
type PhoneMessageChannelIconVariant = 'glyph' | 'disc'

interface PhoneMessageChannelIconProps {
  channel: PhoneMessageChannelIconKey
  variant?: PhoneMessageChannelIconVariant
  size?: number
  className?: string
  iconClassName?: string
}

function normalizePhoneMessageChannelIconKey(channel: PhoneMessageChannelIconKey): NormalizedPhoneMessageChannelIconKey {
  if (channel === 'whatsapp_api') return 'whatsapp'
  if (channel === 'sms_qr') return 'sms'
  return channel
}

function renderPhoneMessageChannelGlyph(channel: NormalizedPhoneMessageChannelIconKey, size: number, className?: string) {
  const glyphClassName = cn(styles.glyph, className)

  if (channel === 'whatsapp') {
    return <Icon name="whatsapp" size={size} className={glyphClassName} color="currentColor" aria-hidden="true" focusable="false" />
  }

  if (channel === 'messenger') {
    return <FaFacebookMessenger size={size} className={glyphClassName} aria-hidden="true" />
  }

  if (channel === 'instagram') {
    return <FaInstagram size={size} className={glyphClassName} aria-hidden="true" />
  }

  if (channel === 'facebook_comment') {
    return <FaFacebook size={size} className={glyphClassName} aria-hidden="true" />
  }

  if (channel === 'instagram_comment') {
    return <FaInstagram size={size} className={glyphClassName} aria-hidden="true" />
  }

  if (channel === 'email') {
    return <Mail size={size} className={glyphClassName} aria-hidden="true" />
  }

  return <MessageCircle size={size} className={glyphClassName} aria-hidden="true" />
}

export function PhoneMessageChannelIcon({
  channel,
  variant = 'glyph',
  size = 18,
  className,
  iconClassName
}: PhoneMessageChannelIconProps) {
  const normalizedChannel = normalizePhoneMessageChannelIconKey(channel)

  if (variant === 'disc') {
    return (
      <span className={cn(styles.mark, className)} data-phone-message-channel={normalizedChannel} aria-hidden="true">
        {renderPhoneMessageChannelGlyph(normalizedChannel, size, cn(styles.markGlyph, iconClassName))}
      </span>
    )
  }

  return renderPhoneMessageChannelGlyph(normalizedChannel, size, className)
}
