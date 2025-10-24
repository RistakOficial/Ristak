import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { DateTimePicker } from '../DateTimePicker';
import { CustomSelect } from '../CustomSelect';
import { Calendar, BlockedSlot } from '@/services/calendarsService';
import { useNotification } from '@/contexts/NotificationContext';
import styles from './BlockedSlotModal.module.css';
import { Trash2, Loader2 } from 'lucide-react';

interface BlockedSlotModalProps {
  isOpen: boolean;
  onClose: () => void;
  calendar?: Calendar | null;
  blockedSlot?: BlockedSlot & { id?: string } | null; // Si existe, es modo editar
  mode?: 'create' | 'edit';
  defaultStart?: string;
  defaultEnd?: string;
  defaultTimeZone?: string;
  accessToken?: string;
  locationId?: string;
  onSave: (payload: any, eventId?: string) => Promise<void>;
  onDelete?: (eventId: string) => Promise<void>;
}

interface User {
  id: string;
  name: string;
  email: string;
  firstName?: string;
  lastName?: string;
}

const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const INITIAL_FORM_STATE = {
  title: 'Horario bloqueado',
  startTime: '',
  endTime: '',
  timeZone: DEFAULT_TIMEZONE,
  assignedUserId: ''
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

const toLocalInputValue = (isoString: string, timeZone: string): string => {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';

    const parts = getTimeZoneParts(date, timeZone);
    if (!parts) return '';

    const year = parts.year || date.getFullYear();
    const month = String(parts.month || date.getMonth() + 1).padStart(2, '0');
    const day = String(parts.day || date.getDate()).padStart(2, '0');
    const hour = String(parts.hour || date.getHours()).padStart(2, '0');
    const minute = String(parts.minute || date.getMinutes()).padStart(2, '0');

    return `${year}-${month}-${day}T${hour}:${minute}`;
  } catch {
    return '';
  }
};

const convertLocalInputToISO = (localInput: string, timeZone: string): string | null => {
  if (!localInput) return null;

  try {
    const [datePart, timePart] = localInput.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute] = timePart.split(':').map(Number);

    const dateString = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;

    const localDate = new Date(dateString);
    if (isNaN(localDate.getTime())) return null;

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short'
    });

    const parts = formatter.formatToParts(localDate);
    const tzParts: Record<string, string> = {};
    parts.forEach(p => {
      if (p.type !== 'literal') tzParts[p.type] = p.value;
    });

    const utcDate = new Date(`${tzParts.year}-${tzParts.month}-${tzParts.day}T${tzParts.hour}:${tzParts.minute}:${tzParts.second}Z`);
    const offset = (localDate.getTime() - utcDate.getTime()) / 60000;
    const finalDate = new Date(localDate.getTime() - offset * 60000);

    return finalDate.toISOString();
  } catch {
    return null;
  }
};

export const BlockedSlotModal: React.FC<BlockedSlotModalProps> = ({
  isOpen,
  onClose,
  calendar,
  blockedSlot,
  mode = 'create',
  defaultStart = '',
  defaultEnd = '',
  defaultTimeZone = DEFAULT_TIMEZONE,
  accessToken,
  locationId,
  onSave,
  onDelete
}) => {
  const { showToast } = useNotification();
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState(INITIAL_FORM_STATE);
  const isCreateMode = mode === 'create';
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isClient, setIsClient] = useState(false);

  // Users (team members del calendario)
  const [users, setUsers] = useState<User[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  // Cargar usuarios del calendario
  useEffect(() => {
    if (!calendar || !isOpen) return;

    const loadUsers = async () => {
      try {
        setLoadingUsers(true);

        console.log('🔵 [BlockedSlotModal] Iniciando carga de usuarios');
        console.log('🔵 [BlockedSlotModal] Calendar:', calendar);
        console.log('🔵 [BlockedSlotModal] Calendar ID:', calendar.id);
        console.log('🔵 [BlockedSlotModal] Calendar Name:', calendar.name);

        // Extraer team members del calendario
        const teamMemberIds = calendar.teamMembers?.map(tm => tm.userId) || [];
        console.log('🔵 [BlockedSlotModal] Team Members del calendario:', calendar.teamMembers);
        console.log('🔵 [BlockedSlotModal] Team Member IDs extraídos:', teamMemberIds);

        if (teamMemberIds.length === 0) {
          console.log('🟡 [BlockedSlotModal] ⚠️ No hay team members en el calendario');
          console.log('🔵 [BlockedSlotModal] Intentando obtener usuarios del location...');

          // Si no hay team members, obtener usuarios del location
          try {
            const url = new URL(`${import.meta.env.VITE_API_URL}/api/highlevel/users`);
            url.searchParams.append('accessToken', accessToken || '');
            url.searchParams.append('locationId', locationId || '');

            const response = await fetch(url.toString(), {
              method: 'GET',
              headers: {
                'Content-Type': 'application/json'
              }
            });

            if (response.ok) {
              const result = await response.json();
              const locationUsers = result.users || [];
              console.log('🟢 [BlockedSlotModal] ✅ Usuarios del location obtenidos:', locationUsers);
              setUsers(locationUsers);
            } else {
              console.log('🔴 [BlockedSlotModal] ❌ No se pudieron obtener usuarios del location');
              setUsers([]);
            }
          } catch (error) {
            console.log('🔴 [BlockedSlotModal] ❌ Error al obtener usuarios del location:', error);
            setUsers([]);
          }
          return;
        }

        // Intentar cargar usuarios desde la API
        try {
          const payload = {
            userIds: teamMemberIds,
            accessToken,
            locationId
          };
          console.log('🔵 [BlockedSlotModal] Payload para /api/highlevel/users/by-ids:', payload);

          const response = await fetch(`${import.meta.env.VITE_API_URL}/api/highlevel/users/by-ids`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          });

          console.log('🔵 [BlockedSlotModal] Response status:', response.status);
          console.log('🔵 [BlockedSlotModal] Response ok:', response.ok);

          if (response.ok) {
            const result = await response.json();
            console.log('🟢 [BlockedSlotModal] ✅ Respuesta exitosa:', result);
            const usersData = result.data || [];
            console.log('🟢 [BlockedSlotModal] Usuarios cargados:', usersData);
            setUsers(usersData);
          } else {
            const errorText = await response.text();
            console.log('🔴 [BlockedSlotModal] ❌ Error en response:', errorText);
            // Fallback: mostrar IDs truncados
            const fallbackUsers = teamMemberIds.map(id => ({
              id,
              name: `Usuario ${id.substring(0, 8)}...`,
              email: '',
              firstName: '',
              lastName: ''
            }));
            console.log('🟡 [BlockedSlotModal] Usando fallback users:', fallbackUsers);
            setUsers(fallbackUsers);
          }
        } catch (error) {
          console.log('🔴 [BlockedSlotModal] ❌ Excepción al cargar usuarios:', error);
          // Fallback: mostrar IDs truncados
          const fallbackUsers = teamMemberIds.map(id => ({
            id,
            name: `Usuario ${id.substring(0, 8)}...`,
            email: '',
            firstName: '',
            lastName: ''
          }));
          console.log('🟡 [BlockedSlotModal] Usando fallback users después de error:', fallbackUsers);
          setUsers(fallbackUsers);
        }
      } catch (error) {
        console.log('🔴 [BlockedSlotModal] ❌ Error general al cargar usuarios:', error);
        showToast('error', 'Error al cargar usuarios', 'No se pudieron cargar los usuarios del calendario');
      } finally {
        setLoadingUsers(false);
      }
    };

    loadUsers();
  }, [calendar, isOpen, accessToken, locationId, showToast]);

  // Inicializar formulario
  useEffect(() => {
    if (isOpen) {
      if (isCreateMode) {
        // Modo crear: usar defaults
        setFormData({
          title: 'Horario bloqueado',
          startTime: defaultStart || '',
          endTime: defaultEnd || '',
          timeZone: defaultTimeZone,
          assignedUserId: users[0]?.id || ''
        });
      } else if (blockedSlot) {
        // Modo editar: cargar datos del blocked slot
        const startTimeLocal = blockedSlot.date && blockedSlot.startTime
          ? toLocalInputValue(`${blockedSlot.date}T${blockedSlot.startTime}:00`, defaultTimeZone)
          : '';
        const endTimeLocal = blockedSlot.date && blockedSlot.endTime
          ? toLocalInputValue(`${blockedSlot.date}T${blockedSlot.endTime}:00`, defaultTimeZone)
          : '';

        setFormData({
          title: blockedSlot.reason || 'Horario bloqueado',
          startTime: startTimeLocal,
          endTime: endTimeLocal,
          timeZone: defaultTimeZone,
          assignedUserId: blockedSlot.blockedBy || users[0]?.id || ''
        });
      }
    } else {
      // Reset al cerrar
      setFormData(INITIAL_FORM_STATE);
      setShowDeleteConfirm(false);
    }
  }, [isOpen, isCreateMode, blockedSlot, defaultStart, defaultEnd, defaultTimeZone, users]);

  const handleSave = async () => {
    try {
      setIsSaving(true);

      // Validación: fechas requeridas
      if (!formData.startTime || !formData.endTime) {
        showToast('error', 'Fechas requeridas', 'Debes seleccionar fecha de inicio y fin');
        setIsSaving(false);
        return;
      }

      // Validación: usuario asignado requerido
      if (!formData.assignedUserId) {
        showToast('error', 'Usuario requerido', 'Debes seleccionar un usuario para asignar el bloqueo');
        setIsSaving(false);
        return;
      }

      const payload: any = {
        title: formData.title.trim() || 'Horario bloqueado',
        assignedUserId: formData.assignedUserId
      };

      if (formData.startTime) {
        const startIso = convertLocalInputToISO(formData.startTime, formData.timeZone);
        if (startIso) payload.startTime = startIso;
      }

      if (formData.endTime) {
        const endIso = convertLocalInputToISO(formData.endTime, formData.timeZone);
        if (endIso) payload.endTime = endIso;
      }

      if (isCreateMode) {
        // Agregar calendarId y locationId solo en modo crear
        payload.calendarId = calendar?.id;
        payload.locationId = locationId;
        await onSave(payload);
      } else {
        // Modo editar: enviar eventId
        if (!blockedSlot || !(blockedSlot as any).id) return;
        await onSave(payload, (blockedSlot as any).id);
      }

      onClose();
    } catch (error) {
      // Error manejado en el componente padre
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteClick = () => {
    setShowDeleteConfirm(true);
  };

  const handleConfirmDelete = async () => {
    if (!blockedSlot || !onDelete || !(blockedSlot as any).id) return;

    try {
      setIsSaving(true);
      await onDelete((blockedSlot as any).id);
      setShowDeleteConfirm(false);
      onClose();
    } catch (error) {
      // Error manejado en el componente padre
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={isCreateMode ? 'Bloquear horario' : 'Editar horario bloqueado'}
        size="md"
        type="custom"
      >
        <div className={styles.modalContent}>
        {/* Formulario */}
        <div className={styles.form}>
          {/* Título/Razón */}
          <div className={styles.field}>
            <label className={styles.label}>
              Título o razón
            </label>
            <input
              type="text"
              className={styles.input}
              placeholder="Ej: Reunión interna, Almuerzo, Fuera de oficina..."
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            />
          </div>

          {/* Usuario asignado */}
          <div className={styles.field}>
            <label className={styles.label}>
              Usuario asignado <span className={styles.required}>*</span>
            </label>
            {loadingUsers ? (
              <div className={styles.loadingUsers}>
                <Loader2 size={16} className={styles.spinner} />
                <span>Cargando usuarios...</span>
              </div>
            ) : users.length > 0 ? (
              <CustomSelect
                options={users.map(user => ({
                  value: user.id,
                  label: user.name || user.email || user.id
                }))}
                value={formData.assignedUserId}
                onChange={(value) => setFormData({ ...formData, assignedUserId: value })}
                placeholder="Selecciona un usuario"
              />
            ) : (
              <div className={styles.noUsers}>
                No hay usuarios disponibles en este calendario
              </div>
            )}
          </div>

          {/* Fecha y hora de inicio */}
          <div className={styles.field}>
            <label className={styles.label}>
              Inicio <span className={styles.required}>*</span>
            </label>
            <DateTimePicker
              value={formData.startTime}
              onChange={(value) => setFormData({ ...formData, startTime: value })}
              placeholder="Selecciona fecha y hora de inicio"
            />
          </div>

          {/* Fecha y hora de fin */}
          <div className={styles.field}>
            <label className={styles.label}>
              Fin <span className={styles.required}>*</span>
            </label>
            <DateTimePicker
              value={formData.endTime}
              onChange={(value) => setFormData({ ...formData, endTime: value })}
              placeholder="Selecciona fecha y hora de fin"
            />
          </div>
        </div>

        {/* Acciones */}
        <div className={styles.actions}>
          {!isCreateMode && onDelete && (
            <Button
              variant="danger"
              size="md"
              onClick={handleDeleteClick}
              disabled={isSaving}
              leftIcon={<Trash2 size={16} />}
            >
              Eliminar
            </Button>
          )}
          <div className={styles.actionsRight}>
            <Button
              variant="secondary"
              size="md"
              onClick={onClose}
              disabled={isSaving}
            >
              Cancelar
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving ? 'Guardando...' : isCreateMode ? 'Crear bloqueo' : 'Guardar cambios'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>

    {/* Modal de confirmación de eliminación */}
    {isClient && showDeleteConfirm && createPortal(
      <div className={styles.deleteModalOverlay} onClick={(e) => {
        if (e.target === e.currentTarget) {
          setShowDeleteConfirm(false);
        }
      }}>
        <div className={styles.deleteModal}>
          <div className={styles.deleteModalHeader}>
            <h3>Confirmar eliminación</h3>
          </div>
          <p>¿Estás seguro de que deseas eliminar este horario bloqueado? Esta acción no se puede deshacer.</p>
          <div className={styles.deleteModalActions}>
            <Button
              variant="secondary"
              size="md"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isSaving}
            >
              Cancelar
            </Button>
            <Button
              variant="danger"
              size="md"
              onClick={handleConfirmDelete}
              disabled={isSaving}
            >
              {isSaving ? 'Eliminando...' : 'Eliminar'}
            </Button>
          </div>
        </div>
      </div>,
      document.body
    )}
    </>
  );
};
