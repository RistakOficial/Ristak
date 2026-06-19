import { Check, Loader2, MoreHorizontal, Star } from 'lucide-react'
import type { ContactPhoneNumber } from '@/types'
import { Badge } from '../Badge'
import { Button } from '../Button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../DropdownMenu'
import { InlineEditableText } from '../InlineEditableText'
import styles from './ContactPhoneSelector.module.css'

interface ContactPhoneSelectorProps {
  phones: ContactPhoneNumber[]
  disabled?: boolean
  emptyLabel?: string
  savingPhone?: string | null
  onSavePrimaryPhone?: (value: string) => Promise<void> | void
  onMakePrimary?: (phone: string) => Promise<void> | void
}

const isPrimaryPhone = (phone: ContactPhoneNumber) => Boolean(phone.isPrimary || phone.is_primary)

export function ContactPhoneSelector({
  phones,
  disabled = false,
  emptyLabel = 'Sin telefono',
  savingPhone = null,
  onSavePrimaryPhone,
  onMakePrimary
}: ContactPhoneSelectorProps) {
  const canChoosePrimary = Boolean(onMakePrimary)

  if (phones.length === 0) {
    return (
      <div className={styles.phoneList}>
        <div className={styles.phoneRow}>
          <InlineEditableText
            value=""
            emptyLabel={emptyLabel}
            ariaLabel="Editar teléfono del contacto"
            type="tel"
            inputMode="tel"
            layout="block"
            disabled={disabled || !onSavePrimaryPhone}
            onSave={(value) => onSavePrimaryPhone?.(value)}
          />
        </div>
      </div>
    )
  }

  return (
    <div className={styles.phoneList}>
      {phones.map((phoneEntry) => {
        const phone = String(phoneEntry.phone || '').trim()
        const isPrimary = isPrimaryPhone(phoneEntry)
        const isSaving = savingPhone === phone
        const menuLabel = isPrimary
          ? `${phone} ya es el número principal`
          : `Convertir ${phone} en número principal`

        return (
          <div
            key={phoneEntry.id || phone}
            className={styles.phoneRow}
            data-primary={isPrimary ? 'true' : undefined}
          >
            <div className={styles.phoneMain}>
              {isPrimary && onSavePrimaryPhone ? (
                <InlineEditableText
                  value={phone}
                  emptyLabel={emptyLabel}
                  ariaLabel="Editar teléfono principal del contacto"
                  type="tel"
                  inputMode="tel"
                  layout="block"
                  disabled={disabled}
                  onSave={(value) => onSavePrimaryPhone(value)}
                />
              ) : (
                <span className={styles.phoneText}>{phone}</span>
              )}
              {isPrimary ? (
                <span
                  className={styles.phoneStatusIcon}
                  data-primary="true"
                  aria-hidden="true"
                >
                  <Star size={13} fill="currentColor" />
                </span>
              ) : null}
            </div>

            <div className={styles.phoneActions}>
              <Badge variant={isPrimary ? 'primary' : 'neutral'} className={styles.phoneBadge}>
                {isPrimary ? 'Principal' : 'Secundario'}
              </Badge>

              {canChoosePrimary ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={styles.phoneMenuButton}
                      title={menuLabel}
                      aria-label={menuLabel}
                      disabled={disabled || isSaving}
                    >
                      {isSaving ? (
                        <Loader2 size={14} className={styles.spinIcon} aria-hidden="true" />
                      ) : (
                        <MoreHorizontal size={15} aria-hidden="true" />
                      )}
                      <span className={styles.srOnly}>{menuLabel}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={6}>
                    <DropdownMenuItem
                      disabled={isPrimary || disabled}
                      onSelect={() => {
                        if (!isPrimary && phone) {
                          void onMakePrimary?.(phone)
                        }
                      }}
                    >
                      {isPrimary ? <Check size={14} /> : <Star size={14} />}
                    <span>{isPrimary ? 'Número principal' : 'Convertir en principal'}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
