import React from 'react'
import { Mail, MessageCircle } from 'lucide-react'
import { FaFacebook, FaFacebookMessenger, FaInstagram } from 'react-icons/fa'
import facebookBadge from '@/assets/channel-badges/facebook.webp'
import gmailBadge from '@/assets/channel-badges/gmail.webp'
import instagramBadge from '@/assets/channel-badges/instagram.webp'
import messengerBadge from '@/assets/channel-badges/messenger.webp'
import whatsappBadge from '@/assets/channel-badges/whatsapp.webp'
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
  | 'facebook'
  | 'facebook_comment'
  | 'instagram_comment'
  | 'gmail'
  | 'webchat'
  | 'meta'
  | 'unknown'

type NormalizedPhoneMessageChannelIconKey = 'whatsapp' | 'messenger' | 'instagram' | 'facebook' | 'email' | 'sms' | 'webchat' | 'meta' | 'unknown'
type PhoneMessageChannelIconVariant = 'glyph' | 'disc' | 'asset'

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
  if (channel === 'facebook_comment') return 'facebook'
  if (channel === 'instagram_comment') return 'instagram'
  if (channel === 'gmail') return 'email'
  return channel
}

const PHONE_MESSAGE_CHANNEL_ASSETS: Partial<Record<NormalizedPhoneMessageChannelIconKey, string>> = {
  whatsapp: whatsappBadge,
  messenger: messengerBadge,
  instagram: instagramBadge,
  facebook: facebookBadge,
  email: gmailBadge,
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

  if (channel === 'facebook') {
    return <FaFacebook size={size} className={glyphClassName} aria-hidden="true" />
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

  if (variant === 'asset') {
    const asset = PHONE_MESSAGE_CHANNEL_ASSETS[normalizedChannel]
    if (asset) {
      return (
        <img
          src={asset}
          width={size}
          height={size}
          className={cn(styles.asset, className)}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      )
    }
    return renderPhoneMessageChannelGlyph(normalizedChannel, size, cn(styles.assetFallback, className))
  }

  if (variant === 'disc') {
    return (
      <span className={cn(styles.mark, className)} data-phone-message-channel={normalizedChannel} aria-hidden="true">
        {renderPhoneMessageChannelGlyph(normalizedChannel, size, cn(styles.markGlyph, iconClassName))}
      </span>
    )
  }

  return renderPhoneMessageChannelGlyph(normalizedChannel, size, className)
}
