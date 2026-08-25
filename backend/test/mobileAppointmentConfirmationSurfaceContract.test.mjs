import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');

function extractBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `No se encontró el inicio: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `No se encontró el final: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('web móvil y Android resuelven la espera activa con guardas canónicas', () => {
  const phoneChat = read('frontend/src/pages/PhoneChat/PhoneChat.tsx');
  const android = read('mobile/src/App.tsx');
  const androidTypes = read('mobile/src/types.ts');

  for (const source of [phoneChat, android, androidTypes]) {
    assert.match(source, /activeAppointmentConfirmation/);
  }
  for (const source of [phoneChat, android]) {
    assert.match(source, /expectedAppointmentStatus/);
    assert.match(source, /strictLifecycleMutation:\s*'cancel'/);
    assert.match(source, /Confirmar cita/);
    assert.match(source, /Cancelar cita/);
  }

  const webAction = extractBetween(
    phoneChat,
    "const handleManualAppointmentConfirmation = useCallback((action: 'confirm' | 'cancel') => {",
    '\n\n  // Actualiza el contacto'
  );
  assert.match(webAction, /refreshActiveContactDetails\(activeContactId, \{ force: true \}\)/);
  assert.doesNotMatch(webAction, /showToast\(\s*'success'/);

  const androidAction = extractBetween(
    android,
    "const resolveAppointmentConfirmation = (action: 'confirm' | 'cancel') => {",
    '\n\n  const openContactInfo = async () => {'
  );
  const androidSuccess = extractBetween(
    androidAction,
    '}).then(async () => {',
    '}).catch(async (error) => {'
  );
  assert.match(androidSuccess, /refreshActiveContactDetail\(true\)/);
  assert.doesNotMatch(androidSuccess, /Alert\.alert/);
});

test('iOS decodifica, confirma y refresca la espera sin fabricar éxito', () => {
  const models = read('ios/app/Ristak/Core/Models/ContactModels.swift');
  const service = read('ios/app/Ristak/Core/Services/CalendarsService.swift');
  const viewModel = read('ios/app/Ristak/Features/Chats/Thread/ConversationViewModel.swift');
  const screen = read('ios/app/Ristak/Features/Chats/Thread/ConversationScreen.swift');

  assert.match(models, /struct ActiveAppointmentConfirmation/);
  assert.match(models, /case appointmentStatus = "appointment_status"/);
  assert.match(models, /case startTime = "start_time"/);
  assert.match(service, /expectedAppointmentStatus: expectedStatus/);
  assert.match(service, /strictLifecycleMutation: action == \.cancel \? "cancel" : nil/);
  assert.match(screen, /\.confirmationDialog\(/);
  assert.match(screen, /ristak-appointment-confirmation-control/);

  const action = extractBetween(
    viewModel,
    'func resolveAppointmentConfirmation(_ action: AppointmentConfirmationAction) async {',
    '\n\n    private func loadWhatsAppStatus() async {'
  );
  const success = extractBetween(action, 'do {', '} catch let error as RistakAPIError {');
  assert.match(success, /await hydrateContactDetail\(\)/);
  assert.doesNotMatch(success, /ConversationAlert/);
});
