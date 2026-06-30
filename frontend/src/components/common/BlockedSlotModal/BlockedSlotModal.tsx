import React, { useState, useEffect } from 'react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { DateTimePicker } from '../DateTimePicker';
import { CustomSelect } from '../CustomSelect';
import { apiUrl } from '@/services/apiBaseUrl';
import { Calendar, BlockedSlot } from '@/services/calendarsService';
import { useNotification } from '@/contexts/NotificationContext';
import { useTimezone } from '@/contexts/TimezoneContext';
import { localDateTimeInputToUTCISOString, toDateTimeLocalInputValue } from '@/utils/timezone';
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
  title: 'Ausencia',
  startTime: '',
  endTime: '',
  timeZone: DEFAULT_TIMEZONE,
  assignedUserId: ''
};

const pad = (value: number) => String(value).padStart(2, '0');

const browserLocalInputFromPickerValue = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const pickerValueFromBusinessInstant = (value: string, timezone: string) => {
  const localValue = toDateTimeLocalInputValue(value, timezone);
  const pickerDate = new Date(localValue);
  return Number.isNaN(pickerDate.getTime()) ? '' : pickerDate.toISOString();
};

const pickerValueFromBusinessLocal = (value: string) => {
  const pickerDate = new Date(value);
  return Number.isNaN(pickerDate.getTime()) ? '' : pickerDate.toISOString();
};

const businessInstantFromPickerValue = (value: string, timezone: string) => {
  const localValue = browserLocalInputFromPickerValue(value);
  return localDateTimeInputToUTCISOString(localValue, timezone) || null;
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
    description: 'No disponible todo el día',
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
    description: '4 horas desde la hora que elijas',
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
    description: '4 horas desde la hora que elijas',
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
  defaultTimeZone = '',
  accessToken,
  locationId,
  onSave,
  onDelete
}) => {
  const { showToast } = useNotification();
  const { timezone: accountTimezone } = useTimezone();
  const effectiveTimeZone = defaultTimeZone || accountTimezone;
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

        // Extraer team members del calendario
        const teamMemberIds = calendar.teamMembers?.map(tm => tm.userId) || [];

        if (teamMemberIds.length === 0) {
          // Si no hay team members, obtener usuarios del location
          try {
            const url = new URL(apiUrl('/api/highlevel/users'), window.location.origin);
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
              setUsers(locationUsers);
            } else {
              setUsers([]);
            }
          } catch {
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

          const response = await fetch(apiUrl('/api/highlevel/users/by-ids'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          });

          if (response.ok) {
            const result = await response.json();
            const usersData = result.data || [];
            setUsers(usersData);
          } else {
            // Fallback: mostrar IDs truncados
            const fallbackUsers = teamMemberIds.map(id => ({
              id,
              name: `Usuario ${id.substring(0, 8)}...`,
              email: '',
              firstName: '',
              lastName: ''
            }));
            setUsers(fallbackUsers);
          }
        } catch {
          // Fallback: mostrar IDs truncados
          const fallbackUsers = teamMemberIds.map(id => ({
            id,
            name: `Usuario ${id.substring(0, 8)}...`,
            email: '',
            firstName: '',
            lastName: ''
          }));
          setUsers(fallbackUsers);
        }
      } catch {
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

    const now = new Date(toDateTimeLocalInputValue(new Date(), effectiveTimeZone));
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

    setFormData({
      ...formData,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString()
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
          // Calcular end time según la duración (ISO directo para DateTimePicker)
          const endDate = new Date(startDate.getTime() + currentPreset.duration * 60 * 60 * 1000);
          setFormData({
            ...formData,
            startTime: value,
            endTime: endDate.toISOString()
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
      // Siempre arrancar en "Personalizado": en edición garantiza que se vean ambos
      // selectores (inicio y fin); en creación es el modo neutro por defecto.
      setSelectedPreset('custom');
      if (isCreateMode) {
        // Modo crear: usar defaults
        setFormData({
          title: 'Ausencia',
          startTime: defaultStart ? pickerValueFromBusinessInstant(defaultStart, effectiveTimeZone) : '',
          endTime: defaultEnd ? pickerValueFromBusinessInstant(defaultEnd, effectiveTimeZone) : '',
          timeZone: effectiveTimeZone,
          assignedUserId: users[0]?.id || ''
        });
      } else if (blockedSlot) {
        const startTimeValue = blockedSlot.startIso
          ? pickerValueFromBusinessInstant(blockedSlot.startIso, effectiveTimeZone)
          : (blockedSlot.date && blockedSlot.startTime
            ? pickerValueFromBusinessLocal(`${blockedSlot.date}T${blockedSlot.startTime}:00`)
            : '');
        const endTimeValue = blockedSlot.endIso
          ? pickerValueFromBusinessInstant(blockedSlot.endIso, effectiveTimeZone)
          : (blockedSlot.date && blockedSlot.endTime
            ? pickerValueFromBusinessLocal(`${blockedSlot.date}T${blockedSlot.endTime}:00`)
            : '');

        setFormData({
          title: blockedSlot.reason || 'Ausencia',
          startTime: startTimeValue,
          endTime: endTimeValue,
          timeZone: effectiveTimeZone,
          assignedUserId: blockedSlot.blockedBy || users[0]?.id || ''
        });
      }
    } else {
      // Reset al cerrar
      setFormData({ ...INITIAL_FORM_STATE, timeZone: effectiveTimeZone });
      setShowDeleteConfirm(false);
      setSelectedPreset('custom');
    }
  }, [isOpen, isCreateMode, blockedSlot, defaultStart, defaultEnd, effectiveTimeZone, users]);

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
        showToast('error', 'Usuario requerido', 'Debes seleccionar un usuario para la ausencia');
        setIsSaving(false);
        return;
      }

      const payload: any = {
        title: formData.title.trim() || 'Ausencia'
      };

      // IMPORTANTE: El API de HighLevel usa lógica EXCLUSIVA (XOR):
      // - calendarId (sin assignedUserId) → Bloquea TODO el calendario
      // - assignedUserId (sin calendarId) → Bloquea solo ese usuario
      // - AMBOS → ERROR 422

      const hasTeamMembers2 = calendar && calendar.teamMembers && calendar.teamMembers.length > 0;

      if (formData.assignedUserId && hasTeamMembers2) {
        // Calendario con usuarios: bloquear solo el usuario seleccionado
        payload.assignedUserId = formData.assignedUserId;
      } else {
        // Calendario sin usuarios o sin selección: bloquear todo el calendario
        payload.calendarId = calendar?.id;
      }

      const startIso = formData.startTime ? businessInstantFromPickerValue(formData.startTime, formData.timeZone || effectiveTimeZone) : null;
      const endIso = formData.endTime ? businessInstantFromPickerValue(formData.endTime, formData.timeZone || effectiveTimeZone) : null;

      if (startIso && endIso && new Date(endIso).getTime() <= new Date(startIso).getTime()) {
        showToast('error', 'Rango inválido', 'La hora de fin debe ser posterior a la de inicio');
        setIsSaving(false);
        return;
      }

      if (startIso) payload.startTime = startIso;
      if (endIso) payload.endTime = endIso;
      payload.timeZone = formData.timeZone || effectiveTimeZone;

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
        title={isCreateMode ? 'Marcar ausencia' : 'Editar ausencia'}
        size="sm"
        type="custom"
        flushContent
      >
        <div className={styles.modalContent} data-modal-panel="">
        {/* Formulario */}
        <div className={styles.form}>
          {/* Título/Razón */}
          <div className={styles.field}>
            <label className={styles.label}>
              Motivo
            </label>
            <input
              type="text"
              className={styles.input}
              placeholder="Ej: Vacaciones, día festivo, fuera de oficina..."
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            />
          </div>

          {/* Presets de bloqueo rápido */}
          {isCreateMode && (
            <div className={styles.field}>
              <label className={styles.label}>
                Opciones rápidas
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
                <div className={styles.loadingUsers} role="status" aria-live="polite" aria-label="Cargando usuarios">
                  <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
                </div>
              ) : users.length > 0 ? (
                <CustomSelect
                  options={users.map(user => ({
                    value: user.id,
                    label: user.name || user.email || user.id
                }))}
                value={formData.assignedUserId}
                onValueChange={(value) => setFormData({ ...formData, assignedUserId: value })}
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
              {isSaving ? 'Guardando...' : isCreateMode ? 'Guardar ausencia' : 'Guardar cambios'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>

    <Modal
      isOpen={isClient && showDeleteConfirm}
      onClose={() => setShowDeleteConfirm(false)}
      title="Quitar ausencia"
      message="¿Seguro que quieres quitar esta ausencia? Volverás a estar disponible en ese tiempo."
      type="confirm"
      confirmText="Quitar"
      cancelText="Cancelar"
      onConfirm={handleConfirmDelete}
    />
  </>
);
};
