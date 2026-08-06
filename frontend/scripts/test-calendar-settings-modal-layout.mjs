import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const calendarSettingsSource = await readFile(
  new URL('../src/pages/Settings/CalendarsConfiguration.tsx', import.meta.url),
  'utf8'
)
const calendarSettingsStyles = await readFile(
  new URL('../src/pages/Settings/CalendarsConfiguration.module.css', import.meta.url),
  'utf8'
)

assert.match(
  calendarSettingsSource,
  /className=\{pageStyles\.calendarWizardModal\}[\s\S]*contentClassName=\{pageStyles\.calendarWizardModalContent\}/,
  'el wizard debe controlar el overflow del contenido exterior del Modal'
)
assert.match(
  calendarSettingsSource,
  /className=\{pageStyles\.calendarWizardFooter\}\s+data-modal-footer=""/,
  'las acciones del wizard deben vivir en la region de footer del modal'
)
assert.match(
  calendarSettingsStyles,
  /\.calendarWizardModal\s*\{[^}]*height:\s*min\(880px,\s*calc\(100dvh\s*-\s*32px\)\)/,
  'el modal debe tener una altura acotada para crear una region central desplazable'
)
assert.match(
  calendarSettingsStyles,
  /\.calendarWizardModal\s*>\s*\[data-modal-content\]\.calendarWizardModalContent\s*\{[^}]*overflow:\s*hidden/,
  'el contenido exterior no debe desplazar el panel inferior'
)
assert.match(
  calendarSettingsStyles,
  /\.calendarWizardShell\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0/,
  'el shell debe ocupar la region disponible sin crecer por su contenido'
)
assert.match(
  calendarSettingsStyles,
  /\.calendarWizardBody\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/,
  'solo el cuerpo central del wizard debe desplazarse verticalmente'
)
assert.match(
  calendarSettingsStyles,
  /\.calendarWizardFooter\s*\{[^}]*flex:\s*0\s+0\s+auto[^}]*border-top:[^}]*background:\s*var\(--surface-2\)/,
  'el footer debe conservarse visible y distinguirse como panel de acciones'
)
assert.match(
  calendarSettingsStyles,
  /:global\(body\.light\)\s+\.googleHeaderButtonConnected\s*\{[^}]*color:\s*var\(--surface-solid,\s*var\(--surface\)\)[^}]*border-color:\s*color-mix\(in srgb,\s*var\(--pos\)\s*75%,\s*var\(--text\)\s*25%\)[^}]*background:\s*color-mix\(in srgb,\s*var\(--pos\)\s*75%,\s*var\(--text\)\s*25%\)/,
  'el estado conectado de Google debe usar texto e icono claros sobre un verde con contraste en modo claro'
)
assert.match(
  calendarSettingsStyles,
  /:global\(body\.light\)\s+\.googleHeaderButtonConnected:hover\s*\{[^}]*color:\s*var\(--surface-solid,\s*var\(--surface\)\)[^}]*filter:\s*brightness\(0\.94\)/,
  'el hover conectado debe conservar el contraste y oscurecer ligeramente el verde'
)

console.log('Calendar settings visual contract OK')
