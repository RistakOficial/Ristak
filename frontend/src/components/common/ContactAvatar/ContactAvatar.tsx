import { useEffect, useState, type ReactNode } from 'react'
import { getContactAvatarUrl, getContactInitials, type ContactAvatarSource } from '@/utils/contactAvatar'

interface ContactAvatarProps {
  contact?: ContactAvatarSource | null
  className?: string
  avatarUrl?: string | null
  initials?: string
  alt?: string
  children?: ReactNode
}

const clean = (value?: string | null) => String(value || '').trim()

export function ContactAvatar({
  contact,
  className,
  avatarUrl,
  initials,
  alt,
  children
}: ContactAvatarProps) {
  const resolvedAvatarUrl = clean(avatarUrl) || getContactAvatarUrl(contact)
  const [failedUrl, setFailedUrl] = useState('')
  const imageFailed = Boolean(resolvedAvatarUrl && failedUrl === resolvedAvatarUrl)
  const showImage = Boolean(resolvedAvatarUrl && !imageFailed)
  const fallback = clean(initials) || getContactInitials(contact)
  const imageAlt = clean(alt)
  const hiddenProps = imageAlt ? {} : { 'aria-hidden': true as const }

  useEffect(() => {
    if (failedUrl && failedUrl !== resolvedAvatarUrl) {
      setFailedUrl('')
    }
  }, [failedUrl, resolvedAvatarUrl])

  return (
    <span className={className} {...hiddenProps}>
      {showImage ? (
        <img
          src={resolvedAvatarUrl}
          alt={imageAlt}
          decoding="async"
          loading="lazy"
          onError={() => setFailedUrl(resolvedAvatarUrl)}
        />
      ) : fallback}
      {children}
    </span>
  )
}
