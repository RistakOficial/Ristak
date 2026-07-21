# Integration Cron Rules

Esta guía existe para que cualquier IA/dev que agregue una integración nueva no
meta crons prendidos por default. Si una integración requiere credenciales,
OAuth, API keys, cuentas externas, sesiones QR o modo de pago activo, su cron
debe estar ligado al estado real de conexión.

## Regla Central

Un cron de integración externa no debe arrancar sólo porque arrancó el backend.
Debe arrancar cuando la integración esté conectada y apagarse cuando se
desconecte.

Esto aplica a integraciones tipo:

- Google Calendar.
- Meta.
- HighLevel.
- Stripe.
- Conekta.
- Mercado Pago.
- WhatsApp QR.
- Cualquier app futura que haga polling, sync, watchdog, reintento o cobro
  periódico contra un proveedor externo.

## Qué Cuenta Como Cron De Sistema

Un cron puede quedar siempre activo sólo si no depende de que un proveedor
externo esté conectado. Ejemplos:

- Automatizaciones internas.
- Mensajes programados.
- Acciones masivas de contactos.
- Recordatorios de citas.
- Automatizaciones internas de pagos.

Aunque estén siempre activos, cada job debe seguir siendo idempotente y seguro.

## Regla Extra Para Cobros

Un cron que puede cobrar dinero debe usar un lease distribuido con dueño,
renovación y liberación condicionada al mismo dueño. Debe operar en modo
`failOpen: false`: si la DB no puede demostrar que esta instancia tiene el lock,
el cron se omite. Un error de infraestructura nunca autoriza cobrar "de todos
modos".

El lease debe durar más que el intervalo normal y renovarse mientras el trabajo
siga activo. Además del lock global, cada pago debe reclamar atómicamente su
fila a `processing` y volver a comprobar que el flujo continúa activo dentro del
mismo `UPDATE`. Pausar o cancelar debe fallar con `409` si un cobro ya está en
proceso, en lugar de confirmar un estado engañoso.

Los crones de planes no hacen catch-up de fechas de negocio anteriores: mueven
esas cuotas a revisión y esperan una reprogramación explícita.

## Qué Cuenta Como Cron De Integración

Si el job necesita cualquiera de estos datos, es cron de integración:

- Access token, refresh token, API key, secret key o webhook secret.
- Account ID, location ID, business ID, calendar ID externo o phone number ID.
- Sesión QR o socket externo.
- Modo activo de pagos (`test` / `live`) para elegir credenciales.
- Cualquier estado remoto que no exista hasta que el usuario conecte la app.

Estos crons deben pasar por el runtime de integraciones.

## Archivos Que Debes Usar

- `backend/src/jobs/integrationCronRuntime.js`
  - Maneja el registro, encendido, apagado y estado activo de crons de
    integraciones.
- `backend/src/jobs/integrationCronRegistry.js`
  - Registra cada cron de integración con `name`, `label`, `provider`,
    `isEnabled`, `start` y `stop`.
- `backend/src/services/integrationConnectionStateService.js`
  - Contiene detectores locales para saber si una integración está conectada.
  - Los detectores deben leer la DB/config local. No deben llamar APIs externas
    para decidir si arranca un cron.
- `backend/src/server.js`
  - Debe llamar `syncRegisteredIntegrationCrons({ reason: 'startup' })` al
    arrancar. No agregues `startXxxCron()` directo para integraciones.

## Cómo Agregar Una Integración Nueva Con Cron

1. Crea el job con `startXxxCron()` y `stopXxxCron()`.
2. Haz que `startXxxCron()` sea idempotente: si ya está activo, no debe duplicar
   timers ni tareas de `node-cron`.
3. Haz que `stopXxxCron()` limpie `setInterval`, `setTimeout` o tareas de
   `node-cron`, y deje el módulo listo para arrancar de nuevo.
4. Agrega un detector `isXxxConnected()` en
   `integrationConnectionStateService.js`.
5. Registra el cron en `integrationCronRegistry.js`.
6. En el controller que conecta la integración, después de guardar credenciales,
   llama:

   ```js
   await syncRegisteredIntegrationCronsForProvider('provider-name', { reason: 'provider-connected' })
   ```

7. En el controller que desconecta la integración, después de limpiar
   credenciales, llama:

   ```js
   await syncRegisteredIntegrationCronsForProvider('provider-name', { reason: 'provider-disconnected' })
   ```

8. Si la integración depende de un modo activo, como pagos `test` / `live`,
   también sincroniza cuando cambie ese modo:

   ```js
   await syncRegisteredIntegrationCronsForProvider('provider-name', { reason: 'payment-mode-changed' })
   ```

## Reglas Para Detectores

Los detectores deben ser conservadores:

- Si falta una credencial clave, regresan `false`.
- Si hay bandera explícita de desconexión, regresan `false`.
- Si hay modos `test` / `live`, sólo regresa `true` cuando el modo activo tiene
  credenciales completas.
- Excepción para un outbox histórico con ambiente fijado por fila: el detector
  puede regresar `true` si existe al menos una credencial de ambiente, siempre
  que el worker seleccione la credencial exclusivamente desde el modo persistido
  en cada fila y bloquee cualquier modo desconocido. Gigstack usa esta variante
  porque una cola puede contener pagos Test y Live aunque el selector global haya
  cambiado después.
- Si falla la lectura local, el runtime debe tratarlo como desconectado.
- No hagas llamadas de red dentro del detector. El detector sólo decide si el
  cron debe existir, no si el proveedor está saludable.

## Intervalos Configurables

- Si el usuario puede cambiar la frecuencia, el valor debe persistirse en la
  base de datos y validarse en backend. No debe depender de una variable de
  entorno ni quedarse sólo en estado del frontend.
- Al cambiar una frecuencia, reprograma el job activo sin reiniciar el backend
  mediante `syncRegisteredIntegrationCronsForProvider(provider, {
  restartActive: true })`. El runtime vuelve a evaluar la conexión antes de
  arrancarlo; cambiar la frecuencia nunca debe encender una integración
  desconectada.
- El arranque del job puede ser asíncrono para leer su configuración. El runtime
  espera `start()` y `stop()` antes de publicar el estado activo.
- Meta Ads guarda su frecuencia en
  `app_config.meta_ads_sync_interval_minutes`. El default es 60 minutos y la UI
  ofrece 5, 10, 15 y 30 minutos; 1, 2, 3, 6 y 12 horas; y 1 día. Backend rechaza
  valores fuera de esas opciones. El timer se reprograma en caliente y cada tick
  usa un lock distribuido para no duplicar consultas durante deploys o con más
  de una instancia.

Para sincronizaciones periódicas no financieras, el heartbeat debe renovar el
lease mientras el job siga vivo y el TTL de recuperación por caída debe vencer
antes del siguiente tick. No lo iguales exactamente al intervalo: una diferencia
de milisegundos entre adquisición y próximo disparo puede saltarse un ciclo
completo. Los crones financieros conservan la regla más estricta de la sección
de cobros y nunca operan en `failOpen`.

## Tests Mínimos

Cada integración nueva con cron debe cubrir:

- Desconectada por default: el detector regresa `false`.
- Conectada con credenciales completas: el detector regresa `true`.
- Desconectada o con credenciales incompletas: el detector regresa `false`.
- Si aplica modo `test` / `live`: el cron sólo se activa para el modo activo.
- Si aplica la excepción de outbox por fila: prueba que cada ambiente usa sólo su
  credencial y que nunca existe fallback Test/Live.
- El runtime no duplica `start()` al sincronizar dos veces.
- El runtime llama `stop()` al desconectar.

Usa como referencia `backend/test/integrationCronGating.test.mjs`.
