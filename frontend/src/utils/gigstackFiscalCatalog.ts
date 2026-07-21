export const gigstackProductKeyOptions = [
  { value: '82101800', label: 'Servicios de agencia de publicidad · 82101800' },
  { value: '80101500', label: 'Consultoría de negocios · 80101500' },
  { value: '81112100', label: 'Servicios de internet · 81112100' },
  { value: '43232408', label: 'Software como servicio · 43232408' },
  { value: '84111506', label: 'Servicios de facturación · 84111506' },
  { value: '86101600', label: 'Capacitación · 86101600' },
  { value: '90101500', label: 'Alimentos y restaurante · 90101500' },
  { value: '01010101', label: 'Producto no clasificado · 01010101' }
]

export const gigstackUnitOptions = [
  { value: 'E48', label: 'Unidad de servicio · E48', unitName: 'Unidad de Servicio' },
  { value: 'H87', label: 'Pieza · H87', unitName: 'Pieza' },
  { value: 'ACT', label: 'Actividad · ACT', unitName: 'Actividad' },
  { value: 'E51', label: 'Trabajo · E51', unitName: 'Trabajo' },
  { value: 'MTR', label: 'Metro · MTR', unitName: 'Metro' },
  { value: 'KGM', label: 'Kilogramo · KGM', unitName: 'Kilogramo' }
]

export const gigstackPaymentMethodOptions = [
  { value: '99', label: 'Por definir · 99' },
  { value: '04', label: 'Tarjeta de crédito · 04' },
  { value: '28', label: 'Tarjeta de débito · 28' },
  { value: '03', label: 'Transferencia electrónica · 03' },
  { value: '01', label: 'Efectivo · 01' },
  { value: '02', label: 'Cheque nominativo · 02' }
]

export function getGigstackUnitName(unitKey = '') {
  return gigstackUnitOptions.find((option) => option.value === unitKey)?.unitName || ''
}
