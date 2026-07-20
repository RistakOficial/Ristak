import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const sourceUrl = new URL('../src/utils/calendarCommercialReports.ts', import.meta.url)
const source = await fs.readFile(sourceUrl, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  },
  fileName: 'calendarCommercialReports.ts'
}).outputText
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
const {
  getNextCommercialReportCalendarIds,
  isCalendarIncludedInCommercialReports
} = await import(moduleUrl)

test('una selección vacía incluye todos los calendarios por default', () => {
  assert.equal(isCalendarIncludedInCommercialReports([], 'calendar-a'), true)
  assert.equal(isCalendarIncludedInCommercialReports([], 'calendar-new'), true)
})

test('una selección explícita sólo incluye sus calendarios', () => {
  assert.equal(isCalendarIncludedInCommercialReports(['calendar-a'], 'calendar-a'), true)
  assert.equal(isCalendarIncludedInCommercialReports(['calendar-a'], 'calendar-b'), false)
})

test('apagar uno desde el estado todos conserva los demás', () => {
  assert.deepEqual(
    getNextCommercialReportCalendarIds([], 'calendar-b', ['calendar-a', 'calendar-b', 'calendar-c']),
    ['calendar-a', 'calendar-c']
  )
})

test('quitar la última selección explícita vuelve al estado todos', () => {
  assert.deepEqual(
    getNextCommercialReportCalendarIds(['calendar-a'], 'calendar-a', ['calendar-a', 'calendar-b']),
    []
  )
})
