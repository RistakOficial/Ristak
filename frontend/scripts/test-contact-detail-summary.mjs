import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { mergeAuthoritativeContactSummary } from '../src/pages/Contacts/contactDetailSummary.ts'

const baseContact = {
  id: 'contact-1',
  createdAt: '2026-08-01T12:00:00.000Z',
  name: 'Contacto',
  ltv: 0,
  purchases: 0,
  status: 'lead'
}

test('conserva totales del detalle aunque pagos y citas sigan sin hidratar', () => {
  const detail = {
    ...baseContact,
    ltv: 200000,
    purchases: 2,
    successfulPaymentsCount: 2,
    paymentsTotal: 2,
    hasPaymentRecords: true,
    appointmentsTotal: 3,
    hasAppointments: true,
    firstAppointmentDate: '2026-07-01T16:00:00.000Z',
    nextAppointmentDate: '2026-08-10T16:00:00.000Z',
    status: 'customer'
  }

  const merged = mergeAuthoritativeContactSummary(baseContact, detail)

  assert.equal(merged.ltv, 200000)
  assert.equal(merged.successfulPaymentsCount, 2)
  assert.equal(merged.paymentsTotal, 2)
  assert.equal(merged.hasPaymentRecords, true)
  assert.equal(merged.appointmentsTotal, 3)
  assert.equal(merged.firstAppointmentDate, detail.firstAppointmentDate)
  assert.equal(merged.nextAppointmentDate, detail.nextAppointmentDate)
  assert.equal(merged.status, 'customer')
})

test('respeta ceros canónicos y no conserva totales viejos de la tabla', () => {
  const merged = mergeAuthoritativeContactSummary(
    {
      ...baseContact,
      ltv: 1500,
      purchases: 1,
      paymentsTotal: 1,
      appointmentsTotal: 1,
      status: 'customer'
    },
    {
      ...baseContact,
      paymentsTotal: 0,
      hasPaymentRecords: false,
      appointmentsTotal: 0,
      hasAppointments: false
    }
  )

  assert.equal(merged.ltv, 0)
  assert.equal(merged.purchases, 0)
  assert.equal(merged.paymentsTotal, 0)
  assert.equal(merged.appointmentsTotal, 0)
  assert.equal(merged.status, 'lead')
})

test('la página de Contactos aplica el resumen canónico al abrir la ficha', async () => {
  const contactsPageSource = await readFile(
    new URL('../src/pages/Contacts/Contacts.tsx', import.meta.url),
    'utf8'
  )

  assert.match(
    contactsPageSource,
    /Object\.assign\(merged, mergeAuthoritativeContactSummary\(merged, authoritativeContact\)\)/
  )
})

test('la ficha aplica un ritmo visual consistente a su panel de información', async () => {
  const [modalSource, modalStyles] = await Promise.all([
    readFile(
      new URL('../src/components/common/ContactDetailsModal/ContactDetailsModal.tsx', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../src/components/common/ContactDetailsModal/ContactDetailsModal.module.css', import.meta.url),
      'utf8'
    )
  ])

  assert.match(
    modalStyles,
    /\.singleContactInfoPanel \.contactDetails > \.detailSection:first-child\s*{\s*padding-top: 18px;/
  )
  assert.doesNotMatch(
    modalStyles,
    /\.singleContactInfoPanel \.detailSection:first-child\s*{/
  )
  assert.match(
    modalStyles,
    /\.singleContactInfoPanel \.contactDetails > \.detailSection\s*{[\s\S]*?padding: 18px 0;[\s\S]*?border-bottom: 1px solid var\(--contact-details-border\);/,
    'las secciones principales deben compartir el ritmo y divisor de la ficha'
  )
  assert.match(
    modalSource,
    /className=\{styles\.contactReferrerField\}[\s\S]*?label="Recomendado por"[\s\S]*?density="compact"/,
    'el recomendador debe quedar separado y usar la densidad compacta global'
  )
  assert.match(
    modalSource,
    /className=\{styles\.whatsappPreferenceSelect\}[\s\S]*?aria-label="WhatsApp de respuesta del contacto"/,
    'el selector de WhatsApp debe activar la altura uniforme de la ficha'
  )
  assert.match(
    modalStyles,
    /\.whatsappPreferenceSelect \[data-ristak-dropdown-trigger\]\s*{[\s\S]*?min-height: var\(--app-control-height, 40px\);/,
    'el selector de WhatsApp debe conservar la altura global de los controles'
  )
  assert.match(
    modalSource,
    /<ContactCustomFieldsPanel[\s\S]*?className=\{styles\.contactCustomFieldsPanel\}/,
    'los campos personalizados deben heredar la misma escala de títulos del panel'
  )
})
