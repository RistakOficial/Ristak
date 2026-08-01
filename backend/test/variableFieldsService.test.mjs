import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  deleteVariableFieldHandler,
  updateVariableFieldHandler
} from '../src/controllers/variableFieldsController.js'
import {
  archiveVariableField,
  createVariableField,
  listVariableFields,
  updateVariableField,
  VARIABLE_FIELD_VALUE_MAX_LENGTH
} from '../src/services/variableFieldsService.js'

function createResponseStub() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
}

async function deleteVariableField(field) {
  if (!field?.id) return
  await db.run('DELETE FROM variable_fields WHERE id = ?', [field.id]).catch(() => undefined)
}

test('variable fields accept the exact value limit and reject anything larger on create or update', async () => {
  const suffix = randomUUID().replace(/-/g, '_')
  const maxValue = 'x'.repeat(VARIABLE_FIELD_VALUE_MAX_LENGTH)
  const oversizedValue = 'y'.repeat(VARIABLE_FIELD_VALUE_MAX_LENGTH + 1)
  const oversizedKey = `oversized_create_${suffix}`
  let field

  try {
    await assert.rejects(
      () => createVariableField({
        label: `Valor demasiado largo ${suffix}`,
        fieldKey: oversizedKey,
        value: oversizedValue
      }),
      (error) => {
        assert.equal(error.status, 400)
        assert.match(error.message, /100[,.]?000 caracteres/)
        return true
      }
    )

    field = await createVariableField({
      label: `Valor limite ${suffix}`,
      fieldKey: `exact_limit_${suffix}`,
      value: maxValue
    })
    assert.equal(field.value.length, VARIABLE_FIELD_VALUE_MAX_LENGTH)

    await assert.rejects(
      () => updateVariableField(field.id, { value: oversizedValue }),
      (error) => {
        assert.equal(error.status, 400)
        assert.match(error.message, /100[,.]?000 caracteres/)
        return true
      }
    )

    const fields = await listVariableFields({ includeArchived: true })
    assert.equal(fields.some((item) => item.fieldKey === oversizedKey), false)
    assert.equal(
      fields.find((item) => item.id === field.id)?.value.length,
      VARIABLE_FIELD_VALUE_MAX_LENGTH,
      'un update rechazado no debe truncar ni modificar el valor anterior'
    )
  } finally {
    await deleteVariableField(field)
    await db.run('DELETE FROM variable_fields WHERE field_key = ?', [oversizedKey]).catch(() => undefined)
  }
})

test('a variable field keeps its internal key immutable after creation', async () => {
  const suffix = randomUUID().replace(/-/g, '_')
  const originalKey = `immutable_key_${suffix}`
  const replacementKey = `replacement_key_${suffix}`
  let field

  try {
    field = await createVariableField({
      label: `Llave inmutable ${suffix}`,
      fieldKey: originalKey,
      value: 'valor original'
    })

    await assert.rejects(
      () => updateVariableField(field.id, {
        fieldKey: replacementKey,
        label: 'No debe guardarse',
        value: 'tampoco debe guardarse'
      }),
      (error) => {
        assert.equal(error.status, 400)
        assert.match(error.message, /parámetro interno no se puede cambiar/i)
        return true
      }
    )

    const stored = (await listVariableFields({ includeArchived: true }))
      .find((item) => item.id === field.id)
    assert.equal(stored?.fieldKey, originalKey)
    assert.equal(stored?.label, field.label)
    assert.equal(stored?.value, 'valor original')
  } finally {
    await deleteVariableField(field)
  }
})

test('an archived variable key remains reserved and cannot be reused', async () => {
  const suffix = randomUUID().replace(/-/g, '_')
  const fieldKey = `archived_key_${suffix}`
  let field

  try {
    field = await createVariableField({
      label: `Llave archivada ${suffix}`,
      fieldKey,
      value: 'valor historico'
    })
    const archived = await archiveVariableField(field.id)
    assert.equal(archived.archived, true)

    await assert.rejects(
      () => createVariableField({
        label: `Intento de reuso ${suffix}`,
        fieldKey: fieldKey.toUpperCase(),
        value: 'valor nuevo'
      }),
      (error) => {
        assert.equal(error.status, 400)
        assert.match(error.message, /ya existe o fue archivado/i)
        return true
      }
    )

    assert.equal((await listVariableFields()).some((item) => item.id === field.id), false)
    const allFields = await listVariableFields({ includeArchived: true })
    assert.equal(allFields.filter((item) => item.fieldKey === fieldKey).length, 1)
    assert.equal(allFields.find((item) => item.id === field.id)?.archived, true)
  } finally {
    await deleteVariableField(field)
  }
})

test('site header variables require Sites write access to change their value or archive them', async () => {
  const suffix = randomUUID().replace(/-/g, '_')
  const siteId = `site_variable_permissions_${suffix}`
  let field

  try {
    field = await createVariableField({
      label: `Tracking protegido ${suffix}`,
      fieldKey: `tracking_protected_${suffix}`,
      value: 'valor original'
    })
    await db.run(
      `INSERT INTO public_sites (id, name, slug, site_type, status, theme_json, updated_at)
       VALUES (?, ?, ?, 'landing_page', 'draft', ?, CURRENT_TIMESTAMP)`,
      [
        siteId,
        `Sitio protegido ${suffix}`,
        `sitio-variable-permissions-${suffix}`,
        JSON.stringify({ headerTrackingCode: `<script>${field.parameter}</script>` })
      ]
    )

    const fieldsOnlyUser = {
      id: `employee_fields_only_${suffix}`,
      role: 'employee',
      access_config: {
        settings_custom_fields: 'write',
        sites: 'none'
      }
    }
    const deniedUpdateRes = createResponseStub()
    await updateVariableFieldHandler({
      params: { variableFieldId: field.id },
      body: { value: 'valor bloqueado' },
      user: fieldsOnlyUser
    }, deniedUpdateRes)

    assert.equal(deniedUpdateRes.statusCode, 403)
    assert.equal(deniedUpdateRes.payload?.success, false)
    assert.match(deniedUpdateRes.payload?.error || '', /permiso para editar Sites/i)

    const deniedArchiveRes = createResponseStub()
    await deleteVariableFieldHandler({
      params: { variableFieldId: field.id },
      user: fieldsOnlyUser
    }, deniedArchiveRes)

    assert.equal(deniedArchiveRes.statusCode, 403)
    assert.equal(deniedArchiveRes.payload?.success, false)
    assert.match(deniedArchiveRes.payload?.error || '', /permiso para editar Sites/i)

    const unchanged = (await listVariableFields({ includeArchived: true }))
      .find((item) => item.id === field.id)
    assert.equal(unchanged?.value, 'valor original')
    assert.equal(unchanged?.archived, false)

    const sitesWriter = {
      ...fieldsOnlyUser,
      access_config: {
        settings_custom_fields: 'write',
        sites: 'write'
      }
    }
    const allowedUpdateRes = createResponseStub()
    await updateVariableFieldHandler({
      params: { variableFieldId: field.id },
      body: { value: 'valor permitido' },
      user: sitesWriter
    }, allowedUpdateRes)

    assert.equal(allowedUpdateRes.statusCode, 200)
    assert.equal(allowedUpdateRes.payload?.success, true)
    assert.equal(allowedUpdateRes.payload?.data?.value, 'valor permitido')

    const allowedArchiveRes = createResponseStub()
    await deleteVariableFieldHandler({
      params: { variableFieldId: field.id },
      user: sitesWriter
    }, allowedArchiveRes)

    assert.equal(allowedArchiveRes.statusCode, 200)
    assert.equal(allowedArchiveRes.payload?.success, true)
    assert.equal(allowedArchiveRes.payload?.data?.archived, true)
  } finally {
    await db.run('DELETE FROM public_sites WHERE id = ?', [siteId]).catch(() => undefined)
    await deleteVariableField(field)
  }
})
