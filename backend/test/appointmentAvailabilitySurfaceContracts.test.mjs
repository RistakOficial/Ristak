import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readRepositoryFile(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function extractBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `No se encontró el inicio: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `No se encontró el final: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('las superficies frontend conservan el contrato estricto o personalizado emitido por AppointmentModal', () => {
  const service = readRepositoryFile('frontend/src/services/calendarsService.ts');
  const modal = readRepositoryFile('frontend/src/components/common/AppointmentModal/AppointmentModal.tsx');
  const appointments = readRepositoryFile('frontend/src/pages/Appointments/Appointments.tsx');
  const phoneCalendar = readRepositoryFile('frontend/src/pages/PhoneCalendar/PhoneCalendar.tsx');
  const phoneChat = readRepositoryFile('frontend/src/pages/PhoneChat/PhoneChat.tsx');
  const desktopChat = readRepositoryFile('frontend/src/pages/DesktopChat/DesktopChat.tsx');

  assert.match(service, /strictAvailabilityCheck\?: true;/);
  assert.match(service, /ignoreAppointmentConflicts\?: true;/);
  assert.equal((modal.match(/payload\.strictAvailabilityCheck = true/g) || []).length, 1);
  assert.equal((modal.match(/payload\.ignoreAppointmentConflicts = true/g) || []).length, 1);
  assert.match(
    modal,
    /if \(scheduleMode === 'default'\) \{\s*payload\.strictAvailabilityCheck = true;\s*\} else \{\s*payload\.ignoreAppointmentConflicts = true;/
  );

  assert.match(appointments, /strictAvailabilityCheck\?: true;[\s\S]*?ignoreAppointmentConflicts\?: true;[\s\S]*?calendarsService\.createAppointment\([\s\S]*?\.\.\.payload/);
  assert.match(phoneCalendar, /strictAvailabilityCheck\?: true[\s\S]*?ignoreAppointmentConflicts\?: true[\s\S]*?const appointmentData = \{[\s\S]*?\.\.\.payload/);
  assert.match(phoneChat, /strictAvailabilityCheck\?: true[\s\S]*?ignoreAppointmentConflicts\?: true[\s\S]*?const appointmentData = \{[\s\S]*?\.\.\.payload/);
  assert.match(
    desktopChat,
    /eventIdOrPayload: string \| CreateAppointmentPayload[\s\S]*?const calendarId = [\s\S]*?selectedCalendar\?\.id[\s\S]*?calendarsService\.createAppointment\(\{\s*\.\.\.eventIdOrPayload,\s*calendarId/
  );

  for (const source of [phoneCalendar, phoneChat, desktopChat]) {
    assert.match(source, /defaultScheduleMode="custom"/);
  }
});

test('los atajos vivos de captura manual conservan calendario y override explícitos', () => {
  const phoneChat = readRepositoryFile('frontend/src/pages/PhoneChat/PhoneChat.tsx');
  const mobileApp = readRepositoryFile('mobile/src/App.tsx');

  const phoneChatManualCalendar = extractBetween(
    phoneChat,
    'const handleSubmitAppointmentCalendar = async () => {',
    '\n  useEffect(() => {'
  );
  assert.doesNotMatch(phoneChatManualCalendar, /strictAvailabilityCheck\s*:/);
  assert.match(phoneChatManualCalendar, /ignoreAppointmentConflicts\s*:\s*true/);

  const mobileCreateFlow = extractBetween(
    mobileApp,
    'const openCreateAppointmentForContact = useCallback((contact: ChatContact) => {',
    '\n\n  useEffect(() => {'
  );
  assert.match(mobileCreateFlow, /calendarId:\s*selectedCalendarKey/);

  const mobileSaveFlow = extractBetween(
    mobileApp,
    'const saveAppointmentDraft = useCallback(async (',
    '\n\n  const deleteAppointment = useCallback'
  );
  assert.match(mobileSaveFlow, /getAppointmentAvailabilityRequestFields\(\{[\s\S]*?formMode:\s*appointmentMode,[\s\S]*?scheduleMode/);
  assert.match(
    mobileSaveFlow,
    /\} else \{\s*const createPayload = \{\s*\.\.\.payload,\s*calendarId,[\s\S]*?api\.createAppointment\(createPayload, createIntent\.clientRequestId\)/
  );
  assert.match(mobileApp, /onAppointment=\{\(\) => navigateToContactTool\(contact, 'calendar'\)\}/);
  assert.match(
    readRepositoryFile('mobile/src/calendarState.ts'),
    /scheduleMode === 'default'[\s\S]*?strictAvailabilityCheck: true[\s\S]*?ignoreAppointmentConflicts: true/
  );
});
