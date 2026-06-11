import React, { useEffect, useMemo, useState } from 'react'
import { Bell, Sparkles, Trash2 } from 'lucide-react'
import { Modal, Button, CustomSelect, NumberInput } from '@/components/common'
import {
  type AppointmentReminder,
  type AppointmentReminderInput,
  type ReminderChannelOption,
  type ReminderSenderOption,
  formatReminderOffsetLabel
} from '@/services/appointmentRemindersService'
import styles from './AppointmentReminderModal.module.css'

interface AppointmentReminderModalProps {
  isOpen: boolean
  reminder: AppointmentReminder | null
  senders: ReminderSenderOption[]
  channels: ReminderChannelOption[]
  onClose: () => void
  onSave: (reminderId: string, input: AppointmentReminderInput) => Promise<void>
  onDelete: (reminderId: string) => Promise<void>
}

const OFFSET_UNIT_OPTIONS = [
  { value: 'minutes', label: 'Minutos' },
  { value: 'hours', label: 'Horas' },
  { value: 'days', label: 'Días' }
]

const MESSAGE_VARIABLES = ['{{contact.first_name}}', '{{cita.titulo}}', '{{cita.fecha}}', '{{cita.hora}}']

export const AppointmentReminderModal: React.FC<AppointmentReminderModalProps> = ({
  isOpen,
  reminder,
  senders,
  channels,
  onClose,
  onSave,
  onDelete
}) => {
  const [draft, setDraft] = useState<AppointmentReminderInput>({})
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)

  useEffect(() => {
    if (!isOpen || !reminder) return
    setDraft({
      messageType: reminder.messageType,
      aiEnabled: reminder.aiEnabled,
      senderMode: reminder.senderMode,
      senderPhoneNumberId: reminder.senderPhoneNumberId,
      offsetValue: reminder.offsetValue,
      offsetUnit: reminder.offsetUnit,
      messageText: reminder.messageText,
      smartEnabled: reminder.smartEnabled,
      smartStart: reminder.smartStart,
      smartEnd: reminder.smartEnd,
      smartOverflow: reminder.smartOverflow
    })
    setSaving(false)
    setDeleting(false)
    setConfirmDeleteOpen(false)
  }, [isOpen, reminder])

  const set = <K extends keyof AppointmentReminderInput>(key: K, value: AppointmentReminderInput[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  const channel = channels[0]
  const isConfirmation = draft.messageType === 'confirmation'

  const senderOptions = useMemo(() => senders.map(sender => ({
    value: sender.id,
    label: sender.name ? `${sender.phone} · ${sender.name}` : sender.phone
  })), [senders])

  const offsetLabel = formatReminderOffsetLabel(
    Number(draft.offsetValue) || 1,
    (draft.offsetUnit as AppointmentReminder['offsetUnit']) || 'days'
  )

  if (!reminder) return null

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(reminder.id, draft)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await onDelete(reminder.id)
      onClose()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Detalles del mensaje automático"
        size="lg"
        type="custom"
      >
        <div className={styles.form}>
          {/* Tipo de mensaje */}
          <section className={styles.section}>
            <h4 className={styles.sectionTitle}>Tipo de mensaje</h4>
            <div className={styles.typeGrid}>
              <button
                type="button"
                className={`${styles.typeCard} ${!isConfirmation ? styles.typeCardActive : ''}`}
                onClick={() => set('messageType', 'reminder')}
              >
                <Bell size={18} aria-hidden="true" />
                <div>
                  <div className={styles.typeCardTitle}>Recordatorio de cita</div>
                  <div className={styles.typeCardDetail}>Le recuerda al contacto su próxima cita.</div>
                </div>
              </button>
              <button
                type="button"
                className={`${styles.typeCard} ${isConfirmation ? styles.typeCardActive : ''}`}
                onClick={() => set('messageType', 'confirmation')}
              >
                <Sparkles size={18} aria-hidden="true" />
                <div>
                  <div className={styles.typeCardTitle}>Confirmación de cita</div>
                  <div className={styles.typeCardDetail}>Pide al contacto confirmar su asistencia.</div>
                </div>
              </button>
            </div>

            {isConfirmation && (
              <div className={styles.aiBox}>
                <label className={styles.switchRow}>
                  <span className={styles.switchControl}>
                    <input
                      type="checkbox"
                      checked={draft.aiEnabled !== false}
                      onChange={(e) => set('aiEnabled', e.target.checked)}
                    />
                    <span className={styles.switchTrack} />
                  </span>
                  <span>
                    <span className={styles.switchLabel}>Confirmación automática con IA</span>
                    <span className={styles.helpText}>
                      Al enviarse este mensaje se activa una inteligencia artificial que queda a la espera
                      de la respuesta del contacto y confirma la cita automáticamente cuando responde que sí.
                    </span>
                  </span>
                </label>
              </div>
            )}
          </section>

          {/* Canal y remitente */}
          <section className={styles.section}>
            <h4 className={styles.sectionTitle}>Canal de envío</h4>
            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Canal</label>
                <CustomSelect
                  value={channel?.id || 'whatsapp'}
                  options={channels.map(c => ({
                    value: c.id,
                    label: c.connected ? `${c.label} (conectado)` : c.label
                  }))}
                  onValueChange={() => {}}
                  aria-label="Canal de mensajes"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Enviar desde</label>
                <CustomSelect
                  value={draft.senderMode || 'contact'}
                  options={[
                    { value: 'contact', label: 'El número por el que te escribió el contacto' },
                    { value: 'default', label: 'El número predeterminado de la aplicación' },
                    { value: 'specific', label: 'Un número específico' }
                  ]}
                  onValueChange={(value) => set('senderMode', value as AppointmentReminderInput['senderMode'])}
                  aria-label="Número remitente"
                />
              </div>
            </div>
            {draft.senderMode === 'specific' && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Número</label>
                {senderOptions.length ? (
                  <CustomSelect
                    value={draft.senderPhoneNumberId || ''}
                    options={senderOptions}
                    placeholder="Elige un número conectado"
                    onValueChange={(value) => set('senderPhoneNumberId', value)}
                    aria-label="Número específico"
                  />
                ) : (
                  <p className={styles.helpText}>No hay números de WhatsApp conectados todavía.</p>
                )}
              </div>
            )}
          </section>

          {/* Tiempo de envío */}
          <section className={styles.section}>
            <h4 className={styles.sectionTitle}>¿Cuándo se envía?</h4>
            <div className={styles.offsetRow}>
              <NumberInput
                className={styles.offsetInput}
                min={1}
                max={60}
                value={draft.offsetValue ?? 1}
                onValueChange={(value) => set('offsetValue', Math.max(1, Math.round(value)))}
                aria-label="Cantidad de tiempo antes de la cita"
              />
              <div className={styles.offsetUnit}>
                <CustomSelect
                  value={draft.offsetUnit || 'days'}
                  options={OFFSET_UNIT_OPTIONS}
                  onValueChange={(value) => set('offsetUnit', value as AppointmentReminderInput['offsetUnit'])}
                  aria-label="Unidad de tiempo"
                />
              </div>
              <span className={styles.offsetSuffix}>antes de la cita ({offsetLabel})</span>
            </div>

            <label className={styles.checkboxRow}>
              <input
                type="checkbox"
                checked={draft.smartEnabled !== false}
                onChange={(e) => set('smartEnabled', e.target.checked)}
              />
              <span>
                <span className={styles.switchLabel}>Recordatorio inteligente</span>
                <span className={styles.helpText}>
                  Si la cita cae en un horario incómodo (por ejemplo, agendada a las 5 de la madrugada),
                  el mensaje se mueve automáticamente a una hora adecuada para no escribirle al contacto
                  en horas indebidas.
                </span>
              </span>
            </label>

            {draft.smartEnabled !== false && (
              <div className={styles.smartBox}>
                <div className={styles.fieldRow}>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>Desde</label>
                    <input
                      type="time"
                      className={styles.timeInput}
                      value={draft.smartStart || '09:00'}
                      onChange={(e) => set('smartStart', e.target.value)}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>Hasta</label>
                    <input
                      type="time"
                      className={styles.timeInput}
                      value={draft.smartEnd || '21:00'}
                      onChange={(e) => set('smartEnd', e.target.value)}
                    />
                  </div>
                </div>
                <label className={styles.fieldLabel}>Si el mensaje queda fuera de ese horario…</label>
                <div className={styles.radioGroup}>
                  <label className={styles.radioRow}>
                    <input
                      type="radio"
                      name="smartOverflow"
                      checked={(draft.smartOverflow || 'before') === 'before'}
                      onChange={() => set('smartOverflow', 'before')}
                    />
                    <span>Enviarlo antes, sin dejar que acabe el día anterior</span>
                  </label>
                  <label className={styles.radioRow}>
                    <input
                      type="radio"
                      name="smartOverflow"
                      checked={draft.smartOverflow === 'next_day'}
                      onChange={() => set('smartOverflow', 'next_day')}
                    />
                    <span>Enviarlo después, empezando el día siguiente</span>
                  </label>
                </div>
              </div>
            )}
          </section>

          {/* Mensaje */}
          <section className={styles.section}>
            <h4 className={styles.sectionTitle}>Mensaje</h4>
            <textarea
              className={styles.messageInput}
              rows={4}
              value={draft.messageText || ''}
              onChange={(e) => set('messageText', e.target.value)}
              placeholder="Escribe el mensaje que recibirá el contacto…"
            />
            <div className={styles.variables}>
              {MESSAGE_VARIABLES.map(variable => (
                <button
                  key={variable}
                  type="button"
                  className={styles.variableChip}
                  onClick={() => set('messageText', `${draft.messageText || ''}${draft.messageText?.endsWith(' ') || !draft.messageText ? '' : ' '}${variable}`)}
                >
                  {variable}
                </button>
              ))}
            </div>
          </section>

          <div className={styles.footer}>
            <Button
              variant="ghost"
              onClick={() => setConfirmDeleteOpen(true)}
              disabled={saving || deleting}
            >
              <Trash2 size={16} aria-hidden="true" />
              Eliminar
            </Button>
            <div className={styles.footerActions}>
              <Button variant="secondary" onClick={onClose} disabled={saving || deleting}>
                Cancelar
              </Button>
              <Button variant="primary" onClick={handleSave} disabled={saving || deleting}>
                {saving ? 'Guardando…' : 'Guardar'}
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        title="Eliminar mensaje automático"
        message={`Se dejará de enviar "${reminder.name}" a tus contactos. Esta acción no se puede deshacer.`}
        type="confirm"
        confirmText="Eliminar"
        cancelText="Cancelar"
        onConfirm={handleDelete}
      />
    </>
  )
}

export default AppointmentReminderModal
