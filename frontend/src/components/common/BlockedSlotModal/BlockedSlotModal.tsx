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

// Presets de bloqueo rápido
type PresetType = 'custom' | 'full_day' | 'morning' | 'afternoon' | 'this_week' | 'next_week' | 'this_month';

interface BlockingPreset {
  value: PresetType;
  label: string;
  description: string;
  // Control de qué campos mostrar
  showStartDate: boolean; // Mostrar selector de fecha de inicio
  showStartTime: boolean; // Mostrar selector de hora de inicio
  showEndDate: boolean;   // Mostrar selector de fecha de fin
  showEndTime: boolean;   // Mostrar selector de hora de fin
  autoCalculateEnd: boolean; // Si debe calcular automáticamente el fin al cambiar el inicio
  duration?: number;      // Duración en horas (para auto-calcular)
}

const BLOCKING_PRESETS: BlockingPreset[] = [
  {
    value: 'custom',
    label: 'Personalizado',
    description: 'Elige fechas y horas manualmente',
    showStartDate: true,
    showStartTime: true,
    showEndDate: true,
    showEndTime: true,
    autoCalculateEnd: false
  },
  {
    value: 'full_day',
    label: 'Todo el día',
    description: 'Bloquea todo el día (24 horas)',
    showStartDate: true,
    showStartTime: false,
    showEndDate: false,
    showEndTime: false,
    autoCalculateEnd: true,
    duration: 24
  },
  {
    value: 'morning',
    label: 'Media mañana',
    description: 'Bloquea 4 horas desde la hora que elijas',
    showStartDate: true,
    showStartTime: true,
    showEndDate: false,
    showEndTime: false,
    autoCalculateEnd: true,
    duration: 4
  },
  {
    value: 'afternoon',
    label: 'Media tarde',
    description: 'Bloquea 4 horas desde la hora que elijas',
    showStartDate: true,
    showStartTime: true,
    showEndDate: false,
    showEndTime: false,
    autoCalculateEnd: true,
    duration: 4
  },
  {
    value: 'this_week',
    label: 'Esta semana',
    description: 'Lunes a viernes (todo el día)',
    showStartDate: false,
    showStartTime: false,
    showEndDate: false,
    showEndTime: false,
    autoCalculateEnd: true
  },
  {
    value: 'next_week',
    label: 'Próxima semana',
    description: 'Lunes a viernes (todo el día)',
    showStartDate: false,
    showStartTime: false,
    showEndDate: false,
    showEndTime: false,
    autoCalculateEnd: true
  },
  {
    value: 'this_month',
    label: 'Este mes',
    description: 'Días laborales restantes (todo el día)',
    showStartDate: false,
    showStartTime: false,
    showEndDate: false,
    showEndTime: false,
    autoCalculateEnd: true
  }
];

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
  const [selectedPreset, setSelectedPreset] = useState<PresetType>('custom');

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

  // Función para calcular fechas según preset
  const applyPreset = (preset: PresetType) => {
    if (preset === 'custom') return;

    const now = new Date();
    let startDate: Date;
    let endDate: Date;

    switch (preset) {
      case 'full_day':
        // Todo el día: desde las 00:00 hasta las 23:59 de hoy
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0);
        break;

      case 'morning':
        // Media mañana: 4 horas desde las 9am por default (usuario puede cambiar)
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
        endDate = new Date(startDate.getTime() + 4 * 60 * 60 * 1000); // +4 horas
        break;

      case 'afternoon':
        // Media tarde: 4 horas desde las 2pm por default (usuario puede cambiar)
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 0, 0);
        endDate = new Date(startDate.getTime() + 4 * 60 * 60 * 1000); // +4 horas
        break;

      case 'this_week':
        // Lunes a viernes de esta semana (todo el día)
        const currentDay = now.getDay(); // 0 = domingo, 1 = lunes, etc.
        const daysUntilMonday = currentDay === 0 ? 1 : 1 - currentDay; // Si es domingo, ir al lunes siguiente
        const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilMonday, 0, 0, 0);
        const friday = new Date(monday);
        friday.setDate(monday.getDate() + 4);
        friday.setHours(23, 59, 0);
        startDate = monday;
        endDate = friday;
        break;

      case 'next_week':
        // Lunes a viernes de la próxima semana (todo el día)
        const nextMonday = new Date(now);
        const daysToNextMonday = (7 - now.getDay() + 1) % 7 || 7;
        nextMonday.setDate(now.getDate() + daysToNextMonday);
        nextMonday.setHours(0, 0, 0, 0);
        const nextFriday = new Date(nextMonday);
        nextFriday.setDate(nextMonday.getDate() + 4);
        nextFriday.setHours(23, 59, 0);
        startDate = nextMonday;
        endDate = nextFriday;
        break;

      case 'this_month':
        // Desde hoy hasta el fin de mes (todo el día)
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 0); // Último día del mes
        break;

      default:
        return;
    }

    // Convertir a formato ISO local para los inputs datetime-local
    const startISO = startDate.toISOString();
    const endISO = endDate.toISOString();

    setFormData({
      ...formData,
      startTime: toLocalInputValue(startISO, formData.timeZone),
      endTime: toLocalInputValue(endISO, formData.timeZone)
    });
  };

  // Manejar cambio de preset
  const handlePresetChange = (preset: PresetType) => {
    setSelectedPreset(preset);
    applyPreset(preset);
  };

  // Auto-calcular end time cuando cambia start time (solo si preset lo requiere)
  const handleStartTimeChange = (value: string) => {
    setFormData({ ...formData, startTime: value });

    // Buscar el preset actual
    const currentPreset = BLOCKING_PRESETS.find(p => p.value === selectedPreset);

    // Si el preset tiene auto-cálculo y una duración definida
    if (currentPreset?.autoCalculateEnd && currentPreset.duration) {
      try {
        const startDate = new Date(value);
        if (!isNaN(startDate.getTime())) {
          // Calcular end time según la duración
          const endDate = new Date(startDate.getTime() + currentPreset.duration * 60 * 60 * 1000);
          const endISO = endDate.toISOString();
          setFormData({
            ...formData,
            startTime: value,
            endTime: toLocalInputValue(endISO, formData.timeZone)
          });
        }
      } catch (error) {
        // Si hay error, solo actualizar startTime
        setFormData({ ...formData, startTime: value });
      }
    }
  };

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

      // Si el calendario tiene team members, es obligatorio seleccionar usuario
      const hasTeamMembers = calendar && calendar.teamMembers && calendar.teamMembers.length > 0;

      // Si NO hay assignedUserId y el calendario SÍ tiene team members, mostrar error
      if (!formData.assignedUserId && hasTeamMembers) {
        showToast('error', 'Usuario requerido', 'Debes seleccionar un usuario para asignar el bloqueo');
        setIsSaving(false);
        return;
      }

      const payload: any = {
        title: formData.title.trim() || 'Horario bloqueado'
      };

      // IMPORTANTE: Solo incluir assignedUserId si el calendario tiene team members
      // Los calendarios de EVENTO no tienen usuarios y NO deben recibir assignedUserId
      const hasTeamMembers2 = calendar && calendar.teamMembers && calendar.teamMembers.length > 0;

      if (formData.assignedUserId && hasTeamMembers2) {
        payload.assignedUserId = formData.assignedUserId;
      }

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
        size="sm"
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

          {/* Presets de bloqueo rápido */}
          {isCreateMode && (
            <div className={styles.field}>
              <label className={styles.label}>
                Opciones de bloqueo rápido
              </label>
              <div className={styles.presetsGrid}>
                {BLOCKING_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    className={`${styles.presetCard} ${selectedPreset === preset.value ? styles.presetCardActive : ''}`}
                    onClick={() => handlePresetChange(preset.value)}
                  >
                    <div className={styles.presetLabel}>{preset.label}</div>
                    <div className={styles.presetDescription}>{preset.description}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Usuario asignado - Solo mostrar si el calendario tiene team members */}
          {calendar && calendar.teamMembers && calendar.teamMembers.length > 0 && (
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
          )}

          {/* Fecha y hora - Mostrar campos según preset seleccionado */}
          <div className={styles.field}>
            <label className={styles.label}>
              {selectedPreset === 'custom' ? 'Fechas y horario' : 'Configuración'} <span className={styles.required}>*</span>
            </label>

            {/* Obtener configuración del preset actual */}
            {(() => {
              const currentPreset = BLOCKING_PRESETS.find(p => p.value === selectedPreset);
              const showStart = currentPreset?.showStartDate || currentPreset?.showStartTime;
              const showEnd = currentPreset?.showEndDate || currentPreset?.showEndTime;

              // Si no hay campos que mostrar (ej: "Esta semana", "Próxima semana")
              if (!showStart && !showEnd) {
                return (
                  <div className={styles.presetInfo}>
                    Las fechas se configuran automáticamente según el preset seleccionado
                  </div>
                );
              }

              return (
                <div className={styles.fieldRow}>
                  {/* Fecha y hora de inicio */}
                  {showStart && (
                    <div className={styles.field}>
                      <DateTimePicker
                        label={showEnd ? "Inicio" : undefined} // Solo mostrar label "Inicio" si también hay campo de Fin
                        value={formData.startTime}
                        onChange={(value) => handleStartTimeChange(value)}
                        placeholder="Selecciona fecha y hora"
                      />
                    </div>
                  )}

                  {/* Fecha y hora de fin - Solo si el preset lo permite */}
                  {showEnd && (
                    <div className={styles.field}>
                      <DateTimePicker
                        label="Fin"
                        value={formData.endTime}
                        onChange={(value) => {
                          setFormData({ ...formData, endTime: value });
                        }}
                        placeholder="Selecciona fecha y hora de fin"
                        minDate={formData.startTime}
                      />
                    </div>
                  )}
                </div>
              );
            })()}
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
