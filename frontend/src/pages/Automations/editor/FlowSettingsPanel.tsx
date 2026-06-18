import React from 'react'
import {
  Modal
} from '@/components/common'
import { CustomSelect } from './config/configPrimitives'
import type { FlowSettings } from '@/services/automationsService'
import {
  CatalogSelect,
  ConfigSection,
  Field,
  NumberTextInput,
  TextArea,
  TextInput,
  Toggle,
  WeekdaysPicker
} from './config/configPrimitives'
import styles from './AutomationEditor.module.css'

/**
 * Configuración global del flujo: zona horaria (heredada por los nodos),
 * días/horarios permitidos, reingreso de contactos, detener al responder y
 * remitentes por defecto.
 */

interface FlowSettingsPanelProps {
  open: boolean
  onClose: () => void
  name: string
  onRename: (name: string) => void
  settings: FlowSettings
  onChange: (settings: FlowSettings) => void
}

const TIMEZONES = [
  { value: '', label: 'Zona horaria de la cuenta (por defecto)' },
  { value: 'America/Mexico_City', label: 'Ciudad de México (GMT-6)' },
  { value: 'America/Cancun', label: 'Cancún (GMT-5)' },
  { value: 'America/Tijuana', label: 'Tijuana (GMT-8)' },
  { value: 'America/Monterrey', label: 'Monterrey (GMT-6)' },
  { value: 'America/Bogota', label: 'Bogotá (GMT-5)' },
  { value: 'America/Lima', label: 'Lima (GMT-5)' },
  { value: 'America/Santiago', label: 'Santiago (GMT-4)' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires (GMT-3)' },
  { value: 'America/New_York', label: 'Nueva York (GMT-5)' },
  { value: 'America/Los_Angeles', label: 'Los Ángeles (GMT-8)' },
  { value: 'Europe/Madrid', label: 'Madrid (GMT+1)' }
]

export const FlowSettingsPanel: React.FC<FlowSettingsPanelProps> = ({
  open,
  onClose,
  name,
  onRename,
  settings,
  onChange
}) => {
  const set = (patch: Partial<FlowSettings>) => onChange({ ...settings, ...patch })
  const schedule = settings.allowedSchedule

  return (
    <Modal isOpen={open} onClose={onClose} title="Configuración del flujo" size="md">
      <div className={styles.flowSettingsBody} data-automation-interactive="true">
        <Field label="Nombre del flujo">
          <TextInput value={name} maxLength={120} onChange={(event) => onRename(event.target.value)} />
        </Field>

        <Field label="Descripción interna (opcional)">
          <TextArea
            value={settings.description || ''}
            rows={2}
            placeholder="¿Para qué sirve este flujo?"
            onChange={(event) => set({ description: event.target.value })}
          />
        </Field>

        <Field
          label="Zona horaria del flujo"
          help="Todos los nodos (Esperar, fecha programada y ventanas horarias) usan esta zona horaria"
        >
          <CustomSelect
            options={TIMEZONES}
            value={settings.timezone || ''}
            onValueChange={(next) => set({ timezone: next })}
            aria-label="Zona horaria del flujo"
          />
        </Field>

        {/* ------------------- Días y horarios permitidos ------------------- */}
        <Toggle
          checked={schedule.enabled}
          onChange={(enabled) => set({ allowedSchedule: { ...schedule, enabled } })}
          label="Ejecutar o continuar solo en ciertos horarios"
        />
        {schedule.enabled && (
          <ConfigSection title="Horario permitido del flujo">
            <Field label="Días permitidos">
              <WeekdaysPicker
                values={schedule.daysOfWeek}
                onChange={(daysOfWeek) => set({ allowedSchedule: { ...schedule, daysOfWeek } })}
              />
            </Field>
            <div className={styles.configRow}>
              <div className={styles.configRowGrow}>
                <Field label="Desde">
                  <TextInput
                    type="time"
                    value={schedule.startTime}
                    onChange={(event) => set({ allowedSchedule: { ...schedule, startTime: event.target.value } })}
                  />
                </Field>
              </div>
              <div className={styles.configRowGrow}>
                <Field label="Hasta">
                  <TextInput
                    type="time"
                    value={schedule.endTime}
                    onChange={(event) => set({ allowedSchedule: { ...schedule, endTime: event.target.value } })}
                  />
                </Field>
              </div>
            </div>
            <Field label="Fuera de horario">
              <CustomSelect
                options={[
                  { value: 'wait_until_next_window', label: 'Esperar hasta la próxima ventana' },
                  { value: 'continue_immediately', label: 'Continuar inmediatamente' },
                  { value: 'pause_until_next_allowed_day', label: 'Pausar hasta el siguiente día permitido' }
                ]}
                value={schedule.outsideWindowBehavior}
                onValueChange={(next) =>
                  set({
                    allowedSchedule: {
                      ...schedule,
                      outsideWindowBehavior: next as FlowSettings['allowedSchedule']['outsideWindowBehavior']
                    }
                  })
                }
                aria-label="Fuera de horario"
              />
            </Field>
          </ConfigSection>
        )}

        {/* --------------------------- Reingreso --------------------------- */}
        <ConfigSection title="Reingreso del contacto">
          <Toggle
            checked={settings.allowReentry}
            onChange={(allowReentry) => set({ allowReentry })}
            label="Permitir reingreso"
          />
          <p className={styles.configHelp}>
            Permite que el mismo contacto vuelva a entrar al flujo después de completarlo o salir.
          </p>
          <Toggle
            checked={settings.preventDuplicateActiveEnrollment}
            onChange={(preventDuplicateActiveEnrollment) => set({ preventDuplicateActiveEnrollment })}
            label="Evitar duplicados si ya está activo en el flujo"
          />
          <Field label="Máximo de veces que un contacto puede entrar (opcional)">
            <NumberTextInput
              min={1}
              value={settings.maxEnrollments ?? ''}
              placeholder="Sin límite"
              onChange={(event) =>
                set({ maxEnrollments: event.target.value === '' ? null : Number(event.target.value) })
              }
            />
          </Field>
        </ConfigSection>

        {/* ----------------------- Detener al responder ---------------------- */}
        <ConfigSection title="Conversaciones">
          <Toggle
            checked={settings.stopOnContactResponse}
            onChange={(stopOnContactResponse) => set({ stopOnContactResponse })}
            label="Detener flujo si el contacto responde"
          />
          <p className={styles.configHelp}>
            Si el contacto responde por WhatsApp, Messenger o Instagram Direct, sale automáticamente
            del flujo para evitar automatización excesiva.
          </p>
        </ConfigSection>

        {/* ----------------------- Remitentes por defecto -------------------- */}
        <ConfigSection title="Remitentes por defecto">
          <Field label="WhatsApp por defecto" help="Los nodos de WhatsApp lo heredan; cada nodo puede sobrescribirlo">
            <CatalogSelect
              catalog="whatsappNumbers"
              value={settings.defaultSenders.whatsappSenderId || ''}
              onChange={(value) =>
                set({ defaultSenders: { ...settings.defaultSenders, whatsappSenderId: value } })
              }
              placeholder="Número principal de la cuenta"
              aria-label="WhatsApp por defecto"
            />
          </Field>
          <Field label="Página de Messenger por defecto (opcional)">
            <CatalogSelect
              catalog="messengerPages"
              value={settings.defaultSenders.messengerPageId || ''}
              onChange={(value) =>
                set({ defaultSenders: { ...settings.defaultSenders, messengerPageId: value } })
              }
              placeholder="Selecciona una página conectada"
              aria-label="Página de Messenger por defecto"
            />
          </Field>
          <Field label="Cuenta de Instagram por defecto (opcional)">
            <CatalogSelect
              catalog="instagramAccounts"
              value={settings.defaultSenders.instagramAccountId || ''}
              onChange={(value) =>
                set({ defaultSenders: { ...settings.defaultSenders, instagramAccountId: value } })
              }
              placeholder="Selecciona una cuenta conectada"
              aria-label="Cuenta de Instagram por defecto"
            />
          </Field>
        </ConfigSection>
      </div>
    </Modal>
  )
}
