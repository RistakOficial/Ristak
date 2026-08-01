import { useEffect, useMemo, useState } from 'react'
import { Clock } from 'lucide-react'
import { formatChatDayLabel, formatChatMessageTime, isChatTimestampToday } from '@/utils/chatTimestamps'
import {
  localDateTimeInputToUTCISOString,
  toDateTimeLocalInputValue,
  todayDateOnlyInTimezone
} from '@/utils/timezone'
import { Button } from '../Button'
import { DatePicker } from '../DatePicker'
import { Modal } from '../Modal'
import styles from './ChatScheduleModal.module.css'

type SchedulePeriod = 'AM' | 'PM'

interface ScheduleDraft {
  date: string
  hour: string
  minute: string
  period: SchedulePeriod
}

export interface ChatScheduleModalProps {
  isOpen: boolean
  onClose: () => void
  message: string
  onMessageChange: (message: string) => void
  onSubmit: (scheduledAt: string) => void | Promise<void>
  timezone: string
  editing?: boolean
  initialScheduledAt?: string | null
  submitting?: boolean
  error?: string
  onClearError?: () => void
}

const padTwoDigits = (value: number) => String(value).padStart(2, '0')

const formatDateInputValue = (date: Date) => (
  `${date.getFullYear()}-${padTwoDigits(date.getMonth() + 1)}-${padTwoDigits(date.getDate())}`
)

const createDefaultScheduleDraft = (timezone: string): ScheduleDraft => {
  const date = new Date(toDateTimeLocalInputValue(new Date(Date.now() + 15 * 60 * 1000), timezone))
  const minutes = date.getMinutes()
  date.setMinutes(minutes + ((5 - (minutes % 5)) % 5), 0, 0)

  const hour24 = date.getHours()
  return {
    date: formatDateInputValue(date),
    hour: String(hour24 % 12 || 12),
    minute: padTwoDigits(date.getMinutes()),
    period: hour24 >= 12 ? 'PM' : 'AM'
  }
}

const createScheduleDraftFromDate = (value: string | null | undefined, timezone: string): ScheduleDraft => {
  if (!value) return createDefaultScheduleDraft(timezone)

  const date = new Date(toDateTimeLocalInputValue(value, timezone))
  if (Number.isNaN(date.getTime())) return createDefaultScheduleDraft(timezone)

  const hour24 = date.getHours()
  return {
    date: formatDateInputValue(date),
    hour: String(hour24 % 12 || 12),
    minute: padTwoDigits(date.getMinutes()),
    period: hour24 >= 12 ? 'PM' : 'AM'
  }
}

const getScheduledAtFromDraft = (draft: ScheduleDraft, timezone: string) => {
  const hour = Number(draft.hour)
  const minute = Number(draft.minute)
  if (!draft.date || !Number.isFinite(hour) || !Number.isFinite(minute)) return null
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null

  const hour24 = draft.period === 'PM'
    ? (hour === 12 ? 12 : hour + 12)
    : (hour === 12 ? 0 : hour)
  const localInput = `${draft.date}T${padTwoDigits(hour24)}:${padTwoDigits(minute)}`
  const scheduledAt = localDateTimeInputToUTCISOString(localInput, timezone)
  if (!scheduledAt) return null

  const date = new Date(scheduledAt)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const formatSchedulePreviewLabel = (value: string | null, timezone: string) => {
  if (!value) return 'Elige fecha y hora'

  const time = formatChatMessageTime(value, timezone)
  if (isChatTimestampToday(value, timezone)) return `Se enviará a las ${time}`

  return `Se enviará el ${formatChatDayLabel(value, timezone)} a las ${time}`.trim()
}

export function ChatScheduleModal({
  isOpen,
  onClose,
  message,
  onMessageChange,
  onSubmit,
  timezone,
  editing = false,
  initialScheduledAt = null,
  submitting = false,
  error = '',
  onClearError
}: ChatScheduleModalProps) {
  const [draft, setDraft] = useState<ScheduleDraft>(() => createDefaultScheduleDraft(timezone))
  const [localError, setLocalError] = useState('')

  useEffect(() => {
    if (!isOpen) return
    setDraft(createScheduleDraftFromDate(initialScheduledAt, timezone))
    setLocalError('')
  }, [initialScheduledAt, isOpen, timezone])

  const scheduledAt = useMemo(() => getScheduledAtFromDraft(draft, timezone), [draft, timezone])
  const displayError = error || localError
  const canSubmit = Boolean(scheduledAt && message.trim() && !submitting)

  const clearError = () => {
    setLocalError('')
    onClearError?.()
  }

  const updateDraft = (patch: Partial<ScheduleDraft>) => {
    setDraft((current) => ({ ...current, ...patch }))
    clearError()
  }

  const handleSubmit = async () => {
    if (!message.trim()) {
      setLocalError('Escribe el mensaje que quieres programar.')
      return
    }
    if (!scheduledAt) {
      setLocalError('Revisa la fecha y la hora.')
      return
    }
    if (new Date(scheduledAt).getTime() < Date.now() + 10 * 1000) {
      setLocalError('Elige una hora que todavía no haya pasado.')
      return
    }

    await onSubmit(scheduledAt)
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editing ? 'Editar programación' : 'Programar mensaje'}
      size="sm"
    >
      <form
        className={styles.body}
        onSubmit={(event) => {
          event.preventDefault()
          void handleSubmit()
        }}
      >
        <p className={styles.description}>
          {editing
            ? 'Ajusta cuándo saldrá este mensaje.'
            : 'El mensaje se guardará y saldrá automáticamente a la hora elegida.'}
        </p>

        <label className={`${styles.field} ${styles.messageField}`}>
          <span>Mensaje</span>
          <textarea
            value={message}
            onChange={(event) => {
              onMessageChange(event.target.value)
              clearError()
            }}
            placeholder="Escribe el mensaje que quieres programar"
            rows={3}
            disabled={submitting}
          />
        </label>

        <div className={styles.field}>
          <span>Fecha</span>
          <DatePicker
            value={draft.date}
            min={todayDateOnlyInTimezone(timezone)}
            today={todayDateOnlyInTimezone(timezone)}
            ariaLabel="Fecha"
            disabled={submitting}
            onChange={(date) => updateDraft({ date })}
          />
        </div>

        <div className={styles.timeRow}>
          <label className={styles.field}>
            <span>Hora</span>
            <input
              type="text"
              inputMode="numeric"
              value={draft.hour}
              onChange={(event) => updateDraft({ hour: event.target.value.replace(/\D/g, '').slice(0, 2) })}
              disabled={submitting}
            />
          </label>
          <label className={styles.field}>
            <span>Min</span>
            <input
              type="text"
              inputMode="numeric"
              value={draft.minute}
              onChange={(event) => updateDraft({ minute: event.target.value.replace(/\D/g, '').slice(0, 2) })}
              onBlur={() => {
                const minute = Math.min(59, Math.max(0, Number(draft.minute) || 0))
                updateDraft({ minute: padTwoDigits(minute) })
              }}
              disabled={submitting}
            />
          </label>
          <div className={styles.periodToggle} role="group" aria-label="AM o PM">
            {(['AM', 'PM'] as SchedulePeriod[]).map((period) => (
              <Button
                key={period}
                type="button"
                variant="ghost"
                size="sm"
                className={draft.period === period ? styles.periodActive : ''}
                onClick={() => updateDraft({ period })}
                disabled={submitting}
                aria-pressed={draft.period === period}
              >
                {period}
              </Button>
            ))}
          </div>
        </div>

        <div className={styles.preview} aria-live="polite">
          <Clock size={15} aria-hidden="true" />
          <span>{formatSchedulePreviewLabel(scheduledAt, timezone)}</span>
        </div>

        {displayError ? <p className={styles.error}>{displayError}</p> : null}

        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button type="submit" disabled={!canSubmit} loading={submitting}>
            {editing ? 'Guardar cambios' : 'Programar'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
