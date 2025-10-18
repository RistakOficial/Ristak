import React, { useState, useEffect } from 'react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { CalendarEvent } from '@/services/calendarsService';
import { formatDate } from '@/utils/format';
import styles from './AppointmentModal.module.css';
import { Trash2 } from 'lucide-react';

interface AppointmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  event: CalendarEvent | null;
  onSave: (eventId: string, updates: Partial<CalendarEvent>) => Promise<void>;
  onDelete?: (eventId: string) => Promise<void>;
}

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pendiente', color: '#f97316' },
  { value: 'confirmed', label: 'Confirmada', color: '#22c55e' },
  { value: 'cancelled', label: 'Cancelada', color: '#ef4444' },
  { value: 'showed', label: 'Asistió', color: '#2563eb' },
  { value: 'noshow', label: 'No asistió', color: '#6b7280' },
  { value: 'rescheduled', label: 'Reprogramada', color: '#8b5cf6' }
];

const ALL_TIMEZONES: string[] =
  typeof (Intl as any).supportedValuesOf === 'function'
    ? (Intl as any).supportedValuesOf('timeZone')
    : [
        'UTC',
        'America/Mexico_City',
        'America/Monterrey',
        'America/Chihuahua',
        'America/Tijuana',
        'America/Bogota',
        'America/Chicago',
        'America/New_York',
        'America/Los_Angeles',
        'Europe/Madrid'
      ];

const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const INITIAL_FORM_STATE = {
  title: '',
  appointmentStatus: 'pending' as CalendarEvent['appointmentStatus'],
  startTime: '',
  endTime: '',
  notes: '',
  address: '',
  timeZone: DEFAULT_TIMEZONE
};

const toLocalInputValue = (value?: string | null): string => {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const offset = parsed.getTimezoneOffset();
  const local = new Date(parsed.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
};

const parseDateSafe = (value?: string | null): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const AppointmentModal: React.FC<AppointmentModalProps> = ({
  isOpen,
  onClose,
  event,
  onSave,
  onDelete
}) => {
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState(INITIAL_FORM_STATE);

  useEffect(() => {
    if (event) {
      setFormData({
        title: event.title || '',
        appointmentStatus: event.appointmentStatus || 'pending',
        startTime: toLocalInputValue(event.startTime),
        endTime: toLocalInputValue(event.endTime),
        notes: event.notes || '',
        address: event.address || '',
        timeZone:
          event.timeZone ||
          (event as any).timeZone ||
          (event as any).timezone ||
          DEFAULT_TIMEZONE
      });
    } else if (!isOpen) {
      setFormData(INITIAL_FORM_STATE);
    }
  }, [event, isOpen]);

  const handleSave = async () => {
    if (!event) return;

    try {
      setIsSaving(true);

      const updates: Partial<CalendarEvent> = {
        title: formData.title.trim(),
        appointmentStatus: formData.appointmentStatus,
        notes: formData.notes,
        address: formData.address
      };

      if (formData.timeZone) {
        updates.timeZone = formData.timeZone;
      }

      if (formData.startTime) {
        updates.startTime = new Date(formData.startTime).toISOString();
      }

      if (formData.endTime) {
        updates.endTime = new Date(formData.endTime).toISOString();
      }

      await onSave(event.id, updates);
      onClose();
    } catch (error) {
      // Error manejado en el componente padre
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!event || !onDelete) return;

    const confirmed = window.confirm('¿Estás seguro de que quieres eliminar esta cita?');
    if (!confirmed) return;

    try {
      setIsSaving(true);
      await onDelete(event.id);
      onClose();
    } catch (error) {
      // Error manejado en el componente padre
    } finally {
      setIsSaving(false);
    }
  };

  if (!event) return null;

  const currentStatus = STATUS_OPTIONS.find((status) => status.value === formData.appointmentStatus);
  const startDate = parseDateSafe(formData.startTime) ?? parseDateSafe(event.startTime);
  const endDate = parseDateSafe(formData.endTime) ?? parseDateSafe(event.endTime);
  const selectedTimeZone =
    formData.timeZone ||
    event.timeZone ||
    (event as any).timeZone ||
    (event as any).timezone ||
    DEFAULT_TIMEZONE;

  const timeFormatter = new Intl.DateTimeFormat('es-MX', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: selectedTimeZone
  });

  const dateLabel = startDate ? formatDate(startDate, { includeYear: true }) : 'Sin fecha asignada';
  const timeLabel = startDate && endDate
    ? `${timeFormatter.format(startDate)} – ${timeFormatter.format(endDate)}`
    : 'Horario no definido';

  const timeZoneShort = new Intl.DateTimeFormat('es-MX', { timeZone: selectedTimeZone, timeZoneName: 'short' })
    .formatToParts(startDate ?? new Date())
    .find((part) => part.type === 'timeZoneName')?.value ?? selectedTimeZone;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="" size="lg">
      <div className={styles.container}>
        <div className={styles.summary}>
          <div className={styles.summaryBody}>
            <h3 className={styles.summaryTitle}>{formData.title.trim() || '(Sin título)'}</h3>
            <div className={styles.summaryMeta}>
              <span>{dateLabel}</span>
              <span className={styles.summaryDivider} aria-hidden="true" />
              <span>{timeLabel}</span>
              <span className={styles.summaryDivider} aria-hidden="true" />
              <span className={styles.timezoneBadge}>Zona horaria · {timeZoneShort}</span>
            </div>
          </div>
          <div className={styles.summaryActions}>
            {currentStatus && (
              <span
                className={styles.statusChip}
                style={{
                  color: currentStatus.color,
                  borderColor: currentStatus.color,
                  backgroundColor: `${currentStatus.color}1a`
                }}
              >
                {currentStatus.label}
              </span>
            )}
            {onDelete && (
              <button
                className={styles.deleteButton}
                onClick={handleDelete}
                disabled={isSaving}
                aria-label="Eliminar cita"
              >
                <Trash2 size={18} />
              </button>
            )}
          </div>
        </div>

        <div className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="title">
              Título de la cita
            </label>
            <input
              id="title"
              type="text"
              className={styles.input}
              value={formData.title}
              placeholder="Ej. Consulta inicial con cliente"
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="status">
              Estado de seguimiento
            </label>
            <select
              id="status"
              className={styles.select}
              value={formData.appointmentStatus}
              onChange={(e) =>
                setFormData({ ...formData, appointmentStatus: e.target.value as CalendarEvent['appointmentStatus'] })
              }
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="startTime">
                Inicio
              </label>
              <input
                id="startTime"
                type="datetime-local"
                className={styles.input}
                value={formData.startTime}
                onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="endTime">
                Fin
              </label>
              <input
                id="endTime"
                type="datetime-local"
                className={styles.input}
                value={formData.endTime}
                onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="timeZone">
                Zona horaria
              </label>
              <select
                id="timeZone"
                className={styles.select}
                value={formData.timeZone}
                onChange={(e) => setFormData({ ...formData, timeZone: e.target.value })}
              >
                {ALL_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="address">
              Ubicación
            </label>
            <input
              id="address"
              type="text"
              className={styles.input}
              value={formData.address}
              onChange={(e) => setFormData({ ...formData, address: e.target.value })}
              placeholder="Dirección física o enlace de videollamada"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="notes">
              Notas para el equipo
            </label>
            <textarea
              id="notes"
              className={styles.textarea}
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              placeholder="Añade instrucciones, acuerdos o detalles importantes..."
              rows={3}
            />
          </div>
        </div>

        <div className={styles.actions}>
          <Button variant="primary" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Guardando...' : 'Guardar cambios'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
