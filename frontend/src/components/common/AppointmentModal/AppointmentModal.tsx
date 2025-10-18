import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { DateTimePicker } from '../DateTimePicker';
import { CalendarEvent, Calendar, calendarsService } from '@/services/calendarsService';
import { formatDate } from '@/utils/format';
import { useNotification } from '@/contexts/NotificationContext';
import styles from './AppointmentModal.module.css';
import { Trash2, Search, Loader2, X, UserPlus } from 'lucide-react';

interface AppointmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  event?: CalendarEvent | null;
  calendar?: Calendar | null; // Nuevo: información del calendario
  mode?: 'view' | 'create';
  defaultStart?: string;
  defaultEnd?: string;
  defaultTimeZone?: string;
  defaultTitle?: string;
  onSave: (eventIdOrPayload: string | any, updates?: Partial<CalendarEvent>) => Promise<void>;
  onDelete?: (eventId: string) => Promise<void>;
}

interface Contact {
  id: string;
  name: string;
  email: string;
  phone: string;
  firstName?: string;
  lastName?: string;
}

interface User {
  id: string;
  name: string;
  email: string;
  firstName?: string;
  lastName?: string;
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
  appointmentStatus: 'confirmed' as CalendarEvent['appointmentStatus'],
  startTime: '',
  endTime: '',
  notes: '',
  address: '',
  timeZone: DEFAULT_TIMEZONE,
  contactId: '',
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

  // El input viene como "2025-10-18T14:30" (formato datetime-local del navegador)
  // Necesitamos convertirlo a "2025-10-18T14:30:00-06:00" (ISO 8601 con timezone offset de America/Mexico_City)

  // Parsear el input del datetime-local
  const [datePart, timePart] = value.split('T');
  if (!timePart) return null;

  // Extraer componentes
  const [year, month, day] = datePart.split('-');
  const [hour, minute] = timePart.split(':');

  // Crear fecha en la timezone especificada para obtener el offset correcto
  const dateInTz = new Date(`${year}-${month}-${day}T${hour}:${minute}:00`);

  // Obtener el offset usando Intl.DateTimeFormat
  const offsetMinutes = getTimezoneOffset(dateInTz, timeZone);

  // Convertir offset a formato +/-HH:MM
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetMins = Math.abs(offsetMinutes) % 60;
  const offsetSign = offsetMinutes <= 0 ? '+' : '-';
  const offsetStr = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMins).padStart(2, '0')}`;

  // Construir ISO 8601: 2025-10-18T14:30:00-06:00
  return `${year}-${month}-${day}T${hour}:${minute}:00${offsetStr}`;
};

// Helper para obtener el offset de timezone en minutos (formato: -360 para -06:00)
const getTimezoneOffset = (date: Date, timeZone: string): number => {
  // Crear dos versiones de la fecha: una en UTC y otra en la timezone especificada
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate = new Date(date.toLocaleString('en-US', { timeZone }));

  // La diferencia en milisegundos nos da el offset (invertido porque queremos UTC - TZ)
  return (utcDate.getTime() - tzDate.getTime()) / (1000 * 60);
};

export const AppointmentModal: React.FC<AppointmentModalProps> = ({
  isOpen,
  onClose,
  event,
  calendar,
  mode = 'view',
  defaultStart,
  defaultEnd,
  defaultTimeZone,
  defaultTitle,
  onSave,
  onDelete
}) => {
  const { showToast } = useNotification();
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState(INITIAL_FORM_STATE);
  const isCreateMode = mode === 'create';

  // Contact search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchingContact, setSearchingContact] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [showContactDropdown, setShowContactDropdown] = useState(false);

  // Users (assigned users)
  const [users, setUsers] = useState<User[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isClient, setIsClient] = useState(false);

  const loadUsers = async () => {
    setLoadingUsers(true);
    try {
      // Detectar si es Round Robin
      const isRoundRobin = calendar?.calendarType === 'round_robin';

      console.log('🔍 DEBUG loadUsers:', {
        hasCalendar: !!calendar,
        calendarType: calendar?.calendarType,
        isRoundRobin,
        teamMembersCount: calendar?.teamMembers?.length || 0,
        teamMembers: calendar?.teamMembers
      });

      if (isRoundRobin && calendar?.teamMembers && calendar.teamMembers.length > 0) {
        // Para Round Robin: obtener usuarios específicos por sus IDs
        const teamMemberIds = calendar.teamMembers.map(tm => tm.userId);

        console.log('📡 Obteniendo usuarios Round Robin por IDs:', teamMemberIds);

        try {
          const response = await fetch('/api/highlevel/users/by-ids', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ userIds: teamMemberIds })
          });

          if (!response.ok) {
            console.warn('⚠️  No se pudieron obtener nombres de usuarios (falta scope users.readonly)');
            console.warn('📋 Usando IDs como fallback');

            // Fallback: crear objetos usuario solo con IDs
            const fallbackUsers = teamMemberIds.map(userId => ({
              id: userId,
              name: `Usuario ${userId.substring(0, 8)}...`,
              email: '',
              firstName: '',
              lastName: ''
            }));

            setUsers(fallbackUsers);
            return;
          }

          const data = await response.json();
          const fetchedUsers = data.users || [];

          console.log('✅ Round Robin - Usuarios obtenidos:', {
            teamMemberIds,
            fetchedCount: fetchedUsers.length,
            fetchedUsers
          });

          setUsers(fetchedUsers);
        } catch (error) {
          console.error('❌ Error al obtener usuarios, usando IDs:', error);
          // Fallback en caso de error
          const fallbackUsers = teamMemberIds.map(userId => ({
            id: userId,
            name: `Usuario ${userId.substring(0, 8)}...`,
            email: '',
            firstName: '',
            lastName: ''
          }));
          setUsers(fallbackUsers);
        }
      } else {
        // Para calendarios normales: cargar todos los usuarios del location
        console.log('📡 Obteniendo todos los usuarios del location');

        const response = await fetch('/api/highlevel/users');
        if (!response.ok) throw new Error('Error al cargar usuarios');
        const data = await response.json();

        console.log('✅ Calendario normal - Todos los usuarios:', {
          usersCount: data.users?.length || 0
        });

        setUsers(data.users || []);
      }
    } catch (error) {
      console.error('❌ Error al cargar usuarios:', error);
      setUsers([]);
    } finally {
      setLoadingUsers(false);
    }
  };

  const loadContactById = async (contactId: string) => {
    try {
      const response = await fetch(`/api/highlevel/contacts/${contactId}`);
      if (!response.ok) throw new Error('Error al cargar contacto');
      const data = await response.json();
      const contact = data.contact;
      console.log('[loadContactById] Contacto recibido:', contact);
      if (contact) {
        // Construir nombre: prioridad name > firstName+lastName > email > phone
        const fullName = contact.name ||
                        (contact.firstName || contact.lastName
                          ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim()
                          : contact.email || contact.phone || 'Sin nombre');

        setSelectedContact({
          id: contact.id,
          name: fullName,
          email: contact.email || '',
          phone: contact.phone || '',
          firstName: contact.firstName || '',
          lastName: contact.lastName || ''
        });
      }
    } catch (error) {
      console.error('[loadContactById] Error:', error);
    }
  };

  const handleSelectContact = (contact: Contact) => {
    setSelectedContact(contact);

    // Auto-rellenar título SIEMPRE con el contact.name real
    const contactName = contact.name ||
                       `${contact.firstName || ''} ${contact.lastName || ''}`.trim() ||
                       contact.email;

    // SIEMPRE debe tener un nombre válido
    if (!contactName) {
      console.error('Contacto sin nombre válido:', contact);
      return;
    }

    setFormData({
      ...formData,
      contactId: contact.id,
      title: formData.title.trim() ? formData.title : contactName // Usar solo el nombre, sin "Cita con"
    });

    setSearchQuery('');
    setShowContactDropdown(false);
    setContacts([]);
  };

  const handleClearContact = () => {
    setSelectedContact(null);
    setFormData({ ...formData, contactId: '' });
    setSearchQuery('');
  };

  // Cargar usuarios SOLO cuando sea necesario (Round Robin)
  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    // Detectar si es Round Robin
    const isRoundRobin = calendar?.calendarType === 'round_robin';

    // Solo cargar usuarios si:
    // 1. Es modo crear Y es Round Robin (necesita elegir usuario)
    // 2. Es modo view Y tiene assignedUserId (para mostrar quién está asignado)
    const shouldLoadUsers =
      (isCreateMode && isRoundRobin) ||
      (!isCreateMode && formData.assignedUserId);

    if (shouldLoadUsers) {
      loadUsers();
    } else {
      // Limpiar usuarios si no son necesarios
      setUsers([]);
    }
  }, [isOpen, calendar, isCreateMode, formData.assignedUserId]);

  // Búsqueda de contactos
  useEffect(() => {
    if (searchQuery.length < 2) {
      setContacts([]);
      setShowContactDropdown(false);
      return;
    }

    const timer = setTimeout(async () => {
      setSearchingContact(true);
      try {
        const response = await fetch('/api/highlevel/contacts/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            query: searchQuery,
            limit: 10
          })
        });
        if (!response.ok) {
          throw new Error('Error al buscar contactos');
        }
        const data = await response.json();

        const formattedContacts = (data.contacts || []).map((contact: any) => ({
          id: contact.id,
          name: contact.name || 'Sin nombre',
          email: contact.email || '',
          phone: contact.phone || '',
          firstName: contact.firstName || '',
          lastName: contact.lastName || ''
        }));

        setContacts(formattedContacts);
        setShowContactDropdown(true);
      } catch (error) {
        setContacts([]);
      } finally {
        setSearchingContact(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    if (event && !isCreateMode) {
      // Modo edición/vista: obtener detalles completos de la cita
      const loadEventDetails = async () => {
        try {
          console.log('[AppointmentModal] Evento recibido:', event);
          console.log('[AppointmentModal] Event ID:', event.id);

          if (!event.id) {
            console.log('[AppointmentModal] Falta event.id, usando datos básicos');
            // Si no hay ID, usar los datos básicos del evento
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
                DEFAULT_TIMEZONE,
              contactId: (event as any)?.contactId || '',
              assignedUserId: (event as any)?.assignedUserId || ''
            });
            return;
          }

          // Obtener detalles completos de la cita (incluye contactId y assignedUserId)
          // Ya no necesita accessToken - el backend lo obtiene automáticamente
          console.log('[AppointmentModal] Llamando getAppointment con eventId:', event.id);
          const fullEvent = await calendarsService.getAppointment(event.id);
          console.log('[AppointmentModal] Respuesta de getAppointment:', fullEvent);

          if (fullEvent) {
            console.log('[AppointmentModal] Evento completo obtenido, contactId:', fullEvent.contactId, 'assignedUserId:', fullEvent.assignedUserId);
            setFormData({
              title: fullEvent.title || '',
              appointmentStatus: fullEvent.appointmentStatus || 'pending',
              startTime: toLocalInputValue(fullEvent.startTime, fullEvent.timeZone),
              endTime: toLocalInputValue(fullEvent.endTime, fullEvent.timeZone),
              notes: fullEvent.notes || '',
              address: fullEvent.address || '',
              timeZone:
                fullEvent.timeZone ||
                (fullEvent as any)?.timeZone ||
                (fullEvent as any)?.timezone ||
                DEFAULT_TIMEZONE,
              contactId: fullEvent.contactId || '',
              assignedUserId: fullEvent.assignedUserId || ''
            });

            // Si hay contactId, cargar el contacto
            if (fullEvent.contactId) {
              loadContactById(fullEvent.contactId);
            }
          } else {
            // Fallback: usar datos básicos si falla la carga completa
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
                DEFAULT_TIMEZONE,
              contactId: (event as any)?.contactId || '',
              assignedUserId: (event as any)?.assignedUserId || ''
            });
          }
        } catch (error) {
          console.error('Error al cargar detalles de la cita:', error);
          // Fallback: usar datos básicos
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
              DEFAULT_TIMEZONE,
            contactId: (event as any)?.contactId || '',
            assignedUserId: (event as any)?.assignedUserId || ''
          });
        }
      };

      loadEventDetails();
    } else if (isCreateMode && isOpen) {
      // Modo crear: usar defaults
      setFormData({
        title: defaultTitle || '',
        appointmentStatus: 'confirmed', // Estado predeterminado: Confirmada
        startTime: defaultStart ? toLocalInputValue(defaultStart, defaultTimeZone || DEFAULT_TIMEZONE) : '',
        endTime: defaultEnd ? toLocalInputValue(defaultEnd, defaultTimeZone || DEFAULT_TIMEZONE) : '',
        notes: '',
        address: '',
        timeZone: defaultTimeZone || DEFAULT_TIMEZONE,
        contactId: '',
        assignedUserId: ''
      });
      setSelectedContact(null);
      setSearchQuery('');
    } else if (!isOpen) {
      setFormData(INITIAL_FORM_STATE);
      setSelectedContact(null);
      setSearchQuery('');
    }
  }, [event, isOpen, isCreateMode, defaultStart, defaultEnd, defaultTimeZone, defaultTitle]);

  const handleSave = async () => {
    try {
      setIsSaving(true);

      if (isCreateMode) {
        // Validación: contacto es OBLIGATORIO en modo crear
        if (!formData.contactId || !selectedContact) {
          showToast('error', 'Contacto requerido', 'Debes seleccionar un contacto para crear la cita');
          setIsSaving(false);
          return;
        }

        // Validación: en Round Robin, team member es OBLIGATORIO
        const isRoundRobin = calendar?.calendarType === 'round_robin';

        if (isRoundRobin && !formData.assignedUserId) {
          showToast('error', 'Team member requerido', 'Para calendarios Round Robin debes seleccionar un team member');
          setIsSaving(false);
          return;
        }

        // Modo crear: enviar payload completo
        const payload: any = {
          title: formData.title.trim(),
          appointmentStatus: formData.appointmentStatus,
          notes: formData.notes,
          address: formData.address,
          timeZone: formData.timeZone,
          startTime: '',
          endTime: '',
          contactId: formData.contactId // SIEMPRE incluir contactId
        };

        // Agregar assignedUserId si está seleccionado
        if (formData.assignedUserId) {
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

  const handleDeleteClick = () => {
    setShowDeleteConfirm(true);
  };

  const handleConfirmDelete = async () => {
    if (!event || !onDelete) return;

    try {
      setIsSaving(true);
      await onDelete(event.id);
      setShowDeleteConfirm(false);
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
    <>
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
                onClick={handleDeleteClick}
                disabled={isSaving}
                aria-label="Eliminar cita"
              >
                <Trash2 size={18} />
              </button>
            )}
          </div>
        </div>

        <div className={styles.twoColumnLayout}>
          {/* COLUMNA IZQUIERDA: Selección de contacto y asignación */}
          <div className={styles.leftColumn}>
            <h4 className={styles.columnTitle}>
              <UserPlus size={18} />
              Asignación
            </h4>

            {/* Contacto asignado */}
            <div className={styles.sectionBlock}>
              <label className={styles.label}>
                Contacto {isCreateMode && <span className={styles.required}>*</span>}
              </label>

              {selectedContact ? (
                <div className={styles.selectedContact}>
                  <div className={styles.contactInfo}>
                    <p className={styles.contactName}>{selectedContact.name || 'Sin nombre'}</p>
                    <p className={styles.contactDetail}>{selectedContact.email || selectedContact.phone}</p>
                  </div>
                  {isCreateMode && (
                    <button
                      type="button"
                      onClick={handleClearContact}
                      className={styles.clearButton}
                      title="Cambiar contacto"
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
              ) : isCreateMode ? (
                <div className={styles.searchWrapper}>
                  <div className={styles.searchInput}>
                    <Search size={16} className={styles.searchIcon} />
                    <input
                      type="text"
                      placeholder="Buscar por nombre, email o teléfono..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className={styles.input}
                    />
                    {searchingContact && <Loader2 size={16} className={styles.loadingIcon} />}
                  </div>

                  {showContactDropdown && (
                    <div className={styles.dropdown}>
                      {contacts.length > 0 ? (
                        contacts.map((contact) => (
                          <button
                            key={contact.id}
                            type="button"
                            className={styles.dropdownItem}
                            onClick={() => handleSelectContact(contact)}
                          >
                            <p className={styles.dropdownName}>{contact.name || 'Sin nombre'}</p>
                            <p className={styles.dropdownDetail}>
                              {contact.email || contact.phone || 'Sin información de contacto'}
                            </p>
                          </button>
                        ))
                      ) : (
                        <div className={styles.dropdownEmpty}>
                          No se encontraron contactos
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <p className={styles.helpText}>Sin contacto asignado</p>
              )}
            </div>

            {/* Usuario asignado */}
            {(() => {
              const isRoundRobin = calendar?.calendarType === 'round_robin';

              console.log('🔍 Renderizando selector de usuarios:', {
                isCreateMode,
                usersLength: users.length,
                users,
                isRoundRobin,
                loadingUsers,
                assignedUserId: formData.assignedUserId,
                calendar: calendar ? {
                  id: calendar.id,
                  name: calendar.name,
                  calendarType: calendar.calendarType,
                  teamMembersCount: calendar.teamMembers?.length
                } : null
              });

              // En modo view, si hay usuario asignado, buscarlo y mostrarlo
              if (!isCreateMode && formData.assignedUserId && users.length > 0) {
                const assignedUser = users.find(u => u.id === formData.assignedUserId);
                if (assignedUser) {
                  return (
                    <div className={styles.sectionBlock}>
                      <label className={styles.label}>
                        {isRoundRobin ? 'Miembro del equipo' : 'Usuario asignado'}
                      </label>
                      <div className={styles.selectedContact}>
                        <div className={styles.contactInfo}>
                          <p className={styles.contactName}>{assignedUser.name || assignedUser.email || 'Usuario'}</p>
                          <p className={styles.contactDetail}>{assignedUser.email || ''}</p>
                        </div>
                      </div>
                    </div>
                  );
                }
              }

              // En modo crear, mostrar selector solo si hay usuarios cargados
              if (isCreateMode) {
                // Si es Round Robin y no hay usuarios, mostrar error
                if (isRoundRobin && users.length === 0 && !loadingUsers) {
                  return (
                    <div className={styles.sectionBlock}>
                      <p className={styles.helpText}>
                        ⚠️ No se pudieron cargar los usuarios. Revisa la consola.
                      </p>
                    </div>
                  );
                }

                // Si no hay usuarios cargados (calendarios normales), no mostrar nada
                if (users.length === 0) {
                  return null;
                }

                return (
                  <div className={styles.sectionBlock}>
                    <label className={styles.label} htmlFor="assignedUser">
                      {isRoundRobin ? (
                        <>
                          Elegir miembro del equipo <span className={styles.required}>*</span>
                        </>
                      ) : (
                        'Usuario asignado (opcional)'
                      )}
                    </label>

                    {isRoundRobin && (
                      <p className={styles.helpText}>
                        Este calendario usa Round Robin. Selecciona el miembro del equipo para esta cita.
                      </p>
                    )}

                    <select
                      id="assignedUser"
                      className={styles.select}
                      value={formData.assignedUserId}
                      onChange={(e) => setFormData({ ...formData, assignedUserId: e.target.value })}
                      disabled={loadingUsers}
                    >
                      <option value="">Seleccionar...</option>
                      {users.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name || user.email || `${user.firstName} ${user.lastName}`.trim()}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              }

              return null;
            })()}
          </div>

          {/* COLUMNA DERECHA: Configuración de la cita */}
          <div className={styles.rightColumn}>
            <h4 className={styles.columnTitle}>Configuración de la cita</h4>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="title">
                Título
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
                Estado
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
                <DateTimePicker
                  label="Inicio"
                  value={formData.startTime}
                  onChange={(value) => setFormData({ ...formData, startTime: value })}
                />
              </div>

              <div className={styles.field}>
                <DateTimePicker
                  label="Fin"
                  value={formData.endTime}
                  onChange={(value) => setFormData({ ...formData, endTime: value })}
                  minDate={formData.startTime}
                />
              </div>
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
                Notas
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
        </div>

        <div className={styles.actions}>
          <Button variant="primary" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Guardando...' : isCreateMode ? 'Crear cita' : 'Guardar cambios'}
          </Button>
        </div>
      </div>
    </Modal>

    {/* Modal de confirmación de eliminación */}
    {isClient && showDeleteConfirm && createPortal(
      <div className={styles.deleteModalOverlay} onClick={() => setShowDeleteConfirm(false)}>
        <div className={styles.deleteModal} onClick={(e) => e.stopPropagation()}>
          <div className={styles.deleteModalHeader}>
            <h2>¿Estás seguro?</h2>
            <button
              className={styles.closeButton}
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isSaving}
            >
              <X size={20} />
            </button>
          </div>
          <p>
            ¿Deseas eliminar la cita <strong>{formData.title || event?.title || 'Sin título'}</strong>?
            Esta acción no se puede deshacer.
          </p>
          <div className={styles.deleteModalActions}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isSaving}
            >
              Cancelar
            </Button>
            <Button
              variant="primary"
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
