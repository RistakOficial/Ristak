import type { CalendarFreeSlot } from './types';

export type CalendarSlotSelection = {
  calendarId: string;
  groupDate: string;
  dateOnly: string;
  slot: string;
};

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
