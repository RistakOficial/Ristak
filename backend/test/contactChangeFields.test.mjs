import assert from 'node:assert/strict'
import test from 'node:test'

import { getChangedContactFields } from '../src/utils/contactChangeFields.js'
import { serializeContactCustomFieldsForDb } from '../src/utils/contactCustomFields.js'

function customField(key, value, extra = {}) {
  return {
    id: key,
    key,
    fieldKey: key,
    label: key,
    value,
    ...extra
  }
}

test('detecta cada campo estándar observable con aliases compatibles con automatizaciones', () => {
  const before = {
    full_name: 'Ana López',
    first_name: 'Ana',
    last_name: 'López',
    phone: '+526561111111',
    email: 'ana@ejemplo.com',
    source: 'manual',
    visitor_id: 'visitor-1',
    attribution_url: 'https://antes.test',
    attribution_session_source: 'facebook',
    attribution_medium: 'paid',
    attribution_ad_name: 'Anuncio A',
    attribution_ad_id: 'ad-1',
    referred_by_contact_id: 'contact-1',
    preferred_whatsapp_phone_number_id: 'wa-1',
    assigned_user_id: 'user-1',
    total_paid: 100,
    purchases_count: 1,
    last_purchase_date: '2026-08-01',
    appointment_date: '2026-08-10'
  }
  const after = {
    ...before,
    full_name: 'María Pérez',
    first_name: 'María',
    last_name: 'Pérez',
    phone: '+526562222222',
    email: 'maria@ejemplo.com',
    source: 'form',
    visitor_id: 'visitor-2',
    attribution_url: 'https://despues.test',
    attribution_session_source: 'google',
    attribution_medium: 'organic',
    attribution_ad_name: 'Anuncio B',
    attribution_ad_id: 'ad-2',
    referred_by_contact_id: 'contact-2',
    preferred_whatsapp_phone_number_id: 'wa-2',
    assigned_user_id: 'user-2',
    total_paid: 250,
    purchases_count: 2,
    last_purchase_date: '2026-08-02',
    appointment_date: '2026-08-11'
  }

  const changed = new Set(getChangedContactFields(before, after))
  for (const expected of [
    'name', 'fullName', 'firstName', 'lastName', 'phone', 'email', 'source',
    'visitorId', 'attributionUrl', 'attributionSource', 'attributionMedium',
    'attributionAd', 'referredByContactId', 'preferredWhatsAppPhoneNumberId',
    'assignedUser', 'totalPaid', 'purchasesCount', 'lastPurchaseDate', 'appointmentDate'
  ]) {
    assert.equal(changed.has(expected), true, `faltó ${expected}`)
  }
})

test('detecta ubicación, dirección y cualquier campo personalizado por su identidad estable', () => {
  const before = {
    custom_fields: serializeContactCustomFieldsForDb([
      customField('country', 'México'),
      customField('address_1', 'Calle Uno'),
      customField('company', 'Empresa A')
    ])
  }
  const after = {
    custom_fields: serializeContactCustomFieldsForDb([
      customField('country', 'Colombia'),
      customField('address_1', 'Calle Dos'),
      customField('company', 'Empresa B')
    ])
  }

  const changed = new Set(getChangedContactFields(before, after))
  for (const expected of [
    'country', 'custom:country', 'address_1', 'custom:address_1', 'company', 'custom:company'
  ]) {
    assert.equal(changed.has(expected), true, `faltó ${expected}`)
  }
})

test('no inventa cambios al guardar los mismos valores o sólo reordenar etiquetas', () => {
  const fieldsBefore = serializeContactCustomFieldsForDb([
    customField('country', 'México', { sourceType: 'manual' })
  ])
  const fieldsAfter = serializeContactCustomFieldsForDb([
    customField('country', 'México', { sourceType: 'webhook', sourceId: 'ghl' })
  ])
  const before = {
    full_name: 'Ana López',
    email: 'ana@ejemplo.com',
    total_paid: 100,
    tags: JSON.stringify(['cliente', 'vip']),
    custom_fields: fieldsBefore
  }
  const after = {
    ...before,
    tags: JSON.stringify(['vip', 'cliente', 'vip']),
    custom_fields: fieldsAfter,
    updated_at: '2099-01-01T00:00:00.000Z',
    ghl_contact_id: 'proveedor-tecnico'
  }

  assert.deepEqual(getChangedContactFields(before, after), [])
})

test('detecta añadir o quitar una etiqueta sin depender del orden', () => {
  assert.deepEqual(
    getChangedContactFields({ tags: '["prospecto"]' }, { tags: '["prospecto","vip"]' }),
    ['tags']
  )
  assert.deepEqual(
    getChangedContactFields({ tags: '["prospecto","vip"]' }, { tags: '["vip"]' }),
    ['tags']
  )
})
