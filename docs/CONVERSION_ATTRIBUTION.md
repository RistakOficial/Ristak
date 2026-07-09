# Atribucion de conversiones y superficie Meta CAPI

Documento obligatorio para cualquier cambio en atribucion de compras/citas o en
el envio de eventos de conversion a Meta.

## La regla de oro

> La atribucion la decide el ultimo anuncio valido; el payload de Meta lo decide
> la superficie real donde ocurrio la conversion.

Son dos conceptos SEPARADOS que nunca deben mezclarse:

1. **Atribucion interna** — a que anuncio/canal le damos credito por la compra
   o cita. La decide el **ultimo paid/ad touch valido** del contacto anterior a
   la conversion. Un touch organico (visita web sin anuncio, mensaje directo
   sin referral) se guarda como historial pero **nunca roba el credito**.
2. **Superficie real de conversion** — donde ocurrio la conversion de verdad
   (`website`, `whatsapp`, `messenger`, `instagram`). Decide el `action_source`
   y el formato del payload de Meta CAPI. **Nunca se falsifica**: si la compra
   fue por WhatsApp, el evento dice WhatsApp aunque el credito sea de un anuncio
   web; si fue en el checkout web, dice website aunque el ultimo anuncio haya
   sido de Messenger.

## Adquisicion del contacto vs retouches

`contacts.attribution_ad_id` y `contacts.attribution_ad_name` son la atribucion
de **primer registro / adquisicion inicial** del contacto. Ese dato se congela
cuando el contacto obtiene su primer anuncio real y no debe moverse por mensajes
posteriores, retargeting, reactivaciones ni nuevos marcadores `rstkad_id`.

Los anuncios posteriores del mismo contacto se guardan como touches de historial
en `whatsapp_api_messages`/`whatsapp_api_attribution`, `whatsapp_attribution`,
`sessions` o `meta_social_messages` segun el canal. Esos touches posteriores SI
pueden ganar credito de una compra/cita si son el ultimo paid touch valido antes
de la conversion, pero no deben pisar la adquisicion inicial del contacto.
En el chat desktop, cada touch entrante de WhatsApp que traiga senal propia de
anuncio puede mostrar su preview en ese globo; esa preview no cambia
`contacts.attribution_ad_id` ni debe inventarse desde la atribucion historica del
contacto si el mensaje fue organico.

Cuando un mensaje de WhatsApp trae un `source_id` oficial y tambien un marcador
`rstkad_id=<ad_id>!`, el backend resuelve el conflicto contra `meta_ads` usando
el dia local del negocio: si solo uno de los dos IDs existe en `meta_ads` ese
dia, gana ese ID; si ambos existen, gana el `source_id` oficial; si ninguno
existe, se conserva el `source_id` oficial como default y el payload crudo queda
disponible para auditoria/backfill.

La vista de reportes **Identificados de anuncios** y la pagina de Publicidad usan
`contacts.created_at` + `contacts.attribution_ad_id`, validando que el anuncio
exista en `meta_ads` el mismo dia local en que se creo el contacto. Por eso
`contacts.attribution_ad_id` debe permanecer estable: representa de que anuncio
nacio el registro, no el ultimo anuncio que reabrio la conversacion.

Para datos historicos afectados por imports o retouches anteriores, el backend
agenda una vez el backfill
`repairWhatsAppApiContactIdentityFromMessages({ limit: 0 })` en segundo plano,
sin bloquear el arranque. Al terminar queda marcado en
`app_config.whatsapp_api_first_ad_attribution_backfill_version`; si esa version
ya existe, el arranque omite la barrida historica. El backfill revisa el
historial WhatsApp API en orden cronologico y, si el contacto quedo con un
anuncio posterior que existe en el historial, restaura el primer anuncio real
como `contacts.attribution_ad_id`/`attribution_ad_name`/`ctwa_clid`. Los
retouches posteriores siguen vivos en `whatsapp_api_messages` y
`whatsapp_api_attribution`. El mismo backfill tambien corrige touches historicos
cuando el `detected_source_id` guardado venia del candidato incorrecto y el
marcador `rstkad_id` si coincide con un anuncio vivo ese dia.

## Servicio canonico

`backend/src/services/conversionAttributionService.js`:

- `findLastPaidTouch({ contactId, conversionTime })` — barre los cuatro silos
  de touches y devuelve el paid touch mas reciente. Un touch dentro de la
  ventana (anterior a la conversion) de cualquier silo le gana a un fallback
  fuera de ventana de otro silo. El predicado paid va en el WHERE de SQL
  (antes del LIMIT de escaneo) para que muchos pageviews organicos no
  entierren el touch pagado:
  - **Web** (`sessions`): paid si tiene `fbclid`, otros click IDs (`gclid`,
    `msclkid`, `ttclid`, `wbraid`, `gbraid`), `campaign_id`/`adset_id`/`ad_id`,
    `channel='paid'` o `utm_medium` de pago (cpc/ppc/paid). **`fbp` solo NO
    cuenta como paid**: el pixel se lo pone a cualquier visitante, organico
    incluido. **`fbc` solo cuenta si la cookie nacio con esa sesion** (el
    timestamp embebido en `fb.1.<creationMs>.<fbclid>` cae a ±6h del inicio de
    la sesion): la cookie `_fbc` persiste ~90 dias y se re-manda en cada
    pageview, y una visita organica semanas despues del click no debe robar
    credito.
  - **WhatsApp** (`whatsapp_attribution` + `whatsapp_api_messages`/
    `whatsapp_api_attribution`): mensajes entrantes con `ctwa_clid`/referral de
    anuncio detectado.
  - **Messenger/Instagram** (`meta_social_messages`): DMs entrantes cuyo
    `referral_json` trae `ad_id`, `source='ADS'` o `ads_context_data`
    (anuncios Click-to-Messenger / Click-to-Instagram).
  - **Fallback legacy**: `contacts.attribution_ctwa_clid`/`attribution_ad_id`
    (first-touch historico, sin timestamp) solo si no hay ningun touch con
    timestamp.
- `detectConversionSurface({ contactId, explicitSurface, payment })`:
  - `explicitSurface` gana (el call site sabe la verdad: checkout publico y
    bookings del widget web SON `website`).
  - Un pago con URL de checkout / `public_payment_id` es `website`.
  - Si no, la superficie es la conversacion mas reciente del contacto
    (WhatsApp / Messenger / Instagram) antes de la conversion.
  - Sin actividad de mensajeria → `website` (el sender de sitio degrada
    honestamente el `action_source` a `phone_call`/`physical_store`/
    `system_generated` para pagos manuales sin URL).
- `resolveConversionAttribution({...})` — combina ambos y devuelve
  `attributionChannel`, `attributionSource` (`paid_ad`/`organic`), datos del
  touch, `conversionSurface`, `metaActionSource` y `metaMessagingChannel`.
- `persistPaymentConversionAttribution` / `persistAppointmentConversionAttribution`
  — guardan el snapshot en `payments`/`appointments`.

## Snapshot por conversion

El snapshot es **write-once**: se escribe la primera vez que se procesa la
conversion (`WHERE attribution_channel IS NULL`) y los re-disparos (echos de
webhooks GHL, reintentos, resincronizaciones de invoices) no lo recalculan ni
lo sobreescriben. Los triggers completan los payloads "flacos" de los callers
cargando el row real de `payments`/`appointments` (URL de checkout, `paid_at`,
`date_added`) antes de resolver superficie y ventana temporal.

Columnas en `payments` y `appointments` (se escriben al crear la conversion,
aunque el CAPI este apagado o el envio se salte — en citas el snapshot corre
ANTES de los gates de configuracion, igual que en compras):

`attribution_channel`, `attribution_source`, `attribution_touch_type`,
`attribution_touch_at`, `attribution_campaign_id`, `attribution_adset_id`,
`attribution_ad_id`, `attribution_ad_name`, `attribution_ids_json`,
`conversion_surface`.

## Payloads por superficie

| Superficie | action_source | user_data clave |
| --- | --- | --- |
| website | `website` (+`event_source_url`) | `em`, `ph`, `fbp`, `fbc` (de la ultima sesion web si es server-side) |
| whatsapp | `business_messaging` + `messaging_channel=whatsapp` | `ph`, `ctwa_clid` (si existe), `page_id`, `whatsapp_business_account_id` |
| messenger | `business_messaging` + `messaging_channel=messenger` | `page_scoped_user_id` + `page_id` |
| instagram | `business_messaging` + `messaging_channel=instagram` | `ig_sid` + `ig_account_id` |

Notas:

- WhatsApp **sin** `ctwa_clid` (conversacion organica que convierte): el evento
  se manda igual como `business_messaging` con matching por telefono, con
  warning en logs. No se falsifica a website.
- Messenger/Instagram sin identidad (PSID/IGSID): el evento se salta con motivo
  `missing_messaging_identity` en `meta_conversion_event_logs`. No hay fallback
  a otra superficie.
- La atribucion interna viaja como metadata en `custom_data` (`ad_id`,
  `ad_name`, `campaign_id`, `adset_id`, `attribution_channel`) sin importar la
  superficie. Los IDs del touch solo se usan como identidad de `user_data`
  cuando el touch es del MISMO canal que el evento (un IGSID nunca viaja como
  PSID de Messenger).
- Anti doble conteo de citas: el sender de sitio
  (`sendCalendarBookingSiteMetaEvent`) marca `meta_schedule_event_sent` en el
  contacto al exito, de modo que un echo posterior del webhook GHL de la misma
  cita no dispare una segunda conversion por business_messaging.
- `currency` de `Purchase` es SIEMPRE la moneda de la cuenta
  (`app_config.account_currency`), ver `docs/CURRENCY_GUIDELINES.md`.

## Canal configurado vs smart

- `smart` (default) = superficie real detectada automaticamente (esta pagina).
- Un canal explicito (`site`, `whatsapp`, `messenger`, `instagram`) en
  `meta_payment_purchase_event_config.channel` o en `customEvents.channel` del
  calendario es un **override forzado por el usuario**: se respeta tal cual y
  queda documentado que puede no coincidir con la superficie real. El snapshot
  interno guarda siempre la superficie detectada.
- El pixel publico del checkout siempre dispara para pagos de checkout y
  comparte `event_id` con el evento server-side (Meta deduplica); solo se
  suprime con override explicito de mensajeria.

## Escenarios canonicos (tests)

`backend/test/conversionAttribution.test.mjs` cubre la tabla completa:

| Historia | Superficie | Ultimo anuncio valido | Payload Meta |
| --- | --- | --- | --- |
| WhatsApp organico → Web ad → Compra WhatsApp | whatsapp | Web ad | business_messaging/whatsapp |
| Web ad → Messenger ad → Compra Web | website | Messenger ad | website |
| WhatsApp ad → Messenger organico → Compra Messenger | messenger | WhatsApp ad | business_messaging/messenger |
| Web organico → Compra Web | website | ninguno (organico) | website |
| Instagram ad → Compra WhatsApp | whatsapp | Instagram ad | business_messaging/whatsapp |

Ademas: citas smart via webhook/agente (superficie por conversacion, snapshot en
`appointments`), citas sin mensajeria (evento `Schedule` website server-side con
`fbp`/`fbc` de la ultima sesion) y unit tests de `findLastPaidTouch` (un touch
organico posterior no roba credito) en el mismo archivo, mas
`backend/test/metaPaymentPurchaseEvent.test.mjs` para checkout + pixel.

## Que NO hacer

- No uses "ultimo mensaje" como atribucion: los mensajes organicos no roban
  credito.
- No enrutes el payload CAPI por la atribucion del contacto (eso era el bug que
  este sistema reemplaza).
- No agregues fallbacks entre superficies "para que el evento salga": un evento
  con `action_source` falso es peor que un evento saltado con log.
