import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { TabList } from '../TabList';
import { DateTimePicker } from '../DateTimePicker';
import { CustomSelect } from '../CustomSelect';
import { PhoneSelect } from '@/components/phone/PhoneSelect';
import { CalendarEvent, Calendar, calendarsService, FreeSlot, BlockedSlot } from '@/services/calendarsService';
import { useNotification } from '@/contexts/NotificationContext';
import { useTimezone } from '@/contexts/TimezoneContext';
import styles from './AppointmentModal.module.css';
import { Trash2, Search, Loader2, X, UserPlus } from 'lucide-react';

interface AppointmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  event?: CalendarEvent | null;
  calendar?: Calendar | null; // Información del calendario
  mode?: 'view' | 'create';
  defaultStart?: string;
  defaultEnd?: string;
  defaultTimeZone?: string;
  defaultTitle?: string;
  initialContact?: Partial<Contact> | null;
  defaultScheduleMode?: 'default' | 'custom'; // Modo de selección de horario al abrir
  accessToken?: string; // Token para cargar slots disponibles
  locationId?: string; // Location ID para consultas
  presentation?: 'dialog' | 'mobileSheet';
  calendars?: Calendar[];
  calendarsLoading?: boolean;
  selectedCalendarId?: string;
  onCalendarChange?: (calendarId: string) => void;
  lockInitialContact?: boolean;
  enableGuests?: boolean;
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

const normalizeAppointmentContact = (contact?: Partial<Contact> | null): Contact | null => {
  if (!contact?.id) return null;

  return {
    id: contact.id,
    name: contact.name || '',
    email: contact.email || '',
    phone: contact.phone || '',
    firstName: contact.firstName || '',
    lastName: contact.lastName || ''
  };
};

interface User {
  id: string;
  name: string;
  email: string;
  firstName?: string;
  lastName?: string;
}

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface AppointmentGuest {
  id: string;
  name: string;
  contact: string;
  contactId?: string;
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
const CONTACT_SEARCH_DELAY_MS = 90;

const createGuestId = () => `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const getContactDisplayName = (contact: Partial<Contact>) => (
  contact.name ||
  `${contact.firstName || ''} ${contact.lastName || ''}`.trim() ||
  contact.email ||
  contact.phone ||
  'Sin nombre'
);

const getContactDelivery = (contact: Partial<Contact>) => (
  contact.phone || contact.email || ''
);

/**
 * Formatea slot completo con duración
 * Ej: "2025-10-22T15:30:00-06:00" con 60min → "3:30 PM - 4:30 PM"
 */
const formatSlotWithDuration = (isoTime: string, durationMinutes: number, timeZone?: string): string => {
  const startDate = new Date(isoTime);
  const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);

  const options: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...(timeZone ? { timeZone } : {})
  };

  const startTime = startDate.toLocaleTimeString('es-MX', options).toUpperCase();
  const endTime = endDate.toLocaleTimeString('es-MX', options).toUpperCase();

  return `${startTime} - ${endTime}`;
};

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

// ¿La cadena ya trae zona explícita (Z u offset ±HH:MM)? → es un instante absoluto.
const isAbsoluteIso = (value: string): boolean => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());

/**
 * Convierte el valor del formulario a un ISO listo para guardar.
 * - Si ya es un instante absoluto (Z u offset, ej: slots de GHL o salida del
 *   DateTimePicker), se respeta tal cual y se normaliza a UTC.
 * - Si es un "datetime-local" sin zona ("YYYY-MM-DDTHH:mm"), se interpreta en
 *   la zona indicada.
 * Esto evita el doble-procesado que desfasaba la hora al editar o usar slots.
 */
const toIsoForSave = (value: string, timeZone: string): string | null => {
  if (!value) return null;
  if (isAbsoluteIso(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return convertLocalInputToISO(value, timeZone);
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
  initialContact = null,
  defaultScheduleMode = 'default',
  accessToken,
  locationId,
  presentation = 'dialog',
  calendars,
  calendarsLoading = false,
  selectedCalendarId,
  onCalendarChange,
  lockInitialContact = false,
  enableGuests = false,
  onSave,
  onDelete
}) => {
  const { showToast } = useNotification();
  const { formatLocalDateShort, timezone: accountTimezone } = useTimezone();
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState(INITIAL_FORM_STATE);
  const isCreateMode = mode === 'create';
  const [isEditingExisting, setIsEditingExisting] = useState(false);
  const isReadOnlyMode = !isCreateMode && !isEditingExisting;

  // Contact search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchingContact, setSearchingContact] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [showContactDropdown, setShowContactDropdown] = useState(false);
  const [appointmentGuests, setAppointmentGuests] = useState<AppointmentGuest[]>([]);
  const [guestSearchQuery, setGuestSearchQuery] = useState('');
  const [guestContacts, setGuestContacts] = useState<Contact[]>([]);
  const [searchingGuest, setSearchingGuest] = useState(false);
  const [showGuestDropdown, setShowGuestDropdown] = useState(false);
  const [guestsEnabled, setGuestsEnabled] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [guestContact, setGuestContact] = useState('');

  // Users (assigned users)
  const [users, setUsers] = useState<User[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isClient, setIsClient] = useState(false);

  // Modo de selección de horario: 'default' = solo slots disponibles, 'custom' = libre
  const [scheduleMode, setScheduleMode] = useState<'default' | 'custom'>(defaultScheduleMode);
  const [freeSlots, setFreeSlots] = useState<FreeSlot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedSlot, setSelectedSlot] = useState<string>('');
  const contactLocked = Boolean(lockInitialContact && initialContact?.id && isCreateMode);
  const showGuestsSection = Boolean(enableGuests && isCreateMode);
  const showContactAssignment = !contactLocked;

  useEffect(() => {
    if (isOpen && !isCreateMode) {
      setIsEditingExisting(false);
    }
  }, [event?.id, isCreateMode, isOpen]);

  // Validación de slots DESHABILITADA en modo custom: Como admin, puedes agendar en cualquier horario
  // En modo default: Solo permite seleccionar de los slots disponibles según configuración del calendario

  // Cargar slots disponibles desde la API de HighLevel
  const loadFreeSlots = async () => {
    if (!calendar?.id || scheduleMode !== 'default') {
      if (!calendar?.id) setFreeSlots([]);
      return;
    }

    setLoadingSlots(true);
    try {
      // Cargar slots para los próximos 30 días
      const today = new Date();
      const endDate = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

      const slots = await calendarsService.getFreeSlots(
        calendar.id,
        today.toISOString().split('T')[0],
        endDate.toISOString().split('T')[0],
        accessToken || undefined,
        formData.timeZone || DEFAULT_TIMEZONE
      );

      setFreeSlots(slots);
    } catch {
      showToast('error', 'Error al cargar horarios', 'No se pudieron cargar los horarios disponibles');
      setFreeSlots([]);
    } finally {
      setLoadingSlots(false);
    }
  };

  const loadUsers = async () => {
    setLoadingUsers(true);
    try {
      // Detectar si es Round Robin
      const isRoundRobin = calendar?.calendarType === 'round_robin';

      

      if (isRoundRobin && calendar?.teamMembers && calendar.teamMembers.length > 0) {
        // Para Round Robin: obtener usuarios específicos por sus IDs
        const teamMemberIds = calendar.teamMembers.map(tm => tm.userId);


        try {
          const response = await fetch('/api/highlevel/users/by-ids', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ userIds: teamMemberIds })
          });

          if (!response.ok) {
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

          

          setUsers(fetchedUsers);
        } catch (error) {
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

        const response = await fetch('/api/highlevel/users');
        if (!response.ok) throw new Error('Error al cargar usuarios');
        const data = await response.json();

        

        setUsers(data.users || []);
      }
    } catch (error) {
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
      // Error loading contact
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
    if (contactLocked) return;
    setSelectedContact(null);
    setFormData({ ...formData, contactId: '' });
    setSearchQuery('');
  };

  const handleAddGuest = (guest: Omit<AppointmentGuest, 'id'>) => {
    const name = guest.name.trim();
    const contactValue = guest.contact.trim();

    if (!name || !contactValue) {
      showToast('warning', 'Faltan datos del invitado', 'Escribe nombre completo y WhatsApp o correo.');
      return;
    }

    setAppointmentGuests((current) => {
      const normalizedContact = contactValue.toLowerCase();
      const alreadyAdded = current.some((item) => (
        (guest.contactId && item.contactId === guest.contactId) ||
        item.contact.toLowerCase() === normalizedContact
      ));

      if (alreadyAdded) return current;

      return [
        ...current,
        {
          id: createGuestId(),
          name,
          contact: contactValue,
          contactId: guest.contactId
        }
      ];
    });
    setGuestsEnabled(true);
  };

  const handleSelectGuestContact = (contact: Contact) => {
    const contactName = getContactDisplayName(contact);
    const delivery = getContactDelivery(contact);

    if (!delivery) {
      showToast('warning', 'Invitado sin contacto', 'Este contacto no tiene WhatsApp ni correo guardado.');
      return;
    }

    handleAddGuest({
      name: contactName,
      contact: delivery,
      contactId: contact.id
    });
    setGuestSearchQuery('');
    setShowGuestDropdown(false);
    setGuestContacts([]);
  };

  const handleAddManualGuest = () => {
    handleAddGuest({
      name: guestName,
      contact: guestContact
    });
    if (guestName.trim() && guestContact.trim()) {
      setGuestName('');
      setGuestContact('');
    }
  };

  const handleRemoveGuest = (guestId: string) => {
    setAppointmentGuests((current) => current.filter((guest) => guest.id !== guestId));
  };

  const handleToggleGuestsEnabled = (enabled: boolean) => {
    setGuestsEnabled(enabled);
    if (enabled) return;

    setAppointmentGuests([]);
    setGuestSearchQuery('');
    setGuestContacts([]);
    setShowGuestDropdown(false);
    setSearchingGuest(false);
    setGuestName('');
    setGuestContact('');
  };

  // VALIDACIÓN DE SLOTS ELIMINADA
  // Razón: Como admin, NO necesitas validar horarios disponibles
  // Puedes agendar citas en cualquier horario (ignoreFreeSlotValidation: true en backend)
  // La validación de slots solo aplica cuando clientes agendan vía widget público

  // Cargar usuarios SOLO cuando sea necesario (Round Robin)
  useEffect(() => {
    setIsClient(true);
  }, []);

  // Resetear scheduleMode al abrir el modal
  useEffect(() => {
    if (isOpen && isCreateMode) {
      setScheduleMode(defaultScheduleMode);
    }
  }, [isOpen, isCreateMode, defaultScheduleMode]);

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

  // Cargar slots disponibles cuando se abre el modal en modo crear y scheduleMode es 'default'
  useEffect(() => {
    if (isOpen && isCreateMode && scheduleMode === 'default') {
      loadFreeSlots();
    }
  }, [isOpen, isCreateMode, scheduleMode, calendar?.id, accessToken]);

  useEffect(() => {
    if (!isOpen || !isCreateMode) return;
    setSelectedDate('');
    setSelectedSlot('');
  }, [calendar?.id, isOpen, isCreateMode]);

  // Búsqueda de contactos
  useEffect(() => {
    const query = searchQuery.trim();

    if (query.length < 2) {
      setContacts([]);
      setShowContactDropdown(false);
      setSearchingContact(false);
      return;
    }

    const controller = new AbortController();
    setSearchingContact(true);
    setShowContactDropdown(true);

    const timer = window.setTimeout(async () => {
      setSearchingContact(true);
      try {
        const response = await fetch('/api/highlevel/contacts/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          signal: controller.signal,
          body: JSON.stringify({
            query,
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

        if (!controller.signal.aborted) {
          setContacts(formattedContacts);
          setShowContactDropdown(true);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setContacts([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setSearchingContact(false);
        }
      }
    }, CONTACT_SEARCH_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery]);

  useEffect(() => {
    if (!showGuestsSection) {
      setGuestContacts([]);
      setShowGuestDropdown(false);
      setSearchingGuest(false);
      return;
    }

    const query = guestSearchQuery.trim();

    if (query.length < 2) {
      setGuestContacts([]);
      setShowGuestDropdown(false);
      setSearchingGuest(false);
      return;
    }

    const controller = new AbortController();
    setSearchingGuest(true);
    setShowGuestDropdown(true);

    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch('/api/highlevel/contacts/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          signal: controller.signal,
          body: JSON.stringify({
            query,
            limit: 10
          })
        });

        if (!response.ok) {
          throw new Error('Error al buscar invitados');
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

        if (!controller.signal.aborted) {
          setGuestContacts(formattedContacts);
          setShowGuestDropdown(true);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setGuestContacts([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setSearchingGuest(false);
        }
      }
    }, CONTACT_SEARCH_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [guestSearchQuery, showGuestsSection]);

  // Validar slot cuando cambien las fechas (solo en modo crear)
  // useEffect de validación de slots ELIMINADO
  // Ya no necesitamos validar horarios disponibles como admin

  useEffect(() => {
    if (event && !isCreateMode) {
      // Modo edición/vista: obtener detalles completos de la cita
      const loadEventDetails = async () => {
        try {

          if (!event.id) {
            // Si no hay ID, usar los datos básicos del evento
            setFormData({
              title: event.title || '',
              appointmentStatus: event.appointmentStatus || 'pending',
              startTime: toLocalInputValue(event.startTime, event.timeZone || accountTimezone),
              endTime: toLocalInputValue(event.endTime, event.timeZone || accountTimezone),
              notes: event.notes || '',
              address: event.address || '',
              timeZone:
                event.timeZone ||
                (event as any)?.timeZone ||
                (event as any)?.timezone ||
                accountTimezone,
              contactId: (event as any)?.contactId || '',
              assignedUserId: (event as any)?.assignedUserId || ''
            });
            return;
          }

          // Obtener detalles completos de la cita (incluye contactId y assignedUserId)
          // Ya no necesita accessToken - el backend lo obtiene automáticamente
          const fullEvent = await calendarsService.getAppointment(event.id);

          if (fullEvent) {
            setFormData({
              title: fullEvent.title || '',
              appointmentStatus: fullEvent.appointmentStatus || 'pending',
              startTime: toLocalInputValue(fullEvent.startTime, fullEvent.timeZone || accountTimezone),
              endTime: toLocalInputValue(fullEvent.endTime, fullEvent.timeZone || accountTimezone),
              notes: fullEvent.notes || '',
              address: fullEvent.address || '',
              timeZone:
                fullEvent.timeZone ||
                (fullEvent as any)?.timeZone ||
                (fullEvent as any)?.timezone ||
                accountTimezone,
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
              startTime: toLocalInputValue(event.startTime, event.timeZone || accountTimezone),
              endTime: toLocalInputValue(event.endTime, event.timeZone || accountTimezone),
              notes: event.notes || '',
              address: event.address || '',
              timeZone:
                event.timeZone ||
                (event as any)?.timeZone ||
                (event as any)?.timezone ||
                accountTimezone,
              contactId: (event as any)?.contactId || '',
              assignedUserId: (event as any)?.assignedUserId || ''
            });
          }
        } catch (error) {
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
      const resolvedInitialContact = normalizeAppointmentContact(initialContact);
      const initialContactName = resolvedInitialContact
        ? resolvedInitialContact.name ||
          `${resolvedInitialContact.firstName || ''} ${resolvedInitialContact.lastName || ''}`.trim() ||
          resolvedInitialContact.email ||
          resolvedInitialContact.phone
        : '';

      setFormData({
        title: defaultTitle || initialContactName || '',
        appointmentStatus: 'confirmed', // Estado predeterminado: Confirmada
        startTime: defaultStart ? toLocalInputValue(defaultStart, defaultTimeZone || accountTimezone) : '',
        endTime: defaultEnd ? toLocalInputValue(defaultEnd, defaultTimeZone || accountTimezone) : '',
        notes: '',
        address: '',
        timeZone: defaultTimeZone || accountTimezone,
        contactId: resolvedInitialContact?.id || '',
        assignedUserId: ''
      });
      setSelectedContact(resolvedInitialContact);
      setSearchQuery('');
      setAppointmentGuests([]);
      setGuestsEnabled(false);
      setGuestSearchQuery('');
      setGuestContacts([]);
      setShowGuestDropdown(false);
      setGuestName('');
      setGuestContact('');
    } else if (!isOpen) {
      setFormData(INITIAL_FORM_STATE);
      setSelectedContact(null);
      setSearchQuery('');
      setAppointmentGuests([]);
      setGuestsEnabled(false);
      setGuestSearchQuery('');
      setGuestContacts([]);
      setShowGuestDropdown(false);
      setGuestName('');
      setGuestContact('');
    }
  }, [event, isOpen, isCreateMode, defaultStart, defaultEnd, defaultTimeZone, defaultTitle, initialContact?.id, initialContact?.email, initialContact?.phone, initialContact?.name]);

  /**
   * Verificar si el horario seleccionado está bloqueado
   */
  const checkIfTimeIsBlocked = async (startTime: string, endTime: string): Promise<BlockedSlot | null> => {
    if (!calendar || !accessToken || !locationId) return null;

    try {
      // Fecha/hora en la ZONA DE LA CUENTA (los blocked slots vienen en esa zona)
      const startDate = new Date(startTime);
      const zonedStart = toDateInTimeZone(startTime, accountTimezone) ?? startDate;
      const zonedEnd = toDateInTimeZone(endTime, accountTimezone) ?? new Date(endTime);
      const dateKey = `${zonedStart.getFullYear()}-${String(zonedStart.getMonth() + 1).padStart(2, '0')}-${String(zonedStart.getDate()).padStart(2, '0')}`;
      const startTimeStr = `${String(zonedStart.getHours()).padStart(2, '0')}:${String(zonedStart.getMinutes()).padStart(2, '0')}`;
      const endTimeStr = `${String(zonedEnd.getHours()).padStart(2, '0')}:${String(zonedEnd.getMinutes()).padStart(2, '0')}`;

      // Obtener blocked slots del día
      const dayStart = new Date(startDate);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(startDate);
      dayEnd.setHours(23, 59, 59, 999);

      const blockedSlots = await calendarsService.getBlockedSlots(
        calendar.id,
        locationId,
        dayStart.getTime(),
        dayEnd.getTime(),
        accessToken
      );

      // Verificar si hay conflicto con algún blocked slot
      for (const slot of blockedSlots) {
        if (slot.date !== dateKey) continue;

        // Comparar horarios (formato "HH:mm")
        const slotStart = slot.startTime;
        const slotEnd = slot.endTime;

        // Verificar si hay solapamiento
        // El evento está bloqueado si:
        // - Empieza antes del fin del slot Y termina después del inicio del slot
        if (startTimeStr < slotEnd && endTimeStr > slotStart) {
          return slot; // Hay conflicto
        }
      }

      return null; // No hay conflicto
    } catch (error) {
      // Si hay error al cargar blocked slots, permitir la creación (silencioso)
      return null;
    }
  };

  const handleSave = async () => {
    try {
      setIsSaving(true);

      if (isCreateMode) {
        if (!calendar?.id) {
          showToast('warning', 'Elige un calendario', 'Selecciona dónde quieres guardar la cita.');
          setIsSaving(false);
          return;
        }

        // Validación: contacto es OBLIGATORIO en modo crear
        if (!formData.contactId || !selectedContact) {
          showToast('error', 'Contacto requerido', 'Debes seleccionar un contacto para crear la cita');
          setIsSaving(false);
          return;
        }

        // Validación: en calendarios que reparten citas, debe elegirse quién atiende.
        const isRoundRobin = calendar?.calendarType === 'round_robin';

        if (isRoundRobin && !formData.assignedUserId && !contactLocked) {
          showToast('error', 'Persona del equipo requerida', 'Selecciona quién atenderá esta cita.');
          setIsSaving(false);
          return;
        }

        // Validación: verificar si el horario está bloqueado
        if (formData.startTime && formData.endTime) {
          const startIso = toIsoForSave(formData.startTime, formData.timeZone);
          const endIso = toIsoForSave(formData.endTime, formData.timeZone);

          if (startIso && endIso) {
            const blockedSlot = await checkIfTimeIsBlocked(startIso, endIso);
            if (blockedSlot) {
              showToast(
                'error',
                'Horario bloqueado',
                `Este horario no está disponible. ${blockedSlot.reason ? `Razón: ${blockedSlot.reason}` : 'Por favor selecciona otro horario.'}`
              );
              setIsSaving(false);
              return;
            }
          }
        }

        // Modo crear: enviar payload completo
        const guestsNotes = appointmentGuests.length > 0
          ? `Invitados:\n${appointmentGuests.map((guest) => `- ${guest.name}: ${guest.contact}`).join('\n')}`
          : '';
        const notesWithGuests = [formData.notes.trim(), guestsNotes].filter(Boolean).join('\n\n');

        const payload: any = {
          title: formData.title.trim(),
          appointmentStatus: formData.appointmentStatus,
          notes: notesWithGuests,
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
          const startIso = toIsoForSave(formData.startTime, formData.timeZone);
          if (startIso) payload.startTime = startIso;
        }

        if (formData.endTime) {
          const endIso = toIsoForSave(formData.endTime, formData.timeZone);
          if (endIso) payload.endTime = endIso;
        }

        await onSave(payload);
      } else {
        // Modo editar: enviar updates con eventId
        if (!event) return;

        // Validación: verificar si el horario está bloqueado (solo si se cambió el horario)
        if (formData.startTime && formData.endTime) {
          const startIso = toIsoForSave(formData.startTime, formData.timeZone);
          const endIso = toIsoForSave(formData.endTime, formData.timeZone);

          if (startIso && endIso) {
            // Solo validar si el horario cambió respecto al original
            const originalStart = event.startTime;
            const originalEnd = event.endTime;

            if (startIso !== originalStart || endIso !== originalEnd) {
              const blockedSlot = await checkIfTimeIsBlocked(startIso, endIso);
              if (blockedSlot) {
                showToast(
                  'error',
                  'Horario bloqueado',
                  `Este horario no está disponible. ${blockedSlot.reason ? `Razón: ${blockedSlot.reason}` : 'Por favor selecciona otro horario.'}`
                );
                setIsSaving(false);
                return;
              }
            }
          }
        }

        const updates: Partial<CalendarEvent> = {
          title: formData.title.trim(),
          appointmentStatus: formData.appointmentStatus,
          notes: formData.notes,
          address: formData.address,
          timeZone: formData.timeZone
        };

        if (formData.startTime) {
          const startIso = toIsoForSave(formData.startTime, formData.timeZone);
          if (startIso) updates.startTime = startIso;
        }

        if (formData.endTime) {
          const endIso = toIsoForSave(formData.endTime, formData.timeZone);
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
  const showCalendarPicker = isCreateMode && Boolean(calendars || calendarsLoading);
  const selectedTimeZone =
    formData.timeZone ||
    event?.timeZone ||
    (event as any)?.timeZone ||
    (event as any)?.timezone ||
    accountTimezone;

  const timeFormatter = new Intl.DateTimeFormat('es-MX', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: selectedTimeZone
  });

  const dateLabel = startDate ? formatLocalDateShort(startDate) : 'Sin fecha asignada';
  const timeLabel = startDate && endDate
    ? `${timeFormatter.format(startDate)} – ${timeFormatter.format(endDate)}`
    : 'Horario no definido';

  const timeZoneShort = new Intl.DateTimeFormat('es-MX', { timeZone: selectedTimeZone, timeZoneName: 'short' })
    .formatToParts(startDate ?? new Date())
    .find((part) => part.type === 'timeZoneName')?.value ?? selectedTimeZone;
  const isMobileSheet = presentation === 'mobileSheet';
  const showAppointmentSummary = !(isMobileSheet && isCreateMode);
  const modalTitle = isMobileSheet
    ? isCreateMode
      ? 'Nueva cita'
      : isReadOnlyMode
        ? 'Detalle de cita'
        : 'Editar cita'
    : '';
  const assignedUser = formData.assignedUserId
    ? users.find((user) => user.id === formData.assignedUserId)
    : null;
  const assignedUserLabel = assignedUser
    ? assignedUser.name || assignedUser.email || `${assignedUser.firstName || ''} ${assignedUser.lastName || ''}`.trim()
    : formData.assignedUserId
      ? 'Persona asignada'
      : 'Sin asignar';
  const contactName = selectedContact ? getContactDisplayName(selectedContact) : '';
  const contactDelivery = selectedContact ? getContactDelivery(selectedContact) : '';
  const addressLabel = formData.address.trim() || 'Sin ubicación';
  const notesLabel = formData.notes.trim() || 'Sin notas';
  const calendarOptions: SelectOption[] = calendarsLoading
    ? [{ value: '', label: 'Cargando calendarios...' }]
    : !calendars?.length
      ? [{ value: '', label: 'No hay calendarios disponibles' }]
      : calendars.map((item) => ({ value: item.id, label: item.name }));
  const assignedUserOptions: SelectOption[] = [
    { value: '', label: 'Seleccionar...' },
    ...users.map((user) => ({
      value: user.id,
      label: user.name || user.email || `${user.firstName} ${user.lastName}`.trim()
    }))
  ];
  const statusOptions: SelectOption[] = STATUS_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label
  }));
  const timeZoneOptions: SelectOption[] = ALL_TIMEZONES.map((tz) => ({ value: tz, label: tz }));
  const renderSelect = ({
    title,
    value,
    options,
    onChange,
    disabled = false,
    placeholder
  }: {
    title: string;
    value: string;
    options: SelectOption[];
    onChange: (value: string) => void;
    disabled?: boolean;
    placeholder?: string;
  }) => (
    isMobileSheet ? (
      <PhoneSelect
        value={value}
        onChange={onChange}
        options={options}
        title={title}
        placeholder={placeholder || title}
        disabled={disabled}
        buttonClassName={styles.mobilePhoneSelectButton}
      />
    ) : (
      <CustomSelect
        value={value}
        onValueChange={onChange}
        options={options.filter((option) => !option.disabled)}
        placeholder={placeholder || title}
        disabled={disabled}
        className={styles.customSelectControl}
        portal
      />
    )
  );
  const handleTimeZoneChange = (newZone: string) => {
    setFormData((prev) => {
      const startIso = prev.startTime
        ? toIsoForSave(prev.startTime, prev.timeZone) ?? ''
        : '';
      const endIso = prev.endTime
        ? toIsoForSave(prev.endTime, prev.timeZone) ?? ''
        : '';

      return {
        ...prev,
        timeZone: newZone,
        startTime: startIso ? toLocalInputValue(startIso, newZone) : '',
        endTime: endIso ? toLocalInputValue(endIso, newZone) : ''
      };
    });
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={modalTitle}
        size="lg"
        className={isMobileSheet ? styles.mobileSheetModal : undefined}
        backdropClassName={isMobileSheet ? styles.mobileSheetBackdrop : undefined}
        contentClassName={isMobileSheet ? styles.mobileSheetContent : undefined}
        showCloseButton={!isMobileSheet}
        draggableSheet={isMobileSheet}
      >
        <div
          className={`${styles.container} ${isMobileSheet ? styles.mobileSheetContainer : ''}`}
          data-phone-scrollable={isMobileSheet ? 'true' : undefined}
        >
        {showCalendarPicker && (
          <div className={styles.field}>
            <label className={styles.label}>
              Calendario <span className={styles.required}>*</span>
            </label>
            {renderSelect({
              title: 'Calendario',
              value: selectedCalendarId ?? calendar?.id ?? '',
              options: calendarOptions,
              onChange: (value) => onCalendarChange?.(value),
              disabled: calendarsLoading || !calendars?.length,
              placeholder: 'Elige calendario'
            })}
            <p className={styles.helpText}>Elige dónde quieres guardar esta cita.</p>
          </div>
        )}

        {showAppointmentSummary && (
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
        )}

        {isReadOnlyMode ? (
          <section className={styles.detailSummary} aria-label="Resumen de la cita">
            <div className={styles.detailSummaryGrid}>
              <article className={styles.detailSummaryItem}>
                <span>Horario</span>
                <strong>{dateLabel}</strong>
                <p>{timeLabel}</p>
              </article>

              <article className={styles.detailSummaryItem}>
                <span>Contacto</span>
                <strong>{contactName || 'Sin contacto asignado'}</strong>
                {contactDelivery && <p>{contactDelivery}</p>}
              </article>

              <article className={styles.detailSummaryItem}>
                <span>Calendario</span>
                <strong>{calendar?.name || 'Sin calendario'}</strong>
                <p>{selectedTimeZone}</p>
              </article>

              <article className={styles.detailSummaryItem}>
                <span>Asignación</span>
                <strong>{loadingUsers ? 'Cargando...' : assignedUserLabel}</strong>
              </article>
            </div>

            <div className={styles.detailSummaryBlock}>
              <span>Ubicación</span>
              <p>{addressLabel}</p>
            </div>

            <div className={styles.detailSummaryBlock}>
              <span>Notas</span>
              <p>{notesLabel}</p>
            </div>
          </section>
        ) : (
		        <div className={styles.twoColumnLayout}>
	          {/* COLUMNA IZQUIERDA: Contacto o invitados */}
	          <div className={styles.leftColumn}>
	            <h4 className={styles.columnTitle}>
	              <UserPlus size={18} />
	              {showGuestsSection ? 'Invitados' : 'Asignación'}
	            </h4>

	            {/* Contacto asignado */}
	            {showContactAssignment && (
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
                      placeholder="Buscar por nombre, correo o teléfono..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className={styles.input}
                    />
                    {searchingContact && <Loader2 size={16} className={styles.loadingIcon} />}
                  </div>

                  {showContactDropdown && (
                    <div className={styles.dropdown} data-ristak-dropdown-panel>
                      {searchingContact && contacts.length === 0 ? (
                        <div className={styles.dropdownEmpty}>
                          Buscando contactos...
                        </div>
                      ) : contacts.length > 0 ? (
                        contacts.map((contact) => (
                          <button
                            key={contact.id}
                            type="button"
                            className={styles.dropdownItem}
                            data-ristak-dropdown-item
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
	            )}

	            {showGuestsSection && (
	              <div className={`${styles.sectionBlock} ${styles.guestsSectionCompact}`}>
	                <div className={styles.guestToggleHeader}>
	                  <div>
	                    <label className={styles.label}>¿Agregar invitados?</label>
	                    {appointmentGuests.length > 0 && (
	                      <p className={styles.helpText}>{appointmentGuests.length} agregado{appointmentGuests.length === 1 ? '' : 's'}</p>
	                    )}
	                  </div>
	                  <div className={styles.guestToggleChips} role="group" aria-label="Agregar invitados">
	                    <button
	                      type="button"
	                      className={guestsEnabled ? styles.guestToggleChipActive : ''}
	                      onClick={() => handleToggleGuestsEnabled(true)}
	                      aria-pressed={guestsEnabled}
	                    >
	                      Sí
	                    </button>
	                    <button
	                      type="button"
	                      className={!guestsEnabled ? styles.guestToggleChipActive : ''}
	                      onClick={() => handleToggleGuestsEnabled(false)}
	                      aria-pressed={!guestsEnabled}
	                    >
	                      No
	                    </button>
	                  </div>
	                </div>

	                {guestsEnabled && (
	                  <>
	                    <p className={styles.helpText}>Busca un contacto guardado o agrega uno nuevo para esta cita.</p>

	                    <div className={styles.searchWrapper}>
	                      <div className={styles.searchInput}>
	                        <Search size={16} className={styles.searchIcon} />
	                        <input
	                          type="text"
	                          placeholder="Buscar en contactos..."
	                          value={guestSearchQuery}
	                          onChange={(e) => setGuestSearchQuery(e.target.value)}
	                          className={styles.input}
	                        />
	                        {searchingGuest && <Loader2 size={16} className={styles.loadingIcon} />}
	                      </div>

	                      {showGuestDropdown && (
		                        <div className={styles.dropdown} data-ristak-dropdown-panel>
	                          {searchingGuest && guestContacts.length === 0 ? (
	                            <div className={styles.dropdownEmpty}>
	                              Buscando invitados...
	                            </div>
	                          ) : guestContacts.length > 0 ? (
	                            guestContacts.map((contact) => (
	                              <button
	                                key={contact.id}
		                                type="button"
		                                className={styles.dropdownItem}
		                                data-ristak-dropdown-item
		                                onClick={() => handleSelectGuestContact(contact)}
	                              >
	                                <p className={styles.dropdownName}>{getContactDisplayName(contact)}</p>
	                                <p className={styles.dropdownDetail}>
	                                  {getContactDelivery(contact) || 'Sin WhatsApp ni correo'}
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

	                    <div className={styles.guestBuilder}>
	                      <div className={styles.field}>
	                        <label className={styles.label} htmlFor="guestName">
	                          Nombre completo <span className={styles.required}>*</span>
	                        </label>
	                        <input
	                          id="guestName"
	                          type="text"
	                          className={styles.input}
	                          value={guestName}
	                          placeholder="Ej. Ana López"
	                          onChange={(event) => setGuestName(event.target.value)}
	                        />
	                      </div>

	                      <div className={styles.field}>
	                        <label className={styles.label} htmlFor="guestContact">
	                          Num Whats o correo <span className={styles.required}>*</span>
	                        </label>
	                        <input
	                          id="guestContact"
	                          type="text"
	                          className={styles.input}
	                          value={guestContact}
	                          placeholder="Ej. +52 656 000 0000 o correo@dominio.com"
	                          onChange={(event) => setGuestContact(event.target.value)}
	                        />
	                      </div>

	                      <button type="button" className={styles.guestAddButton} onClick={handleAddManualGuest}>
	                        Agregar invitado
	                      </button>
	                    </div>

	                    {appointmentGuests.length > 0 ? (
	                      <div className={styles.guestList} aria-label="Invitados agregados">
	                        {appointmentGuests.map((guest) => (
	                          <div key={guest.id} className={styles.guestItem}>
	                            <span>
	                              <strong>{guest.name}</strong>
	                              <small>{guest.contact}</small>
	                            </span>
	                            <button type="button" onClick={() => handleRemoveGuest(guest.id)} aria-label={`Quitar ${guest.name}`}>
	                              <X size={15} />
	                            </button>
	                          </div>
	                        ))}
	                      </div>
	                    ) : (
	                      <p className={styles.helpText}>Todavía no agregas invitados.</p>
	                    )}
	                  </>
	                )}
	              </div>
	            )}

	            {/* Usuario asignado */}
	            {showContactAssignment && (() => {
              const isRoundRobin = calendar?.calendarType === 'round_robin';

              // En modo view, si hay usuario asignado, buscarlo y mostrarlo
              if (!isCreateMode && formData.assignedUserId && users.length > 0) {
                const assignedUser = users.find(u => u.id === formData.assignedUserId);
                if (assignedUser) {
                  return (
                    <div className={styles.sectionBlock}>
                      <label className={styles.label}>
                        {isRoundRobin ? 'Miembro del equipo' : 'Persona asignada'}
                      </label>
                      <div className={styles.selectedContact}>
                        <div className={styles.contactInfo}>
                          <p className={styles.contactName}>{assignedUser.name || assignedUser.email || 'Persona'}</p>
                          <p className={styles.contactDetail}>{assignedUser.email || ''}</p>
                        </div>
                      </div>
                    </div>
                  );
                }
              }

              // En modo crear, mostrar selector solo si hay usuarios cargados
              if (isCreateMode) {
                // Si reparte citas entre el equipo y no hay usuarios, mostrar error
                if (isRoundRobin && users.length === 0 && !loadingUsers) {
                  return (
                    <div className={styles.sectionBlock}>
                      <p className={styles.helpText}>
                        No pudimos cargar al equipo. Cierra esta ventana y vuelve a intentar.
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
                    <label className={styles.label}>
                      {isRoundRobin ? (
                        <>
                          Elegir miembro del equipo <span className={styles.required}>*</span>
                        </>
                      ) : (
                        'Persona asignada (opcional)'
                      )}
                    </label>

                    {isRoundRobin && (
                      <p className={styles.helpText}>
                        Este calendario reparte citas entre el equipo. Selecciona quién atenderá esta cita.
                      </p>
                    )}

                    {renderSelect({
                      title: 'Persona asignada',
                      value: formData.assignedUserId,
                      options: assignedUserOptions,
                      onChange: (value) => setFormData({ ...formData, assignedUserId: value }),
                      disabled: loadingUsers,
                      placeholder: 'Seleccionar...'
                    })}
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
              <label className={styles.label}>
                Estado
              </label>
              {renderSelect({
                title: 'Estado',
                value: formData.appointmentStatus,
                options: statusOptions,
                onChange: (value) =>
                  setFormData({ ...formData, appointmentStatus: value as CalendarEvent['appointmentStatus'] })
              })}
            </div>

            {/* Sección de Fecha y Hora (solo en modo crear) */}
            {isCreateMode && (
              <div className={styles.field}>
                <label className={styles.label}>
                  Fecha y hora <span className={styles.required}>*</span>
                </label>

                {/* Contenedor visual para TabList + Selectores */}
                <div className={styles.dateTimeSection}>
                  {/* TabList para seleccionar modo */}
                  <div className={styles.tabListWrapper}>
                    <TabList
                      tabs={[
                        {
                          value: 'default',
                          label: 'Por defecto',
                          description: 'Usa el horario sugerido por la disponibilidad del calendario.'
                        },
                        {
                          value: 'custom',
                          label: 'Personalizado',
                          description: 'Te deja escoger una fecha y hora exactas para esta cita.'
                        }
                      ]}
                      activeTab={scheduleMode}
                      onTabChange={(value) => setScheduleMode(value as 'default' | 'custom')}
                    />
                  </div>

                  {/* Modo Por defecto: Selector de slots disponibles */}
                  {scheduleMode === 'default' ? (
                    <div className={styles.slotsContent}>
                      {loadingSlots ? (
                        <div className={styles.loadingSlots}>
                          <Loader2 size={20} className={styles.spinner} />
                          <span>Cargando horarios disponibles...</span>
                        </div>
                      ) : freeSlots.length === 0 ? (
                        <div className={styles.noSlots}>
                          <p>No hay horarios disponibles en los próximos 30 días.</p>
                          <p className={styles.helpText}>Intenta con el modo Personalizado.</p>
                        </div>
                      ) : (
                        /* Grid de 2 columnas: Fecha | Horario */
                        <div className={styles.fieldRow}>
                          {/* Selector de fecha */}
                          <div className={styles.field}>
                            <label className={styles.label}>
                              Fecha <span className={styles.required}>*</span>
                            </label>
                            <CustomSelect
                              options={[
                                { value: '', label: 'Seleccionar fecha...' },
                                ...freeSlots.map((slot) => ({
                                  value: slot.date,
                                  label: new Date(`${slot.date}T00:00:00Z`).toLocaleDateString('es-MX', {
                                    weekday: 'long',
                                    year: 'numeric',
                                    month: 'long',
                                    day: 'numeric',
                                    timeZone: 'UTC'
                                  })
                                }))
                              ]}
                              value={selectedDate}
                              onValueChange={(value) => {
                                setSelectedDate(value);
                                setSelectedSlot(''); // Reset slot cuando cambia la fecha
                              }}
                              placeholder="Seleccionar fecha..."
                            />
                          </div>

                          {/* Selector de horario */}
                          <div className={styles.field}>
                            <label className={styles.label}>
                              Horario <span className={styles.required}>*</span>
                            </label>
                            <CustomSelect
                              options={
                                selectedDate
                                  ? [
                                      { value: '', label: 'Seleccionar horario...' },
                                      ...(freeSlots
                                        .find((s) => s.date === selectedDate)
                                        ?.slots.map((timeSlot) => ({
                                          value: timeSlot,
                                          label: formatSlotWithDuration(timeSlot, calendar?.slotDuration || 60, accountTimezone)
                                        })) || [])
                                    ]
                                  : [{ value: '', label: 'Primero selecciona una fecha' }]
                              }
                              value={selectedSlot}
                              onValueChange={(value) => {
                                setSelectedSlot(value);

                                // Construir startTime y endTime en ISO format
                                if (value) {
                                  const startDate = new Date(value);
                                  const duration = calendar?.slotDuration || 60;
                                  const endDate = new Date(startDate.getTime() + duration * 60 * 1000);

                                  setFormData({
                                    ...formData,
                                    startTime: startDate.toISOString(),
                                    endTime: endDate.toISOString()
                                  });
                                }
                              }}
                              disabled={!selectedDate}
                              placeholder={!selectedDate ? 'Primero selecciona una fecha' : 'Seleccionar horario...'}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    /* Modo Personalizado: DateTimePicker libre */
                    <div className={styles.slotsContent}>
                      <div className={styles.fieldRow}>
                        <div className={styles.field}>
                          <DateTimePicker
                            label="Inicio"
                            value={formData.startTime}
                            onChange={(value) => {
                              // Cuando cambia el startTime, actualizar automáticamente el endTime
                              // según la duración configurada del calendario (slotDuration)
                              const duration = calendar?.slotDuration || 60; // Default 60 minutos
                              const startDate = new Date(value);
                              const endDate = new Date(startDate.getTime() + duration * 60 * 1000);

                              setFormData({
                                ...formData,
                                startTime: value,
                                endTime: endDate.toISOString()
                              });
                            }}
                          />
                        </div>

                        <div className={styles.field}>
                          <DateTimePicker
                            label="Fin"
                            value={formData.endTime}
                            onChange={(value) => {
                              // Cuando el usuario cambia manualmente el endTime, NO tocamos startTime
                              setFormData({ ...formData, endTime: value });
                            }}
                            minDate={formData.startTime}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Modo View: mostrar campos de fecha/hora normales (fuera de la sección) */}
            {!isCreateMode && (
              <div className={styles.fieldRow}>
                <div className={styles.field}>
                  <DateTimePicker
                    label="Inicio"
                    value={formData.startTime}
                    onChange={(value) => {
                      const duration = calendar?.slotDuration || 60;
                      const startDate = new Date(value);
                      const endDate = new Date(startDate.getTime() + duration * 60 * 1000);

                      setFormData({
                        ...formData,
                        startTime: value,
                        endTime: endDate.toISOString()
                      });
                    }}
                  />
                </div>

                <div className={styles.field}>
                  <DateTimePicker
                    label="Fin"
                    value={formData.endTime}
                    onChange={(value) => {
                      setFormData({ ...formData, endTime: value });
                    }}
                    minDate={formData.startTime}
                  />
                </div>
              </div>
            )}

            {/* Validación de slots ELIMINADA - Como admin, puedes agendar en cualquier horario */}

            <div className={styles.field}>
              <label className={styles.label}>
                Zona horaria
              </label>
              {renderSelect({
                title: 'Zona horaria',
                value: formData.timeZone,
                options: timeZoneOptions,
                onChange: handleTimeZoneChange
              })}
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
        )}

        {isReadOnlyMode ? (
          <div className={`${styles.actions} ${styles.viewActions}`}>
            <Button
              variant="primary"
              onClick={() => setIsEditingExisting(true)}
              disabled={isSaving}
            >
              Editar cita
            </Button>
          </div>
        ) : (
          <div className={styles.actions}>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving ? 'Guardando...' : isCreateMode ? 'Crear cita' : 'Guardar cambios'}
            </Button>
          </div>
        )}
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
