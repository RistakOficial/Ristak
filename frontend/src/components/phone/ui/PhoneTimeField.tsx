import React, { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Clock } from 'lucide-react'
import { PhoneSheet } from './PhoneSheet'
import styles from './PhoneTimeField.module.css'

interface PhoneTimeFieldProps {
  /** Hora en formato 'HH:mm' (24 horas). */
  value: string
  onChange: (value: string) => void
  label?: string
  title?: string
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  /** Cada cuántos minutos se generan los horarios rápidos. */
  quickStepMinutes?: number
  /** Rango de horarios rápidos (hora inicial y final, 24h). */
  quickStartHour?: number
  quickEndHour?: number
  className?: string
}

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || '')
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

function toValue(hour: number, minute: number) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function formatTimeLabel(value: string): string {
  const parsed = parseTime(value)
  if (!parsed) return ''
  const period = parsed.hour >= 12 ? 'p.m.' : 'a.m.'
  const hour12 = parsed.hour % 12 || 12
  return `${hour12}:${String(parsed.minute).padStart(2, '0')} ${period}`
}

/**
 * Selector de hora estándar del celular: abre un sheet con horarios rápidos
 * para elegir de un toque, más ajuste fino de hora/minutos para casos especiales.
 */
export const PhoneTimeField: React.FC<PhoneTimeFieldProps> = ({
  value,
  onChange,
  label,
  title = 'Elige la hora',
  placeholder = 'Selecciona hora',
  disabled = false,
  invalid = false,
  quickStepMinutes = 30,
  quickStartHour = 7,
  quickEndHour = 21,
  className = ''
}) => {
  const [open, setOpen] = useState(false)
  const parsed = parseTime(value)

  const quickTimes = useMemo(() => {
    const times: string[] = []
    for (let minutes = quickStartHour * 60; minutes <= quickEndHour * 60; minutes += quickStepMinutes) {
      times.push(toValue(Math.floor(minutes / 60), minutes % 60))
    }
    return times
  }, [quickEndHour, quickStartHour, quickStepMinutes])

  const selectQuickTime = (time: string) => {
    onChange(time)
    setOpen(false)
  }

  const currentHour12 = parsed ? parsed.hour % 12 || 12 : 9
  const currentMinute = parsed?.minute ?? 0
  const currentPeriod: 'am' | 'pm' = parsed && parsed.hour >= 12 ? 'pm' : 'am'

  const applyParts = (hour12: number, minute: number, period: 'am' | 'pm') => {
    const hour24 = period === 'pm' && hour12 !== 12
      ? hour12 + 12
      : period === 'am' && hour12 === 12
        ? 0
        : hour12
    onChange(toValue(hour24, minute))
  }

  const adjustHour = (delta: number) => {
    applyParts(((currentHour12 - 1 + delta + 12) % 12) + 1, currentMinute, currentPeriod)
  }

  const adjustMinute = (delta: number) => {
    applyParts(currentHour12, (currentMinute + delta + 60) % 60, currentPeriod)
  }

  return (
    <div className={`${styles.host} ${className}`.trim()}>
      {label && <span className={styles.label}>{label}</span>}
      <button
        type="button"
        className={`${styles.trigger} ${invalid ? styles.invalid : ''}`.trim()}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label || title}
        onClick={() => !disabled && setOpen(true)}
      >
        <Clock size={17} />
        <span className={parsed ? styles.value : styles.placeholder}>
          {parsed ? formatTimeLabel(value) : placeholder}
        </span>
      </button>

      <PhoneSheet isOpen={open} onClose={() => setOpen(false)} title={title}>
        <div className={styles.quickGrid} role="listbox" aria-label="Horarios rápidos">
          {quickTimes.map((time) => (
            <button
              key={time}
              type="button"
              role="option"
              aria-selected={time === value}
              className={`${styles.quickChip} ${time === value ? styles.quickChipSelected : ''}`.trim()}
              onClick={() => selectQuickTime(time)}
            >
              {formatTimeLabel(time)}
            </button>
          ))}
        </div>

        <div className={styles.fineSection}>
          <p className={styles.fineTitle}>Otra hora</p>
          <div className={styles.fineRow}>
            <div className={styles.stepper}>
              <button type="button" onClick={() => adjustHour(-1)} aria-label="Una hora menos">
                <ChevronLeft size={18} />
              </button>
              <strong>{String(currentHour12).padStart(2, '0')}</strong>
              <button type="button" onClick={() => adjustHour(1)} aria-label="Una hora más">
                <ChevronRight size={18} />
              </button>
            </div>
            <div className={styles.stepper}>
              <button type="button" onClick={() => adjustMinute(-5)} aria-label="Cinco minutos menos">
                <ChevronLeft size={18} />
              </button>
              <strong>{String(currentMinute).padStart(2, '0')}</strong>
              <button type="button" onClick={() => adjustMinute(5)} aria-label="Cinco minutos más">
                <ChevronRight size={18} />
              </button>
            </div>
            <div className={styles.periodToggle} role="group" aria-label="Periodo">
              {(['am', 'pm'] as const).map((period) => (
                <button
                  key={period}
                  type="button"
                  className={currentPeriod === period ? styles.periodActive : ''}
                  onClick={() => applyParts(currentHour12, currentMinute, period)}
                >
                  {period === 'am' ? 'a.m.' : 'p.m.'}
                </button>
              ))}
            </div>
          </div>
          <button type="button" className={styles.doneButton} onClick={() => setOpen(false)}>
            Listo
          </button>
        </div>
      </PhoneSheet>
    </div>
  )
}
