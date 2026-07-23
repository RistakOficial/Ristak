import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Clock3 } from 'lucide-react'
import { Button } from '../Button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../DropdownMenu'
import styles from './TimePickerSelect.module.css'

type TimePeriod = 'AM' | 'PM'

interface TimeParts {
  hour: number
  minute: number
  period: TimePeriod
}

export interface TimePickerSelectProps {
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  className?: string
  allowLastMinute?: boolean
  confirmLabel?: string
  'aria-label': string
}

const HOURS = Array.from({ length: 12 }, (_, index) => index + 1)
const FIVE_MINUTE_OPTIONS = Array.from({ length: 12 }, (_, index) => index * 5)

const padTimePart = (value: number) => String(value).padStart(2, '0')

const parseTimeParts = (value: string): TimeParts => {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || '').trim())
  const hour24 = match ? Number(match[1]) : 9
  const minute = match ? Number(match[2]) : 0
  const safeHour = Number.isInteger(hour24) && hour24 >= 0 && hour24 <= 23 ? hour24 : 9
  const safeMinute = Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0
  return {
    hour: safeHour % 12 || 12,
    minute: safeMinute,
    period: safeHour >= 12 ? 'PM' : 'AM'
  }
}

const timePartsToValue = ({ hour, minute, period }: TimeParts) => {
  const hour24 = period === 'AM'
    ? hour % 12
    : (hour % 12) + 12
  return `${padTimePart(hour24)}:${padTimePart(minute)}`
}

const formatTimeValue = (value: string) => {
  const parts = parseTimeParts(value)
  return `${padTimePart(parts.hour)}:${padTimePart(parts.minute)} ${parts.period}`
}

export const TimePickerSelect: React.FC<TimePickerSelectProps> = ({
  value,
  onValueChange,
  disabled = false,
  className = '',
  allowLastMinute = false,
  confirmLabel = 'De acuerdo',
  'aria-label': ariaLabel
}) => {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<TimeParts>(() => parseTimeParts(value))
  const contentRef = useRef<HTMLDivElement>(null)
  const draftValue = timePartsToValue(draft)
  const minuteOptions = useMemo(() => {
    const options = new Set(FIVE_MINUTE_OPTIONS)
    options.add(draft.minute)
    if (allowLastMinute) options.add(59)
    return [...options].sort((left, right) => left - right)
  }, [allowLastMinute, draft.minute])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => {
      const selectedOptions = contentRef.current
        ?.querySelectorAll<HTMLElement>('[role="menuitemradio"][data-state="checked"]')
      selectedOptions?.forEach(option => {
        const column = option.parentElement
        if (!column) return
        column.scrollTop = option.offsetTop - ((column.clientHeight - option.clientHeight) / 2)
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setDraft(parseTimeParts(value))
    setOpen(nextOpen)
  }

  const commitDraft = () => {
    onValueChange(timePartsToValue(draft))
    setOpen(false)
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={`${styles.trigger} ${className}`}
          disabled={disabled}
          aria-label={ariaLabel}
          data-ristak-dropdown-trigger
        >
          <span>{formatTimeValue(open ? draftValue : value)}</span>
          <Clock3 size={15} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={contentRef}
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className={styles.content}
        aria-label={ariaLabel}
      >
        <div className={styles.columnLabels} aria-hidden="true">
          <span>Hora</span>
          <span>Min</span>
          <span>AM/PM</span>
        </div>
        <div className={styles.columns}>
          <DropdownMenuRadioGroup
            value={String(draft.hour)}
            onValueChange={(hour) => setDraft(current => ({ ...current, hour: Number(hour) }))}
            className={styles.column}
            aria-label="Hora"
          >
            {HOURS.map(hour => (
              <DropdownMenuRadioItem
                key={hour}
                value={String(hour)}
                className={styles.option}
                onSelect={(event) => event.preventDefault()}
              >
                {padTimePart(hour)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>

          <DropdownMenuRadioGroup
            value={String(draft.minute)}
            onValueChange={(minute) => setDraft(current => ({ ...current, minute: Number(minute) }))}
            className={styles.column}
            aria-label="Minuto"
          >
            {minuteOptions.map(minute => (
              <DropdownMenuRadioItem
                key={minute}
                value={String(minute)}
                className={styles.option}
                onSelect={(event) => event.preventDefault()}
              >
                {padTimePart(minute)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>

          <DropdownMenuRadioGroup
            value={draft.period}
            onValueChange={(period) => setDraft(current => ({ ...current, period: period as TimePeriod }))}
            className={styles.column}
            aria-label="AM o PM"
          >
            {(['AM', 'PM'] as const).map(period => (
              <DropdownMenuRadioItem
                key={period}
                value={period}
                className={styles.option}
                onSelect={(event) => event.preventDefault()}
              >
                {period}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </div>

        <div className={styles.preview} aria-live="polite" aria-atomic="true">
          <span>Horario seleccionado</span>
          <strong>{formatTimeValue(draftValue)}</strong>
        </div>

        <div className={styles.actions}>
          <DropdownMenuItem
            asChild
            unstyled
            onSelect={(event) => {
              event.preventDefault()
              commitDraft()
            }}
          >
            <Button type="button" size="small" fullWidth>
              {confirmLabel}
            </Button>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default TimePickerSelect
