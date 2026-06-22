/**
 * Kit de UI estándar de la versión móvil.
 * Cuando agregues pantallas o formularios al celular usa estos componentes en
 * vez de armar inputs, filtros, botones o menús deslizables a mano: así todo se
 * comporta igual (mismos chips, mismo sheet, mismos campos, mismos botones).
 */
export { PhoneSheet, usePhoneSheetClose } from './PhoneSheet'
export { PhoneTextField, PhoneTextArea } from './PhoneTextField'
export { PhoneButton } from './PhoneButton'
export { PhoneFilterChips, type PhoneFilterChipOption } from './PhoneFilterChips'
export { PhoneTimeField, formatTimeLabel } from './PhoneTimeField'
export { PhoneDateTimeField } from './PhoneDateTimeField'
export { PhoneDurationField, formatDurationLabel } from './PhoneDurationField'
export { PhoneSegmentedTabs, type PhoneSegmentedTabOption } from './PhoneSegmentedTabs'
export { PhoneSelect, type PhoneSelectOption } from '../PhoneSelect'
export { PhoneDateField } from '../PhoneDateField'
