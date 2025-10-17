import React, { useState, useEffect } from 'react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { CalendarEvent } from '@/services/calendarsService';
import { formatDate, formatTime12h } from '@/utils/format';
import styles from './AppointmentModal.module.css';

interface AppointmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  event: CalendarEvent | null;
  onSave: (eventId: string, updates: Partial<CalendarEvent>) => Promise<void>;
  onDelete?: (eventId: string) => Promise<void>;
}

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pendiente', color: 'var(--color-warning-500)' },
  { value: 'confirmed', label: 'Confirmada', color: 'var(--color-success-500)' },
  { value: 'cancelled', label: 'Cancelada', color: 'var(--color-error-500)' },
  { value: 'showed', label: 'Asistió', color: 'var(--color-info-500)' },
  { value: 'noshow', label: 'No asistió', color: 'var(--color-gray-500)' },
  { value: 'rescheduled', label: 'Reprogramada', color: 'var(--color-purple-500)' }
];

export const AppointmentModal: React.FC<AppointmentModalProps> = ({
  isOpen,
  onClose,
  event,
  onSave,
  onDelete
}) => {
  const [isEditing, setIsEditing] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    appointmentStatus: 'pending' as CalendarEvent['appointmentStatus'],
    startTime: '',
    endTime: '',
    notes: '',
    address: ''
  });

  useEffect(() => {
    if (event) {
      setFormData({
        title: event.title || '',
        appointmentStatus: event.appointmentStatus || 'pending',
        startTime: event.startTime ? new Date(event.startTime).toISOString().slice(0, 16) : '',
        endTime: event.endTime ? new Date(event.endTime).toISOString().slice(0, 16) : '',
        notes: event.notes || '',
        address: event.address || ''
      });
      setIsEditing(true);
    }
  }, [event]);

  const handleSave = async () => {
    if (!event) return;

    try {
      setIsSaving(true);

      const updates: Partial<CalendarEvent> = {
        title: formData.title,
        appointmentStatus: formData.appointmentStatus,
        startTime: new Date(formData.startTime).toISOString(),
        endTime: new Date(formData.endTime).toISOString(),
        notes: formData.notes,
        address: formData.address
      };

      await onSave(event.id, updates);
      setIsEditing(false);
      onClose();
    } catch (error) {
      console.error('Error al guardar cita:', error);
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
      console.error('Error al eliminar cita:', error);
    } finally {
      setIsSaving(false);
    }
  };

  if (!event) return null;

  const currentStatus = STATUS_OPTIONS.find(s => s.value === event.appointmentStatus);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? 'Editar Cita' : 'Detalles de la Cita'}
      size="lg"
    >
      <div className={styles.container}>
        {/* Modo vista */}
        {!isEditing ? (
          <div className={styles.viewMode}>
            <div className={styles.field}>
              <label className={styles.label}>Título</label>
              <p className={styles.value}>{event.title}</p>
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Estado</label>
              <div className={styles.statusBadge} style={{ backgroundColor: `${currentStatus?.color}20`, color: currentStatus?.color }}>
                {currentStatus?.label || event.appointmentStatus}
              </div>
            </div>

            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label className={styles.label}>Fecha y hora de inicio</label>
                <p className={styles.value}>
                  {formatDate(new Date(event.startTime))} · {formatTime12h(event.startTime)}
                </p>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Fecha y hora de fin</label>
                <p className={styles.value}>
                  {formatDate(new Date(event.endTime))} · {formatTime12h(event.endTime)}
                </p>
              </div>
            </div>

            {event.address && (
              <div className={styles.field}>
                <label className={styles.label}>Ubicación</label>
                <p className={styles.value}>{event.address}</p>
              </div>
            )}

            {event.notes && (
              <div className={styles.field}>
                <label className={styles.label}>Notas</label>
                <p className={styles.value}>{event.notes}</p>
              </div>
            )}

            <div className={styles.metadata}>
              <span className={styles.metaItem}>ID: {event.id}</span>
              {event.contactId && <span className={styles.metaItem}>Contacto ID: {event.contactId}</span>}
            </div>
          </div>
        ) : (
          /* Modo edición */
          <div className={styles.editMode}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="title">
                Título
              </label>
              <input
                id="title"
                type="text"
                className={styles.input}
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="status">
                Estado
              </label>
              <select
                id="status"
                className={styles.select}
                value={formData.appointmentStatus}
                onChange={(e) => setFormData({ ...formData, appointmentStatus: e.target.value as CalendarEvent['appointmentStatus'] })}
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
                placeholder="Dirección o enlace de videollamada"
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="notes">
                Notas
              </label>
              <textarea
                id="notes"
                className={styles.textarea}
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                placeholder="Notas adicionales..."
                rows={3}
              />
            </div>
          </div>
        )}

        {/* Botones de acción */}
        <div className={styles.actions}>
          {!isEditing ? (
            <>
              <Button variant="secondary" onClick={onClose}>
                Cerrar
              </Button>
              <div className={styles.actionsRight}>
                {onDelete && (
                  <Button variant="danger" onClick={handleDelete} disabled={isSaving}>
                    Eliminar
                  </Button>
                )}
                <Button variant="primary" onClick={() => setIsEditing(true)}>
                  Editar
                </Button>
              </div>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setIsEditing(false)} disabled={isSaving}>
                Cancelar
              </Button>
              <Button variant="primary" onClick={handleSave} disabled={isSaving}>
                {isSaving ? 'Guardando...' : 'Guardar cambios'}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};
