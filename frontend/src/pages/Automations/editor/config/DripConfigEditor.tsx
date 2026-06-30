import React, { useMemo, useState } from 'react'
import { Clock } from 'lucide-react'
import { useTimezone } from '@/contexts/TimezoneContext'
import { CustomSelect, Field, NumberTextInput } from './configPrimitives'
import styles from '../AutomationEditor.module.css'

type Config = Record<string, unknown>

interface DripConfigEditorProps {
  config: Config
  onChange: (config: Config) => void
}

const INTERVAL_UNITS = [
  { value: 'minutes', label: 'Minutos' },
  { value: 'hours', label: 'Horas' },
  { value: 'days', label: 'Días' }
]

const UNIT_MS: Record<string, number> = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const positiveNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const positiveInteger = (value: unknown, fallback: number): number => Math.max(1, Math.floor(positiveNumber(value, fallback)))

const formatDate = (date: Date, timezone: string): string =>
  date.toLocaleString('es-MX', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

export const DripConfigEditor: React.FC<DripConfigEditorProps> = ({ config, onChange }) => {
  const { timezone } = useTimezone()
  const [previewStartedAt, setPreviewStartedAt] = useState<Date | null>(null)
  const batchSize = positiveInteger(config.batchSize, 100)
  const intervalAmount = positiveNumber(config.intervalAmount, 1)
  const intervalUnit = INTERVAL_UNITS.some((unit) => unit.value === str(config.intervalUnit))
    ? str(config.intervalUnit)
    : 'minutes'
  const intervalMs = intervalAmount * (UNIT_MS[intervalUnit] || UNIT_MS.minutes)

  const set = (patch: Config) => onChange({ ...config, ...patch })

  const previewRows = useMemo(() => {
    if (!previewStartedAt) return []
    return Array.from({ length: 10 }, (_, index) => ({
      batch: index + 1,
      scheduledAt: new Date(previewStartedAt.getTime() + index * intervalMs)
    }))
  }, [intervalMs, previewStartedAt])

  return (
    <div>
      <Field label="Tamaño del lote" help="Cantidad de contactos que avanzan juntos cada vez.">
        <NumberTextInput
          min={1}
          value={config.batchSize === '' ? '' : batchSize}
          onChange={(event) => set({ batchSize: event.target.value === '' ? '' : Number(event.target.value) })}
        />
      </Field>

      <Field label="Intervalo de goteo" help="Tiempo entre un lote y el siguiente.">
        <div className={styles.configRow}>
          <NumberTextInput
            min={1}
            value={config.intervalAmount === '' ? '' : intervalAmount}
            className={styles.configRowGrow}
            onChange={(event) => set({ intervalAmount: event.target.value === '' ? '' : Number(event.target.value) })}
          />
          <div className={styles.configRowGrow}>
            <CustomSelect
              options={INTERVAL_UNITS}
              value={intervalUnit}
              onValueChange={(value) => set({ intervalUnit: value })}
              aria-label="Unidad del intervalo de goteo"
            />
          </div>
        </div>
      </Field>

      <section className={styles.dripPreviewPanel}>
        <div className={styles.dripPreviewHeader}>
          <div>
            <div className={styles.dripPreviewTitle}>Revisar programa de goteo</div>
            <p className={styles.dripPreviewHelp}>Previsualiza cómo saldrían los próximos lotes si el flujo empieza ahora.</p>
          </div>
          <button
            type="button"
            className={styles.configSmallButton}
            onClick={() => setPreviewStartedAt(new Date())}
          >
            <Clock size={12} />
            Comprobar
          </button>
        </div>

        {previewStartedAt && (
          <div className={styles.dripPreviewResult}>
            <p className={styles.dripPreviewNow}>Si se activa el flujo ahora ({formatDate(previewStartedAt, timezone)})</p>
            <table className={styles.dripPreviewTable}>
              <thead>
                <tr>
                  <th>Lote</th>
                  <th>Programado</th>
                  <th>Contactos</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row) => (
                  <tr key={row.batch}>
                    <td>{row.batch}</td>
                    <td>{formatDate(row.scheduledAt, timezone)}</td>
                    <td>{batchSize}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className={styles.dripPreviewFoot}>Mostrando los primeros 10 lotes.</p>
          </div>
        )}
      </section>
    </div>
  )
}
