# Guia de moneda de cuenta

Ultima consolidacion: 2026-07-01.

Este documento es obligatorio antes de tocar cualquier logica de currency,
moneda o importes en Ristak.

## Regla principal

La moneda default de cualquier dato de negocio siempre es la moneda configurada
en la cuenta.

Fuente de verdad:

- Backend: `backend/src/utils/accountLocale.js`
  - `ACCOUNT_CURRENCY_CONFIG_KEY = 'account_currency'`
  - `getAccountCurrency()`
  - `getAccountLocaleSettings()`
- Frontend: `frontend/src/utils/accountLocale.ts`
  - `ACCOUNT_CURRENCY_CONFIG_KEY = 'account_currency'`
  - `normalizeCurrencyCode(...)`
  - `useAccountCurrency()` desde `frontend/src/hooks/useAccountCurrency.ts`
- Persistencia: `app_config.account_currency`.
- UI de usuario: Configuracion > Cuenta, dentro de pais/lada/moneda.

No crees una variable de entorno, Render secret, Docker secret o config manual
externa para elegir la moneda default de la aplicacion.

## Alcance obligatorio

Lee y aplica esta guia antes de tocar:

- Pagos, cobros, links de pago, checkouts publicos y recibos.
- Productos, precios, planes de pago, suscripciones y parcialidades.
- Reportes, dashboards, costos, ingresos, ROAS, LTV, ticket promedio y metricas.
- Sites, formularios, payment gates, bloques tipo currency y conversiones.
- Meta Pixel, Meta CAPI, tracking, eventos de compra y parametros `currency`.
- Automatizaciones, plantillas, variables, IA y prompts que mencionen dinero.
- Integraciones externas cuando creen o reflejen registros locales con importes.

## Reglas de implementacion

- Para registros nuevos, si el usuario no eligio moneda explicitamente, usa la
  moneda de la cuenta.
- Para registros existentes, respeta la moneda guardada en el registro. Cambiar
  la moneda de la cuenta no debe reescribir historicos automaticamente.
- Para integraciones externas, respeta la moneda que venga en el payload externo
  cuando representa una transaccion real externa. Si falta moneda y vas a crear
  un registro local de cuenta, usa la moneda de la cuenta.
- Si una pasarela solo soporta ciertas monedas, valida contra la moneda de la
  cuenta y muestra el bloqueo o alternativa correcta. No cambies la moneda en
  silencio.
- Si un provider necesita guardar su propia moneda default, esa config interna
  debe inicializarse o sincronizarse desde `account_currency` cuando aplique.
- `MXN`, `USD` u otro codigo hardcodeado solo puede existir como fallback tecnico
  dentro de normalizadores, pruebas focalizadas o restricciones explicitas de un
  proveedor. No debe ser el default de negocio de una funcion nueva.

## Frontend

- Usa `useAccountCurrency()` para pantallas y componentes con importes de la
  cuenta.
- Si una pantalla ya tiene un registro con `currency`, formatea con esa moneda:
  `formatCurrency(amount, record.currency || accountCurrency)`.
- No uses `formatCurrency(value)` desnudo para importes de negocio. Ese helper
  cae a `MXN` si no recibe moneda, asi que debe recibir una moneda explicita.
- Los formularios nuevos de pagos, productos, planes, suscripciones o payment
  gates deben inicializar `currency` con `accountCurrency`.
- Los ejemplos visibles para usuarios deben mostrar la moneda de la cuenta, no
  `MXN` por costumbre.

## Backend

- Usa `getAccountCurrency()` desde `backend/src/utils/accountLocale.js` o helpers
  locales ya existentes como `getConfiguredCurrency()` cuando el servicio ya los
  tenga.
- Al crear pagos, productos, precios, planes, suscripciones, payment flows o
  eventos locales con importe, persiste la moneda resuelta en el registro.
- En planes de pago, el total y las parcialidades se comparan en unidades
  mínimas enteras de la moneda (centavos cuando existen; unidad completa en
  monedas de cero decimales). La suma debe ser exacta: no se permiten
  tolerancias ocultas de centavos ni márgenes como `0.50`.
- `DEFAULT_CURRENCY` en servicios de pasarela es fallback defensivo para datos
  vacios o invalidos. No lo uses como fuente principal para nuevas rutas.
- En Meta/CAPI, los eventos `Purchase` (y cualquier evento con `currency` en
  `custom_data`) usan SIEMPRE la moneda configurada en la cuenta via
  `getAccountCurrency()` (`getPaymentMetaCurrency()` en
  `metaConversionEventsService.js`), para que Meta reciba señales consistentes.
  El pago conserva su propia `currency` guardada en la BD para reportes locales;
  esa moneda NO se manda a Meta.
- En automatizaciones e IA, si el contexto no trae moneda de un pago existente,
  resuelve la moneda desde la cuenta antes de construir el mensaje o accion.

## Checklist antes de cerrar

- Buscaste `formatCurrency(`, `currency`, `DEFAULT_CURRENCY`, `'MXN'`, `"MXN"`,
  `'USD'` y `"USD"` en los archivos tocados.
- Confirmaste que los nuevos defaults salen de `account_currency`.
- Confirmaste que los registros historicos conservan su propia moneda.
- Confirmaste que no agregaste nuevos secrets o variables de entorno para moneda.
- Si tocaste codigo, agregaste o corriste una validacion proporcional al flujo:
  frontend typecheck, test backend focalizado o prueba manual del caso afectado.
