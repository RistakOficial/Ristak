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
  event?: CalendarEvent | null;
  mode?: 'view' | 'create';
  defaultStart?: string;
  defaultEnd?: string;
  defaultTimeZone?: string;
  defaultTitle?: string;
  onSave: (eventIdOrPayload: string | any, updates?: Partial<CalendarEvent>) => Promise<void>;
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

const getTimeZoneParts = (date: Date, timeZone: string) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const result: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      result[part.type] = Number(part.value);
    }
  }
  return result;
};

const toDateInTimeZone = (value?: string | null, timeZone?: string): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (!timeZone) return date;

  const parts = getTimeZoneParts(date, timeZone);

  return new Date(
    parts.year ?? date.getFullYear(),
    (parts.month ?? date.getMonth() + 1) - 1,
    parts.day ?? date.getDate(),
    parts.hour ?? date.getHours(),
    parts.minute ?? date.getMinutes(),
    parts.second ?? date.getSeconds()
  );
};

const toLocalInputValue = (value?: string | null, timeZone?: string): string => {
  const zoned = toDateInTimeZone(value, timeZone);
  if (!zoned) return '';

  const year = zoned.getFullYear();
  const month = String(zoned.getMonth() + 1).padStart(2, '0');
  const day = String(zoned.getDate()).padStart(2, '0');
  const hours = String(zoned.getHours()).padStart(2, '0');
  const minutes = String(zoned.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

const parseDateSafe = (value?: string | null): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const convertLocalInputToISO = (value: string, timeZone: string): string | null => {
  if (!value) return null;
  const [datePart, timePart] = value.split('T');
  if (!timePart) return null;
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);

  const baseUtc = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offsetParts = getTimeZoneParts(baseUtc, timeZone);
  const utcFromParts = Date.UTC(
    offsetParts.year ?? year,
    (offsetParts.month ?? month) - 1,
    offsetParts.day ?? day,
    offsetParts.hour ?? hour,
    offsetParts.minute ?? minute,
    offsetParts.second ?? 0
  );

  // Offset between timezone representation and UTC
  const offset = utcFromParts - baseUtc.getTime();
  const adjusted = new Date(baseUtc.getTime() - offset);
  return adjusted.toISOString();
};

export const AppointmentModal: React.FC<AppointmentModalProps> = ({
  isOpen,
  onClose,
  event,
  mode = 'view',
  defaultStart,
  defaultEnd,
  defaultTimeZone,
  defaultTitle,
  onSave,
  onDelete
}) => {
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState(INITIAL_FORM_STATE);
  const isCreateMode = mode === 'create';

  useEffect(() => {
    if (event && !isCreateMode) {
      // Modo edición/vista: cargar datos del evento
      setFormData({
        title: event.title || '',
        appointmentStatus: event.appointmentStatus || 'pending',
        startTime: toLocalInputValue(event.startTime, event.timeZone),
        endTime: toLocalInputValue(event.endTime, event.timeZone),
        notes: event.notes || '',
        address: event.address || '',
        timeZone:
          event.timeZone ||
          (event as any)?.timeZone ||
          (event as any)?.timezone ||
          DEFAULT_TIMEZONE
      });
    } else if (isCreateMode && isOpen) {
      // Modo crear: usar defaults
      setFormData({
        title: defaultTitle || '',
        appointmentStatus: 'pending',
        startTime: defaultStart ? toLocalInputValue(defaultStart, defaultTimeZone || DEFAULT_TIMEZONE) : '',
        endTime: defaultEnd ? toLocalInputValue(defaultEnd, defaultTimeZone || DEFAULT_TIMEZONE) : '',
        notes: '',
        address: '',
        timeZone: defaultTimeZone || DEFAULT_TIMEZONE
      });
    } else if (!isOpen) {
      setFormData(INITIAL_FORM_STATE);
    }
  }, [event, isOpen, isCreateMode, defaultStart, defaultEnd, defaultTimeZone, defaultTitle]);

  const handleSave = async () => {
    try {
      setIsSaving(true);

      if (isCreateMode) {
        // Modo crear: enviar payload completo
        const payload = {
          title: formData.title.trim(),
          appointmentStatus: formData.appointmentStatus,
          notes: formData.notes,
          address: formData.address,
          timeZone: formData.timeZone,
          startTime: '',
          endTime: ''
        };

        if (formData.startTime) {
          const startIso = convertLocalInputToISO(formData.startTime, formData.timeZone);
          if (startIso) payload.startTime = startIso;
        }

        if (formData.endTime) {
          const endIso = convertLocalInputToISO(formData.endTime, formData.timeZone);
          if (endIso) payload.endTime = endIso;
        }

        await onSave(payload);
      } else {
        // Modo editar: enviar updates con eventId
        if (!event) return;

        const updates: Partial<CalendarEvent> = {
          title: formData.title.trim(),
          appointmentStatus: formData.appointmentStatus,
          notes: formData.notes,
          address: formData.address,
          timeZone: formData.timeZone
        };

        if (formData.startTime) {
          const startIso = convertLocalInputToISO(formData.startTime, formData.timeZone);
          if (startIso) updates.startTime = startIso;
        }

        if (formData.endTime) {
          const endIso = convertLocalInputToISO(formData.endTime, formData.timeZone);
          if (endIso) updates.endTime = endIso;
        }

        await onSave(event.id, updates);
      }

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

  const currentStatus = STATUS_OPTIONS.find((status) => status.value === formData.appointmentStatus);
  const startDate = parseDateSafe(formData.startTime) ?? parseDateSafe(event?.startTime);
  const endDate = parseDateSafe(formData.endTime) ?? parseDateSafe(event?.endTime);
  const selectedTimeZone =
    formData.timeZone ||
    event?.timeZone ||
    (event as any)?.timeZone ||
    (event as any)?.timezone ||
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
            {!isCreateMode && onDelete && (
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
                onChange={(e) => {
                  const newZone = e.target.value;
                  setFormData((prev) => {
                    const startIso = prev.startTime
                      ? convertLocalInputToISO(prev.startTime, prev.timeZone) ?? ''
                      : '';
                    const endIso = prev.endTime
                      ? convertLocalInputToISO(prev.endTime, prev.timeZone) ?? ''
                      : '';

                    return {
                      ...prev,
                      timeZone: newZone,
                      startTime: startIso ? toLocalInputValue(startIso, newZone) : '',
                      endTime: endIso ? toLocalInputValue(endIso, newZone) : ''
                    };
                  });
                }}
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
            {isSaving ? 'Guardando...' : isCreateMode ? 'Crear cita' : 'Guardar cambios'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
