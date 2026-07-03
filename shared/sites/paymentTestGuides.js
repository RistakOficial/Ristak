export const PAYMENT_TEST_GUIDES = {
  mercadopago: {
    title: 'Ayuda para pruebas de Mercado Pago',
    description: 'En modo prueba copia una tarjeta, escribe cualquier correo valido y usa el nombre del titular para elegir si el pago se aprueba, queda pendiente o se rechaza.',
    emailHint: 'Correo: escribe cualquier correo con formato valido, por ejemplo cliente.prueba@correo.com.',
    cards: [
      { kind: 'Credito', brand: 'Mastercard', number: '5474 9254 3267 0366', cvc: '123', expiry: '11/30' },
      { kind: 'Credito', brand: 'Visa', number: '4075 5957 1648 3764', cvc: '123', expiry: '11/30' },
      { kind: 'Credito', brand: 'American Express', number: '3711 803032 57522', cvc: '1234', expiry: '11/30' },
      { kind: 'Debito', brand: 'Mastercard', number: '5579 0534 6148 2647', cvc: '123', expiry: '11/30' },
      { kind: 'Debito', brand: 'Visa', number: '4189 1412 2126 7633', cvc: '123', expiry: '11/30' }
    ],
    scenarios: [
      { holder: 'APRO', result: 'Pago aprobado' },
      { holder: 'OTHE', result: 'Rechazado por error general' },
      { holder: 'CONT', result: 'Pendiente de pago' },
      { holder: 'CALL', result: 'Rechazado con validacion para autorizar' },
      { holder: 'FUND', result: 'Rechazado por importe insuficiente' },
      { holder: 'SECU', result: 'Rechazado por codigo de seguridad invalido' },
      { holder: 'EXPI', result: 'Rechazado por fecha de vencimiento' },
      { holder: 'FORM', result: 'Rechazado por error de formulario' },
      { holder: 'CARD', result: 'Rechazado por falta de numero de tarjeta' },
      { holder: 'INST', result: 'Rechazado por cuotas invalidas' },
      { holder: 'DUPL', result: 'Rechazado por pago duplicado' },
      { holder: 'LOCK', result: 'Rechazado por tarjeta deshabilitada' },
      { holder: 'CTNA', result: 'Rechazado por tipo de tarjeta no permitida' },
      { holder: 'ATTE', result: 'Rechazado por intentos de PIN excedidos' },
      { holder: 'BLAC', result: 'Rechazado por lista negra' },
      { holder: 'UNSU', result: 'No soportado' },
      { holder: 'TEST', result: 'Aplica regla de montos' }
    ]
  },
  stripe: {
    title: 'Ayuda para pruebas de Stripe',
    description: 'En modo prueba usa fecha futura, cualquier CVC y cualquier dato de cliente. Algunas tarjetas fuerzan rechazo o autenticacion bancaria.',
    emailHint: 'Correo: cualquier correo con formato valido.',
    cards: [
      { kind: 'Credito', brand: 'Visa MX MSI', number: '4000 0048 4000 0008', cvc: '123', expiry: '12/34', result: 'Muestra planes MSI disponibles' },
      { kind: 'Credito', brand: 'Visa', number: '4242 4242 4242 4242', cvc: '123', expiry: '12/34', result: 'Pago aprobado' },
      { kind: 'Debito', brand: 'Visa', number: '4000 0566 5566 5556', cvc: '123', expiry: '12/34', result: 'Pago aprobado' },
      { kind: 'Credito', brand: 'Mastercard', number: '5555 5555 5555 4444', cvc: '123', expiry: '12/34', result: 'Pago aprobado' },
      { kind: 'Credito', brand: 'Visa', number: '4000 0025 0000 3155', cvc: '123', expiry: '12/34', result: 'Pide autenticacion 3D Secure' },
      { kind: 'Credito', brand: 'Visa', number: '4000 0000 0000 0002', cvc: '123', expiry: '12/34', result: 'Rechazo generico' },
      { kind: 'Credito', brand: 'Visa', number: '4000 0000 0000 9995', cvc: '123', expiry: '12/34', result: 'Fondos insuficientes' }
    ]
  },
  conekta: {
    title: 'Ayuda para pruebas de Conekta',
    description: 'En modo prueba usa una fecha futura, cualquier CVC valido y cualquier correo. Estas tarjetas no mueven dinero real.',
    emailHint: 'Correo: cualquier correo con formato valido.',
    cards: [
      { kind: 'Credito', brand: 'Visa', number: '4242 4242 4242 4242', cvc: '123', expiry: '12/34', result: 'Pago aprobado' },
      { kind: 'Credito', brand: 'Visa', number: '4012 8888 8888 1881', cvc: '123', expiry: '12/34', result: 'Pago aprobado' },
      { kind: 'Credito', brand: 'Mastercard', number: '5555 5555 5555 4444', cvc: '123', expiry: '12/34', result: 'Pago aprobado' },
      { kind: 'Credito', brand: 'Mastercard', number: '5105 1051 0510 5100', cvc: '123', expiry: '12/34', result: 'Pago aprobado' },
      { kind: 'Credito', brand: 'American Express', number: '3782 822463 10005', cvc: '1234', expiry: '12/34', result: 'Pago aprobado' },
      { kind: 'Credito', brand: 'Visa', number: '4000 0000 0000 0002', cvc: '123', expiry: '12/34', result: 'Pago rechazado' }
    ]
  },
  clip: {
    title: 'Ayuda para pruebas de CLIP',
    description: 'En modo prueba usa una tarjeta de la tabla, cualquier CVV y una fecha posterior al dia actual. CLIP define el resultado por PAN.',
    emailHint: 'Correo y telefono: el link debe tener ambos datos del cliente para que CLIP procese el cargo.',
    cards: [
      { kind: 'Debito', brand: 'Amex MX', number: '377770358335399', cvc: '1234', expiry: '12/34', result: 'Pago aprobado' },
      { kind: 'Debito', brand: 'Amex MX', number: '377770541774520', cvc: '1234', expiry: '12/34', result: 'Fondos insuficientes' },
      { kind: 'Debito', brand: 'Amex MX', number: '377770520127013', cvc: '1234', expiry: '12/34', result: 'Do not honor' },
      { kind: 'Debito', brand: 'Amex US', number: '349028833584288', cvc: '1234', expiry: '12/34', result: 'Pago aprobado' }
    ]
  }
}

export function getPaymentTestGuide(provider = '') {
  const normalized = String(provider || '').trim().toLowerCase()
  if (normalized.includes('mercado')) return PAYMENT_TEST_GUIDES.mercadopago
  if (normalized.includes('conekta')) return PAYMENT_TEST_GUIDES.conekta
  if (normalized.includes('clip')) return PAYMENT_TEST_GUIDES.clip
  return PAYMENT_TEST_GUIDES.stripe
}
