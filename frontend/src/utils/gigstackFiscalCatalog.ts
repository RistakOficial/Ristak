export const gigstackProductKeyOptions = [
  { value: '82101800', label: 'Agencia de publicidad · 82101800' },
  { value: '80141503', label: 'Consultoría de negocios · 80141503' },
  { value: '80141600', label: 'Mercadotecnia · 80141600' },
  { value: '81111500', label: 'Desarrollo de software · 81111500' },
  { value: '81112100', label: 'Hospedaje web · 81112100' },
  { value: '82121500', label: 'Diseño gráfico · 82121500' },
  { value: '84111600', label: 'Servicios contables · 84111600' },
  { value: '85121600', label: 'Servicios médicos · 85121600' },
  { value: '86101604', label: 'Capacitación · 86101604' },
  { value: '72121400', label: 'Construcción comercial · 72121400' },
  { value: '01010101', label: 'Clave genérica · 01010101 (sólo si aplica)' }
]

export const gigstackUnitOptions = [
  { value: 'E48', label: 'Unidad de servicio · E48', unitName: 'Unidad de Servicio' },
  { value: 'H87', label: 'Pieza · H87', unitName: 'Pieza' },
  { value: 'ACT', label: 'Actividad · ACT', unitName: 'Actividad' },
  { value: 'E51', label: 'Trabajo · E51', unitName: 'Trabajo' },
  { value: 'HUR', label: 'Hora · HUR', unitName: 'Hora' },
  { value: 'DAY', label: 'Día · DAY', unitName: 'Día' },
  { value: 'MON', label: 'Mes · MON', unitName: 'Mes' },
  { value: 'ANN', label: 'Año · ANN', unitName: 'Año' },
  { value: 'MTR', label: 'Metro · MTR', unitName: 'Metro' },
  { value: 'KGM', label: 'Kilogramo · KGM', unitName: 'Kilogramo' },
  { value: 'LTR', label: 'Litro · LTR', unitName: 'Litro' },
  { value: 'XBX', label: 'Caja · XBX', unitName: 'Caja' },
  { value: 'XPK', label: 'Paquete · XPK', unitName: 'Paquete' },
  { value: 'PR', label: 'Par · PR', unitName: 'Par' }
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

export function normalizeGigstackProductKeyInput(value = '') {
  return value.replace(/\D/g, '').slice(0, 8)
}

export function isValidGigstackProductKey(value = '') {
  return /^\d{8}$/.test(value)
}

export function normalizeGigstackUnitKeyInput(value = '') {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)
}

export function isValidGigstackUnitKey(value = '') {
  return /^[A-Z0-9]{1,10}$/.test(value)
}
