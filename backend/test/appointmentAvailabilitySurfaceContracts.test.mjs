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

test('las superficies frontend conservan el candado emitido por AppointmentModal', () => {
  const service = readRepositoryFile('frontend/src/services/calendarsService.ts');
  const modal = readRepositoryFile('frontend/src/components/common/AppointmentModal/AppointmentModal.tsx');
  const phoneCalendar = readRepositoryFile('frontend/src/pages/PhoneCalendar/PhoneCalendar.tsx');
  const phoneChat = readRepositoryFile('frontend/src/pages/PhoneChat/PhoneChat.tsx');
  const desktopChat = readRepositoryFile('frontend/src/pages/DesktopChat/DesktopChat.tsx');

  assert.match(service, /strictAvailabilityCheck\?: true;/);
  assert.equal((modal.match(/payload\.strictAvailabilityCheck = true/g) || []).length, 1);
  assert.match(modal, /if \(scheduleMode === 'default'\) \{\s*payload\.strictAvailabilityCheck = true;/);

  assert.match(phoneCalendar, /strictAvailabilityCheck\?: true[\s\S]*?const appointmentData = \{[\s\S]*?\.\.\.payload/);
  assert.match(phoneChat, /strictAvailabilityCheck\?: true[\s\S]*?const appointmentData = \{[\s\S]*?\.\.\.payload/);
  assert.match(desktopChat, /strictAvailabilityCheck\?: true[\s\S]*?calendarsService\.createAppointment\(eventIdOrPayload/);

  for (const source of [phoneCalendar, phoneChat, desktopChat]) {
    assert.match(source, /defaultScheduleMode="custom"/);
  }
});

test('los atajos de captura manual no se hacen pasar por un horario disponible', () => {
  const phoneChat = readRepositoryFile('frontend/src/pages/PhoneChat/PhoneChat.tsx');
  const mobileApp = readRepositoryFile('mobile/src/App.tsx');

  const phoneChatManualCalendar = extractBetween(
    phoneChat,
    'const handleSubmitAppointmentCalendar = async () => {',
    '\n  useEffect(() => {'
  );
  assert.doesNotMatch(phoneChatManualCalendar, /strictAvailabilityCheck\s*:/);

  const mobileManualAppointment = extractBetween(
    mobileApp,
    'const createAppointmentForContact = async () => {',
    '\n  const applyTagToContact = async'
  );
  assert.match(mobileManualAppointment, /getAppointmentAvailabilityRequestFields\(\{\s*formMode: 'create',\s*scheduleMode: 'custom'/);
  assert.doesNotMatch(mobileManualAppointment, /strictAvailabilityCheck\s*:\s*true/);
});
