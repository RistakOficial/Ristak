import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('public calendar choice radios do not inherit text field sizing or focus chrome', async () => {
  const source = await readFile(join(backendRoot, 'src/services/localCalendarService.js'), 'utf8')

  assert.match(source, /input:not\(\[type='radio'\]\):not\(\[type='checkbox'\]\):focus/)
  assert.match(source, /\.option input\[type='radio'\],\.option input\[type='checkbox'\]\{[^}]*min-height:19px/)
  assert.match(source, /\.option input\[type='radio'\]\{border-radius:50%\}/)
  assert.match(source, /\.option input\[type='radio'\]:focus,\.option input\[type='checkbox'\]:focus\{outline:none;box-shadow:none\}/)
})

test('public site choice radios render as compact circular controls', async () => {
  const source = await readFile(join(backendRoot, 'src/services/sitesService.js'), 'utf8')

  assert.match(source, /input:not\(\[type='radio'\]\):not\(\[type='checkbox'\]\):focus/)
  assert.match(source, /\.rstk-option input\[type='radio'\],\.rstk-option input\[type='checkbox'\]\{[^}]*min-height:19px/)
  assert.match(source, /\.rstk-option input\[type='radio'\]\{border-radius:50%\}/)
  assert.match(source, /\.rstk-option input\[type='radio'\]:focus,\.rstk-option input\[type='checkbox'\]:focus\{outline:none;box-shadow:none\}/)
})
