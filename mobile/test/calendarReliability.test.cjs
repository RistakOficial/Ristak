const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(outputText, filename);
};

const {
  getAppointmentAvailabilityRequestFields,
  isCurrentCalendarSlotSelection,
} = require('../src/calendarState.ts');

const freeSlots = [{
  date: '2026-07-10',
  slots: ['2026-07-10T15:00:00.000Z'],
}];

function selection(overrides = {}) {
  return {
    calendarId: 'calendar-a',
    groupDate: '2026-07-10',
    dateOnly: '2026-07-10',
    slot: '2026-07-10T15:00:00.000Z',
    ...overrides,
  };
}

test('acepta solamente un slot que sigue en el calendario y fecha actuales', () => {
  assert.equal(isCurrentCalendarSlotSelection({
    calendarId: 'calendar-a',
    dateOnly: '2026-07-10',
    freeSlots,
    selection: selection(),
  }), true);
});

test('rechaza una respuesta o seleccion de un calendario anterior', () => {
  assert.equal(isCurrentCalendarSlotSelection({
    calendarId: 'calendar-b',
    dateOnly: '2026-07-10',
    freeSlots,
    selection: selection(),
  }), false);
});

test('rechaza un slot de otra fecha o que ya desaparecio de disponibilidad', () => {
  assert.equal(isCurrentCalendarSlotSelection({
    calendarId: 'calendar-a',
    dateOnly: '2026-07-11',
    freeSlots,
    selection: selection(),
  }), false);
  assert.equal(isCurrentCalendarSlotSelection({
    calendarId: 'calendar-a',
    dateOnly: '2026-07-10',
    freeSlots,
    selection: selection({ slot: '2026-07-10T16:00:00.000Z' }),
  }), false);
});

test('crea con candado de disponibilidad solo desde un horario libre', () => {
  assert.deepEqual(getAppointmentAvailabilityRequestFields({
    formMode: 'create',
    scheduleMode: 'default',
  }), { strictAvailabilityCheck: true });

  assert.deepEqual(getAppointmentAvailabilityRequestFields({
    formMode: 'create',
    scheduleMode: 'custom',
  }), {});
  assert.deepEqual(getAppointmentAvailabilityRequestFields({
    formMode: 'edit',
    scheduleMode: 'default',
  }), {});
});

test('los deep links de cita esperan el bootstrap real antes de consumirse', () => {
  const source = fs.readFileSync(require.resolve('../src/App.tsx'), 'utf8');

  assert.match(source, /const HANDLED_APPOINTMENT_DEEP_LINK_IDS = new Set<string>\(\)/);
  assert.match(source, /const handledOpenAppointmentRef = useRef\(HANDLED_APPOINTMENT_DEEP_LINK_IDS\)/);
  assert.match(source, /const \[pendingAppointmentLinks, setPendingAppointmentLinks\] = useState<string\[]>\(\[]\)/);
  assert.match(source, /if \(!calendarContextUsable \|\| !pendingAppointmentLinks\.length\) return;\s+void openAppointmentFromLink\(pendingAppointmentLinks\[0\]\)/);
  assert.match(source, /setSelectedEvent\(appointment\);\s+openSheet\('event'\);\s+handledOpenAppointmentRef\.current\.add\(appointmentId\);\s+removePendingLink\(\)/);
  assert.match(source, /catch \{\s+removePendingLink\(\);\s+Alert\.alert/);
  assert.doesNotMatch(source, /finally \{\s+handledOpenAppointmentRef\.current\.add\(appointmentId\)/);
  assert.doesNotMatch(source, /handledOpenAppointmentRef\.current = appointmentId/);
});

test('cada formulario móvil conserva la llave de cita durante timeout y reintento', () => {
  const appSource = fs.readFileSync(require.resolve('../src/App.tsx'), 'utf8');
  const apiSource = fs.readFileSync(require.resolve('../src/api.ts'), 'utf8');

  assert.match(appSource, /onSave\(draft, scheduleMode\)/);
  assert.match(appSource, /\.\.\.getAppointmentAvailabilityRequestFields\(\{\s+formMode: appointmentMode,\s+scheduleMode,\s+\}\)/);
  assert.match(apiSource, /createAppointment\(appointmentData: Record<string, unknown> & \{ calendarId: string \}, clientRequestId\?: string\)/);
  assert.match(apiSource, /\.\.\.\(clientRequestId \? \{ clientRequestId \} : \{\}\)/);
  assert.match(appSource, /const createPayload = \{[\s\S]*?calendarId,[\s\S]*?contactId: draft\.contactId,[\s\S]*?appointmentCreateIntentRef\.current = createIntent;\s+const createdAppointment = await api\.createAppointment\(createPayload, createIntent\.clientRequestId\)/);
  assert.match(appSource, /const createAppointmentForContact = async \(\) => \{[\s\S]*?getAppointmentAvailabilityRequestFields\(\{\s+formMode: 'create',\s+scheduleMode: 'custom',\s+\}\)[\s\S]*?await api\.createAppointment\(payload, intent\.clientRequestId\)/);
  assert.match(appSource, /quickAppointmentIntentRef\.current = intent;\s+const createdAppointment = await api\.createAppointment\(payload, intent\.clientRequestId\)/);
});
