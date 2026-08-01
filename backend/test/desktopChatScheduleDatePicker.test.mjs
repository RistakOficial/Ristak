import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const desktopChatSourceUrl = new URL('../../frontend/src/pages/DesktopChat/DesktopChat.tsx', import.meta.url)
const scheduleModalSourceUrl = new URL('../../frontend/src/components/common/ChatScheduleModal/ChatScheduleModal.tsx', import.meta.url)
const datePickerSourceUrl = new URL('../../frontend/src/components/common/DatePicker/DatePicker.tsx', import.meta.url)

test('el programador del chat usa el DatePicker común y no un input nativo transparente', async () => {
  const [desktopChatSource, scheduleModalSource, datePickerSource] = await Promise.all([
    readFile(desktopChatSourceUrl, 'utf8'),
    readFile(scheduleModalSourceUrl, 'utf8'),
    readFile(datePickerSourceUrl, 'utf8')
  ])

  assert.match(desktopChatSource, /<ChatScheduleModal[\s\S]*?isOpen=\{scheduleOpen\}[\s\S]*?timezone=\{timezone\}/)
  assert.match(scheduleModalSource, /<DatePicker[\s\S]*?min=\{todayDateOnlyInTimezone\(timezone\)\}[\s\S]*?onChange=\{\(date\) => updateDraft\(\{ date \}\)\}/)
  assert.match(scheduleModalSource, /localDateTimeInputToUTCISOString\(localInput, timezone\)/)
  assert.doesNotMatch(scheduleModalSource, /type="date"|type="number"|showPicker/)
  assert.match(datePickerSource, /createPortal\(panel, document\.body\)/)
  assert.match(datePickerSource, /getFloatingLayerZIndex\(containerRef\.current, 'popover'\)/)
  assert.match(datePickerSource, /disabled: Boolean\(\(min && dateOnly < min\) \|\| \(max && dateOnly > max\)\)/)
  assert.match(datePickerSource, /data-date-picker-panel/)
  assert.match(datePickerSource, /todayDateOnlyInTimezone\(getStoredBusinessTimezone\(\)\)/)
  assert.match(datePickerSource, /addDateOnlyDays\(viewMonth, index - firstWeekday\)/)
  assert.doesNotMatch(datePickerSource, /new Date\(|toISOString\(|new Intl\.DateTimeFormat/)
})
