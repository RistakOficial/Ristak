import type { CalendarFreeSlot } from './types';

export type CalendarSlotSelection = {
  calendarId: string;
  groupDate: string;
  dateOnly: string;
  slot: string;
};

type AppointmentAvailabilityRequestInput = {
  formMode: 'create' | 'edit';
  scheduleMode: 'default' | 'custom';
};

type AppointmentAvailabilityRequestFields = {
  strictAvailabilityCheck?: true;
  ignoreAppointmentConflicts?: true;
};

/**
 * Keeps the server-side availability lock attached to appointments created
 * from a published free slot. A custom create is an explicit manual override,
 * so it asks the server to allow overlapping another appointment. Edits keep
 * their existing contract and do not inherit either create-only flag.
 */
export function getAppointmentAvailabilityRequestFields({
  formMode,
  scheduleMode,
}: AppointmentAvailabilityRequestInput): AppointmentAvailabilityRequestFields {
  if (formMode !== 'create') return {};

  return scheduleMode === 'default'
    ? { strictAvailabilityCheck: true }
    : { ignoreAppointmentConflicts: true };
}

type CurrentCalendarSlotSelectionInput = {
  calendarId: string;
  dateOnly: string;
  freeSlots: CalendarFreeSlot[];
  selection: CalendarSlotSelection | null;
};

function clean(value: unknown) {
  return String(value || '').trim();
}

/**
 * Prevents a slot loaded for a previous calendar/date from being submitted
 * after the appointment form has already moved to another scheduling context.
 */
export function isCurrentCalendarSlotSelection({
  calendarId,
  dateOnly,
  freeSlots,
  selection,
}: CurrentCalendarSlotSelectionInput) {
  const currentCalendarId = clean(calendarId);
  const currentDateOnly = clean(dateOnly);
  if (!selection || !currentCalendarId || !currentDateOnly) return false;

  const selectedCalendarId = clean(selection.calendarId);
  const selectedGroupDate = clean(selection.groupDate);
  const selectedDateOnly = clean(selection.dateOnly);
  const selectedSlot = clean(selection.slot);
  if (
    !selectedSlot
    || selectedCalendarId !== currentCalendarId
    || selectedGroupDate !== currentDateOnly
    || selectedDateOnly !== currentDateOnly
  ) {
    return false;
  }

  const currentGroup = freeSlots.find((group) => clean(group.date) === currentDateOnly);
  return Boolean(currentGroup?.slots?.some((slot) => clean(slot) === selectedSlot));
}
