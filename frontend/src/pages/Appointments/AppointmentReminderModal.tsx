import React, { useEffect, useMemo, useState } from 'react'
import { Bell, ShieldAlert, Sparkles, Trash2 } from 'lucide-react'
import { Modal, Button, CustomSelect, NumberInput, Switch } from '@/components/common'
import { Badge, type BadgeVariant } from '@/components/common/Badge'
import { useNotification } from '@/contexts/NotificationContext'
import {
  type AppointmentReminder,
  type AppointmentReminderInput,
  type ReminderConfirmationSuccessAction,
  type ReminderChannelOption,
  type ReminderNoConfirmAction,
  type ReminderSenderOption,
  formatReminderOffsetLabel
} from '@/services/appointmentRemindersService'
import type { MessageTemplate } from '@/services/messageTemplatesService'
import {
  WHATSAPP_QR_FALLBACK_CONFIRM_WORD,
  WHATSAPP_QR_FALLBACK_TITLE,
  buildWhatsAppQrFallbackMessage
} from '@/utils/whatsappQrFallbackWarning'
import styles from './AppointmentReminderModal.module.css'

interface AppointmentReminderModalProps {
  isOpen: boolean
  reminder: AppointmentReminder | null
  senders: ReminderSenderOption[]
  channels: ReminderChannelOption[]
  templates: MessageTemplate[]
  onClose: () => void
  onSave: (reminderId: string, input: AppointmentReminderInput) => Promise<void>
  onDelete: (reminderId: string) => Promise<void>
}

const OFFSET_UNIT_OPTIONS = [
  { value: 'minutes', label: 'Minutos' },
  { value: 'hours', label: 'Horas' },
  { value: 'days', label: 'Días' }
]

const DEFAULT_TEMPLATE_NAME_BY_TYPE = {
  reminder: 'recordatorio_cita_un_dia_antes',
  confirmation: 'confirmacion_cita_dia_anterior'
} as const

const CONFIRMATION_SUCCESS_ACTION_OPTIONS: { value: ReminderConfirmationSuccessAction; label: string; description: string }[] = [
  {
    value: 'chat_card',
    label: 'Agregar tarjetita en el chat',
    description: 'Ristak deja una tarjeta visible en la conversación indicando que la cita quedó confirmada.'
  },
  {
    value: 'notify_push',
    label: 'Mandarme notificación push',
    description: 'Te avisa cuando la IA detecta que la persona sí confirmó su cita.'
  },
  {
    value: 'chat_badge',
    label: 'Mostrar etiqueta "Asistirá a cita"',
    description: 'El chat muestra esa etiqueta en compu y celular hasta que pase la hora de la cita.'
  },
  {
    value: 'mark_confirmed',
    label: 'Sólo marcar la cita confirmada',
    description: 'La cita cambia a confirmada sin agregar avisos extra.'
  }
]

const NO_CONFIRM_ACTION_OPTIONS: { value: ReminderNoConfirmAction; label: string; description: string }[] = [
  {
    value: 'no_action',
    label: 'No hacer nada',
    description: 'Ristak deja la cita como está y no avisa al equipo.'
  },
  {
    value: 'cancel_appointment',
    label: 'Cancelar la cita',
    description: 'La cita se marca como cancelada si la respuesta no confirma asistencia.'
  },
  {
    value: 'notify_push',
    label: 'Enviarme una notificación',
    description: 'Te avisa si la IA detecta que no confirmó, quiere moverla o hace falta revisar.'
  }
]

const getTemplateReviewStatus = (template?: MessageTemplate | null) => String(template?.ycloudStatus || '').toUpperCase()

const getTemplateStatusLabel = (template?: MessageTemplate | null) => {
  const status = getTemplateReviewStatus(template)
  if (!template) return 'Sin plantilla'
  if (status === 'APPROVED') return 'Aprobada'
  if (['PENDING', 'IN_REVIEW', 'UNDER_REVIEW', 'PENDING_REVIEW'].includes(status)) return 'En revisión'
  if (status === 'REJECTED') return 'Rechazada'
  if (status === 'PAUSED') return 'Pausada'
  if (status === 'DISABLED') return 'Deshabilitada'
  if (!status) return 'No enviada'
  return status
}

const getTemplateStatusVariant = (template?: MessageTemplate | null): BadgeVariant => {
  const status = getTemplateReviewStatus(template)
  if (status === 'APPROVED') return 'success'
  if (['PENDING', 'IN_REVIEW', 'UNDER_REVIEW', 'PENDING_REVIEW', 'IN_APPEAL'].includes(status)) return 'warning'
  if (['REJECTED', 'PAUSED', 'DISABLED', 'ARCHIVED', 'DELETED'].includes(status)) return 'error'
  return 'neutral'
}

const replaceTemplateVariables = (
  text: string | undefined,
  bindings: MessageTemplate['variableBindings']['bodyText'] = {}
) => (text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (match, index) => (
  bindings[index]?.mergeField || (bindings[index]?.variableKey ? `{{${bindings[index]?.variableKey}}}` : match)
))

const buildTemplatePreview = (template?: MessageTemplate | null) => {
  if (!template) return ''
  return [
    replaceTemplateVariables(template.headerText, template.variableBindings.headerText),
    replaceTemplateVariables(template.bodyText, template.variableBindings.bodyText),
    template.footerText || ''
  ].filter(Boolean).join('\n\n')
}

export const AppointmentReminderModal: React.FC<AppointmentReminderModalProps> = ({
  isOpen,
  reminder,
  senders,
  channels,
  templates,
  onClose,
  onSave,
  onDelete
}) => {
  const { showConfirm } = useNotification()
  const [draft, setDraft] = useState<AppointmentReminderInput>({})
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)

  useEffect(() => {
    if (!isOpen || !reminder) return
    setDraft({
      messageType: reminder.messageType,
      aiEnabled: reminder.aiEnabled,
      bypassAutomations: reminder.bypassAutomations,
      senderMode: reminder.senderMode,
      senderPhoneNumberId: reminder.senderPhoneNumberId,
      templateId: reminder.templateId,
      templateName: reminder.templateName || '',
      templateLanguage: reminder.templateLanguage || 'es_MX',
      qrFallbackEnabled: reminder.qrFallbackEnabled,
      offsetValue: reminder.offsetValue,
      offsetUnit: reminder.offsetUnit,
      messageText: reminder.messageText,
      smartEnabled: reminder.smartEnabled,
      smartStart: reminder.smartStart,
      smartEnd: reminder.smartEnd,
      smartOverflow: reminder.smartOverflow,
      noConfirmAction: reminder.noConfirmAction,
      confirmationSuccessAction: reminder.confirmationSuccessAction
    })
    setSaving(false)
    setDeleting(false)
    setConfirmDeleteOpen(false)
  }, [isOpen, reminder])

  const set = <K extends keyof AppointmentReminderInput>(key: K, value: AppointmentReminderInput[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  const setQrFallbackEnabled = (checked: boolean) => {
    if (!checked) {
      set('qrFallbackEnabled', false)
      return
    }

    showConfirm(
      WHATSAPP_QR_FALLBACK_TITLE,
      buildWhatsAppQrFallbackMessage('este recordatorio de calendario'),
      () => set('qrFallbackEnabled', true),
      'Activar respaldo QR',
      'Cancelar',
      undefined,
      { typeToConfirm: WHATSAPP_QR_FALLBACK_CONFIRM_WORD }
    )
  }

  const channel = channels[0]
  const isConfirmation = draft.messageType === 'confirmation'
  const hasQrConnected = senders.some(sender => sender.qrConnected)
  const hasApiConnected = senders.some(sender => sender.apiEnabled)

  const visibleTemplates = useMemo(() => (
    templates
      .filter(template => template.status !== 'archived')
      .sort((left, right) => {
        const leftReminder = left.folderId === 'Reminders' ? 0 : 1
        const rightReminder = right.folderId === 'Reminders' ? 0 : 1
        if (leftReminder !== rightReminder) return leftReminder - rightReminder
        return left.name.localeCompare(right.name)
      })
  ), [templates])

  const selectedTemplate = useMemo(() => (
    visibleTemplates.find(template => template.id === draft.templateId) || null
  ), [draft.templateId, visibleTemplates])

  const defaultTemplateForType = useMemo(() => {
    const name = DEFAULT_TEMPLATE_NAME_BY_TYPE[(draft.messageType as AppointmentReminder['messageType']) || 'reminder']
    return visibleTemplates.find(template => template.name === name) || visibleTemplates[0] || null
  }, [draft.messageType, visibleTemplates])

  useEffect(() => {
    if (!isOpen || !reminder || draft.templateId || !defaultTemplateForType) return
    setDraft(prev => ({
      ...prev,
      templateId: defaultTemplateForType.id,
      templateName: defaultTemplateForType.name,
      templateLanguage: defaultTemplateForType.language
    }))
  }, [defaultTemplateForType, draft.templateId, isOpen, reminder])

  const templateOptions = useMemo(() => visibleTemplates.map(template => ({
    value: template.id,
    label: `${template.name} · ${getTemplateStatusLabel(template)}`
  })), [visibleTemplates])

  const selectedTemplatePreview = useMemo(() => buildTemplatePreview(selectedTemplate), [selectedTemplate])
  const selectedTemplateApproved = getTemplateReviewStatus(selectedTemplate) === 'APPROVED'
  const selectedConfirmationSuccessAction = CONFIRMATION_SUCCESS_ACTION_OPTIONS.find(
    option => option.value === (draft.confirmationSuccessAction || 'chat_card')
  ) || CONFIRMATION_SUCCESS_ACTION_OPTIONS[0]
  const selectedNoConfirmAction = NO_CONFIRM_ACTION_OPTIONS.find(
    option => option.value === (draft.noConfirmAction || 'no_action')
  ) || NO_CONFIRM_ACTION_OPTIONS[0]

  const senderOptions = useMemo(() => senders.map(sender => ({
    value: sender.id,
    label: sender.name ? `${sender.phone} · ${sender.name}` : sender.phone
  })), [senders])

  const offsetLabel = formatReminderOffsetLabel(
    Number(draft.offsetValue) || 1,
    (draft.offsetUnit as AppointmentReminder['offsetUnit']) || 'days'
  )

  if (!reminder) return null

  const selectTemplate = (templateId: string) => {
    const template = visibleTemplates.find(item => item.id === templateId)
    setDraft(prev => ({
      ...prev,
      templateId,
      templateName: template?.name || prev.templateName || '',
      templateLanguage: template?.language || prev.templateLanguage || 'es_MX'
    }))
  }

  const changeMessageType = (messageType: AppointmentReminderInput['messageType']) => {
    const nextName = DEFAULT_TEMPLATE_NAME_BY_TYPE[messageType || 'reminder']
    const previousName = DEFAULT_TEMPLATE_NAME_BY_TYPE[(draft.messageType as AppointmentReminder['messageType']) || 'reminder']
    const shouldSwitchTemplate = !draft.templateId || selectedTemplate?.name === previousName
    const nextTemplate = visibleTemplates.find(template => template.name === nextName) || null

    setDraft(prev => ({
      ...prev,
      messageType,
      ...(shouldSwitchTemplate && nextTemplate
        ? {
            templateId: nextTemplate.id,
            templateName: nextTemplate.name,
            templateLanguage: nextTemplate.language
          }
        : {})
    }))
  }

  const handleSave = async () => {
    if (!draft.templateId) return
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
                onClick={() => changeMessageType('reminder')}
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
                onClick={() => changeMessageType('confirmation')}
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
                      Al enviarse este mensaje, la IA queda pendiente de la respuesta del contacto.
                      En cuanto responda, esperará 2 minutos después de su último mensaje antes de
                      clasificar si confirmó, quiere reagendar, canceló o necesita atención humana.
                    </span>
                  </span>
                </label>

                {draft.aiEnabled !== false && (
                  <>
                    <label className={`${styles.switchRow} ${styles.stackedSwitchRow}`}>
                      <span className={styles.switchControl}>
                        <input
                          type="checkbox"
                          checked={draft.bypassAutomations === true}
                          onChange={(e) => set('bypassAutomations', e.target.checked)}
                        />
                        <span className={styles.switchTrack} />
                      </span>
                      <span>
                        <span className={styles.switchLabel}>Pausar agentes y automatizaciones durante la confirmación</span>
                        <span className={styles.helpText}>
                          Mientras el contacto esté respondiendo al mensaje de confirmación, otros agentes
                          de IA y automatizaciones activas quedarán en pausa para evitar respuestas cruzadas.
                          Se reanudan automáticamente cuando la IA termina de clasificar la respuesta.
                        </span>
                      </span>
                    </label>

                    <div className={styles.confirmationActionBox}>
                      <div className={styles.field}>
                        <label className={styles.fieldLabel}>Qué quieres que pase cuando se detecte que confirmó la cita</label>
                        <CustomSelect
                          value={draft.confirmationSuccessAction || 'chat_card'}
                          options={CONFIRMATION_SUCCESS_ACTION_OPTIONS.map(option => ({
                            value: option.value,
                            label: option.label
                          }))}
                          onValueChange={(value) => set('confirmationSuccessAction', value as ReminderConfirmationSuccessAction)}
                          aria-label="Acción cuando el contacto confirma la cita"
                          portal
                        />
                        <span className={styles.helpText}>{selectedConfirmationSuccessAction.description}</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {isConfirmation && (
              <div className={styles.noConfirmBox}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Si el contacto no confirma</label>
                  <CustomSelect
                    value={draft.noConfirmAction || 'no_action'}
                    options={NO_CONFIRM_ACTION_OPTIONS.map(option => ({
                      value: option.value,
                      label: option.label
                    }))}
                    onValueChange={(value) => set('noConfirmAction', value as ReminderNoConfirmAction)}
                    aria-label="Acción si el contacto no confirma"
                    portal
                  />
                  <span className={styles.helpText}>{selectedNoConfirmAction.description}</span>
                </div>
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
            <div className={styles.sectionHeader}>
              <h4 className={styles.sectionTitle}>Plantilla de WhatsApp</h4>
              {selectedTemplate && (
                <Badge variant={getTemplateStatusVariant(selectedTemplate)}>
                  {getTemplateStatusLabel(selectedTemplate)}
                </Badge>
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Mensaje seleccionado</label>
              <CustomSelect
                value={draft.templateId || ''}
                options={templateOptions}
                placeholder={templateOptions.length ? 'Elige una plantilla' : 'Sin plantillas disponibles'}
                disabled={!templateOptions.length}
                onValueChange={selectTemplate}
                aria-label="Plantilla del mensaje automático"
                portal
              />
              <span className={styles.helpText}>
                Los recordatorios por WhatsApp API salen con plantillas aprobadas. Si la plantilla no está aprobada,
                el envío queda detenido salvo que actives el respaldo por QR.
              </span>
            </div>

            {selectedTemplate ? (
              <div className={styles.templatePreview}>
                <div className={styles.templatePreviewHeader}>
                  <span>{selectedTemplate.name}</span>
                  <small>{selectedTemplate.language}</small>
                </div>
                <p>{selectedTemplatePreview || 'Esta plantilla no tiene texto para previsualizar.'}</p>
              </div>
            ) : (
              <p className={styles.templateEmpty}>
                Cuando conectes WhatsApp API, Ristak crea las plantillas de recordatorios y las manda a revisión.
              </p>
            )}

            {selectedTemplate && !selectedTemplateApproved && !draft.qrFallbackEnabled && (
              <div className={styles.templateNotice}>
                Esta plantilla todavía no está aprobada por WhatsApp API. No se enviará hasta que Meta la apruebe o actives el respaldo por QR.
              </div>
            )}

            {!hasApiConnected && selectedTemplateApproved && !draft.qrFallbackEnabled && (
              <div className={styles.templateNotice}>
                La plantilla está lista, pero WhatsApp API no está disponible ahora. Con QR apagado, este recordatorio esperará a que la API vuelva.
              </div>
            )}

            {hasQrConnected && (
              <div className={styles.qrFallbackBox}>
                <div className={styles.qrFallbackCopy}>
                  <div className={styles.qrFallbackTitle}>
                    <span
                      className={styles.qrRiskIcon}
                      title="Precaución: el envío por QR usa una aplicación de terceros no validada por Meta y puede aumentar el riesgo de bloqueo del número."
                    >
                      <ShieldAlert size={17} aria-hidden="true" />
                    </span>
                    Usar QR como respaldo riesgoso
                  </div>
                  <span className={styles.helpText}>
                    Si WhatsApp API no está disponible o la plantilla sigue en revisión, rechazada o pausada,
                    Ristak intentará mandar el texto de esta plantilla por QR.
                  </span>
                </div>
                <Switch
                  checked={draft.qrFallbackEnabled === true}
                  onChange={setQrFallbackEnabled}
                  aria-label="Usar QR como respaldo riesgoso"
                />
              </div>
            )}
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
              <Button variant="primary" onClick={handleSave} disabled={saving || deleting || !draft.templateId}>
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
