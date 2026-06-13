import React from 'react'
import {
  ArrowLeft,
  CalendarClock,
  CalendarDays,
  ChevronRight,
  Clock,
  ListFilter,
  MessageCircleReply,
  MousePointerClick
} from 'lucide-react'
import { CustomSelect } from '@/components/common'
import { CHANNEL_OPTIONS_WITH_ANY } from '../nodeRegistry'
import type { AdvancedConditionConfig } from '../crmFields'
import {
  CatalogSelect,
  ConfigSection,
  DurationInput,
  Field,
  TextInput,
  Toggle,
  WeekdaysPicker
} from './configPrimitives'
import { AdvancedConditionBuilder } from './AdvancedConditionBuilder'
import styles from '../AutomationEditor.module.css'

/**
 * Configurador del nodo "Esperar" con sus modos:
 * periodo, fecha específica, cita próxima, respuesta del contacto,
 * acción del contacto y condiciones específicas.
 */

type Config = Record<string, unknown>

interface WaitConfigEditorProps {
  config: Config
  onChange: (config: Config) => void
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

interface WaitMode {
  id: string
  title: string
  example: string
  icon: React.ComponentType<{ size?: number | string }>
  isNew?: boolean
}

const WAIT_MODES: WaitMode[] = [
  { id: 'duration', title: 'Un periodo de tiempo establecido', example: 'Ejemplo: 2 días, 6 horas, 30 minutos', icon: Clock },
  { id: 'datetime', title: 'Una fecha y hora específicas', example: 'Ej: 4 de diciembre a las 9:00 AM', icon: CalendarDays },
  { id: 'appointment', title: 'Una cita o reserva próxima', example: 'Ej.: 1 hora antes de la cita programada', icon: CalendarClock },
  { id: 'reply', title: 'El contacto al que responder', example: 'Espera una respuesta por WhatsApp, Messenger o Instagram', icon: MessageCircleReply },
  { id: 'action', title: 'El contacto para realizar una acción', example: 'Ejemplo: hace clic en un enlace, envía un formulario', icon: MousePointerClick },
  { id: 'conditions', title: 'Condiciones específicas que deben cumplirse', example: 'Crea un segmento con cualquiera de tus campos', icon: ListFilter }
]

const EXPECTED_ACTIONS = [
  { value: 'click_link', label: 'Hace clic en un enlace' },
  { value: 'submit_form', label: 'Envía un formulario' },
  { value: 'purchase', label: 'Compra / paga' },
  { value: 'book_appointment', label: 'Agenda una cita' },
  { value: 'reply_message', label: 'Responde un mensaje' },
  { value: 'custom_event', label: 'Evento personalizado' }
]

export const WaitConfigEditor: React.FC<WaitConfigEditorProps> = ({ config, onChange }) => {
  const set = (patch: Config) => onChange({ ...config, ...patch })
  const mode = str(config.mode)

  // ------------------------------------------------------------ sin modo aún
  if (!mode) {
    return (
      <div>
        <Field label="Nombre de la acción">
          <TextInput
            value={str(config.name) || 'Esperar'}
            onChange={(event) => set({ name: event.target.value })}
          />
        </Field>
        <div className={styles.configLabel} style={{ marginBottom: 8 }}>
          Seleccione el tipo para comenzar
        </div>
        {WAIT_MODES.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className={styles.modeCard}
            onClick={() => set({ mode: candidate.id })}
          >
            <span className={styles.modeCardIcon}>
              <candidate.icon size={15} />
            </span>
            <span className={styles.modeCardText}>
              <span className={styles.modeCardTitle}>
                {candidate.title}
                {candidate.isNew && <span className={styles.newBadge}>NUEVO</span>}
              </span>
              <span className={styles.modeCardExample}>{candidate.example}</span>
            </span>
            <ChevronRight size={14} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
          </button>
        ))}
      </div>
    )
  }

  const activeMode = WAIT_MODES.find((candidate) => candidate.id === mode)
  const timeoutApplies = mode === 'reply' || mode === 'action' || mode === 'conditions'

  return (
    <div>
      <button type="button" className={styles.modeBackButton} onClick={() => set({ mode: '' })}>
        <ArrowLeft size={12} />
        Atrás · {activeMode?.title || 'Tipo no disponible'}
      </button>

      {!activeMode && (
        <p className={styles.configHelp} style={{ marginBottom: 12 }}>
          Este tipo de espera ya no está disponible. Vuelve atrás y selecciona otro tipo.
        </p>
      )}

      <Field label="Nombre de la acción">
        <TextInput value={str(config.name) || 'Esperar'} onChange={(event) => set({ name: event.target.value })} />
      </Field>

      {/* ----------------------------- por modo ----------------------------- */}

      {mode === 'duration' && (
        <Field label="Duración de la espera">
          <DurationInput
            amount={Number(config.amount) || 0}
            unit={str(config.unit) || 'hours'}
            onChange={(amount, unit) => set({ amount, unit })}
          />
        </Field>
      )}

      {mode === 'datetime' && (
        <>
          <Field label="Fecha y hora">
            <TextInput
              type="datetime-local"
              value={str(config.untilDate)}
              onChange={(event) => set({ untilDate: event.target.value })}
            />
          </Field>
          <p className={styles.configHelp} style={{ marginTop: -6, marginBottom: 12 }}>
            Usa la zona horaria configurada en este flujo.
          </p>
        </>
      )}

      {mode === 'appointment' && (
        <>
          <Field label="Calendario (opcional)">
            <CatalogSelect
              catalog="calendars"
              value={str(config.calendar)}
              onChange={(value, label) => set({ calendar: value, calendarName: label })}
              placeholder="Cualquier calendario"
              aria-label="Calendario"
            />
          </Field>
          <Field label="Tipo de cita (opcional)">
            <TextInput value={str(config.appointmentType)} placeholder="Ej. demo, consulta…" onChange={(event) => set({ appointmentType: event.target.value })} />
          </Field>
          <Field label="Estado de la cita (opcional)">
            <CustomSelect
              options={[
                { value: '', label: 'Cualquier estado' },
                { value: 'booked', label: 'Agendada' },
                { value: 'confirmed', label: 'Confirmada' }
              ]}
              value={str(config.appointmentStatus)}
              onValueChange={(next) => set({ appointmentStatus: next })}
              aria-label="Estado de la cita"
            />
          </Field>
          <Field label="Momento de continuar">
            <CustomSelect
              options={[
                { value: 'before', label: 'Antes de la cita' },
                { value: 'after', label: 'Después de la cita' },
                { value: 'at', label: 'Exactamente al inicio' }
              ]}
              value={str(config.appointmentOffset) || 'before'}
              onValueChange={(next) => set({ appointmentOffset: next })}
              aria-label="Momento"
            />
          </Field>
          {str(config.appointmentOffset) !== 'at' && (
            <Field label="¿Cuánto tiempo?">
              <DurationInput
                amount={Number(config.offsetAmount) || 0}
                unit={str(config.offsetUnit) || 'hours'}
                onChange={(offsetAmount, offsetUnit) => set({ offsetAmount, offsetUnit })}
              />
            </Field>
          )}
        </>
      )}

      {mode === 'reply' && (
        <>
          <Field label="Canal de respuesta">
            <CustomSelect
              options={CHANNEL_OPTIONS_WITH_ANY}
              value={str(config.replyChannel) || 'any'}
              onValueChange={(next) => set({ replyChannel: next })}
              aria-label="Canal"
            />
          </Field>
          <Field label="Palabras clave (opcional)" help="Si las defines, solo cuenta una respuesta que coincida">
            <TextInput
              placeholder="Escribe y presiona Enter"
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                const target = event.target as HTMLInputElement
                const keyword = target.value.trim()
                const keywords = Array.isArray(config.keywords) ? (config.keywords as string[]) : []
                if (keyword && !keywords.includes(keyword)) set({ keywords: [...keywords, keyword] })
                target.value = ''
              }}
            />
          </Field>
          {Array.isArray(config.keywords) && (config.keywords as string[]).length > 0 && (
            <div className={styles.keywordChips} style={{ marginTop: -6, marginBottom: 10 }}>
              {(config.keywords as string[]).map((keyword) => (
                <span key={keyword} className={styles.keywordChip}>
                  {keyword}
                  <button
                    type="button"
                    className={styles.keywordChipRemove}
                    onClick={() => set({ keywords: (config.keywords as string[]).filter((candidate) => candidate !== keyword) })}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <Field label="Coincidencia">
            <CustomSelect
              options={[
                { value: 'contains', label: 'Contiene' },
                { value: 'exact', label: 'Coincidencia exacta' },
                { value: 'starts_with', label: 'Empieza con' }
              ]}
              value={str(config.match) || 'contains'}
              onValueChange={(next) => set({ match: next })}
              aria-label="Coincidencia"
            />
          </Field>
        </>
      )}

      {mode === 'action' && (
        <>
          <Field label="Acción esperada">
            <CustomSelect
              options={EXPECTED_ACTIONS}
              value={str(config.expectedAction) || 'click_link'}
              onValueChange={(next) => set({ expectedAction: next })}
              aria-label="Acción esperada"
            />
          </Field>
          <Field label="Recurso relacionado (opcional)" help="Link, formulario, producto, calendario o evento según la acción">
            <TextInput
              value={str(config.actionResource)}
              placeholder="Ej. enlace-promo, formulario demo…"
              onChange={(event) => set({ actionResource: event.target.value })}
            />
          </Field>
          {str(config.expectedAction) === 'reply_message' && (
            <Field label="Canal relacionado">
              <CustomSelect
                options={CHANNEL_OPTIONS_WITH_ANY}
                value={str(config.actionChannel) || 'any'}
                onValueChange={(next) => set({ actionChannel: next })}
                aria-label="Canal"
              />
            </Field>
          )}
        </>
      )}

      {mode === 'conditions' && (
        <>
          <Field label="Evaluación">
            <CustomSelect
              options={[
                { value: 'continuous', label: 'Continua (en cuanto se cumpla)' },
                { value: 'interval', label: 'Cada cierto intervalo' }
              ]}
              value={str(config.evaluation) || 'continuous'}
              onValueChange={(next) => set({ evaluation: next })}
              aria-label="Evaluación"
            />
          </Field>
          <ConfigSection title="El contacto debe cumplir estas condiciones">
            <AdvancedConditionBuilder
              value={config.conditions}
              onChange={(conditions: AdvancedConditionConfig) => set({ conditions })}
            />
          </ConfigSection>
        </>
      )}

      {/* ------------------------- timeout compartido ------------------------ */}
      {timeoutApplies && (
        <ConfigSection title="Tiempo máximo de espera">
          <Toggle
            checked={Boolean(config.timeoutEnabled)}
            onChange={(checked) => set({ timeoutEnabled: checked })}
            label="Limitar el tiempo de espera"
          />
          {Boolean(config.timeoutEnabled) && (
            <Field
              label="Esperar como máximo"
              help='Al agotarse, el flujo continúa por la salida "No respondió / No cumplido"'
            >
              <DurationInput
                amount={Number(config.timeoutAmount) || 0}
                unit={str(config.timeoutUnit) || 'days'}
                onChange={(timeoutAmount, timeoutUnit) => set({ timeoutAmount, timeoutUnit })}
              />
            </Field>
          )}
        </ConfigSection>
      )}

      {/* ------------------------- ventana horaria --------------------------- */}
      {/* El switch vive solo; el contenedor de días/horas aparece al activarlo */}
      <Toggle
        checked={Boolean(config.windowEnabled)}
        onChange={(checked) => set({ windowEnabled: checked })}
        label="Continuar solo en ciertos días u horarios"
      />
      {Boolean(config.windowEnabled) && (
        <ConfigSection title="Ventana de continuación">
          <Field label="Días permitidos">
            <WeekdaysPicker
              values={Array.isArray(config.windowDays) ? (config.windowDays as string[]) : []}
              onChange={(windowDays) => set({ windowDays })}
            />
          </Field>
          <div className={styles.configRow}>
            <div className={styles.configRowGrow}>
              <Field label="Desde">
                <TextInput type="time" value={str(config.windowStart) || '09:00'} onChange={(event) => set({ windowStart: event.target.value })} />
              </Field>
            </div>
            <div className={styles.configRowGrow}>
              <Field label="Hasta">
                <TextInput type="time" value={str(config.windowEnd) || '18:00'} onChange={(event) => set({ windowEnd: event.target.value })} />
              </Field>
            </div>
          </div>
          <Field label="Si está fuera del horario">
            <CustomSelect
              options={[
                { value: 'next-window', label: 'Esperar hasta la siguiente ventana disponible' },
                { value: 'continue', label: 'Continuar inmediatamente' },
                { value: 'next-business-day', label: 'Pausar hasta el siguiente día permitido' }
              ]}
              value={str(config.outsideWindow) || 'next-window'}
              onValueChange={(next) => set({ outsideWindow: next })}
              aria-label="Fuera del horario"
            />
          </Field>
          <p className={styles.configHelp}>Usa la zona horaria configurada en este flujo.</p>
        </ConfigSection>
      )}
    </div>
  )
}
