# Auditoría de Producto Ristak — 06. UX Operativa

> **Pregunta central:** ¿Puede un usuario real **operar** este CRM sin confundirse, sin adivinar, sin quedarse atorado y sin tomar decisiones con datos que la propia interfaz le miente?
>
> La respuesta corta es: **no del todo**. Ristak funciona, pero está lleno de fricciones operativas, mensajes que no explican nada, acciones destructivas sin red de seguridad, dependencias ocultas que nadie te avisa, números que no cuadran entre pantallas y "funciones" que se ven completas en la UI pero por dentro no hacen nada.
>
> Este documento recoge **solo problemas de experiencia operativa**: estados de carga/vacío/error, confirmaciones, toasts, validaciones visibles, formularios largos o ambiguos, acciones destructivas, navegación, responsividad móvil, consistencia visual, nombres de botones, dependencias no explicadas, cosas que obligan a adivinar y cosas que deberían estar automatizadas. La seguridad, los crons y la arquitectura están en otros capítulos; aquí solo entran cuando **el usuario las sufre**.

---

## Resumen ejecutivo

El producto tiene tres clases de problema de UX que se repiten en casi todos los módulos:

1. **Funciones que mienten sobre lo que hacen.** El Campaign Builder de Meta deja "crear" campañas que nunca se crean; el editor de Automatizaciones permite publicar nodos y disparadores que el motor jamás ejecuta; la UI de Costos promete prorrateo automático que el backend nunca aplica; los KPIs dicen "neto" pero muestran bruto. El usuario configura, confirma, y no pasa nada — o pasa algo distinto a lo prometido.

2. **Errores y fallos silenciosos.** Mensajes 409 claros del backend que el frontend tapa con un toast genérico; tokens de Meta/HighLevel que expiran y dejan datos congelados sin avisar; recordatorios que no salen porque la plantilla no está aprobada y nadie te lo dice; pagos Conekta que quedan colgados sin reconciliar; citas que desaparecen sin explicación.

3. **Dependencias ocultas y cosas que obligan a adivinar.** Conectar Google "parece listo" pero no sincroniza nada hasta vincular cada calendario a mano; bloquear horarios no hace nada si no tienes HighLevel; el botón de recuperar contraseña te manda a la terminal de Render; en móvil, entrar con el correo de otra empresa falla sin decirte por qué.

A continuación, el detalle por área, citando pantallas, componentes y archivos reales de la evidencia.

---

## 1. Funciones que aparentan estar completas pero no operan

Esta es la categoría más grave de UX, porque el usuario **invierte tiempo y confía** en algo que no produce resultado.

### 1.1 Campaign Builder de Meta: "Confirmar" no crea ninguna campaña

`META-002` (confirmado). El módulo expone rutas `/api/meta/campaign-builder/*` que dejan al usuario armar plantilla, presupuesto, audiencia, creativo, previsualizar y **confirmar la ejecución**. Pero `executeMetaCampaignDraft` (`backend/src/services/metaCampaignBuilderService.js:949-1008`) **siempre** termina en `mcp_not_connected` o `adapter_missing`: no existe ninguna ruta de código que llame a `create_campaign`/`create_ad_set`/`create_ad` reales. El propio código se autoetiqueta como `preview_only_until_mcp_connected`.

> **Lo que vive el usuario:** llega hasta "confirmar campaña" creyendo que la creará, y solo recibe un mensaje técnico de que el MCP no está conectado. Una promesa de producto incumplida.

**Recomendación:** o se implementa la ejecución real, o la función se marca explícitamente como **"Solo vista previa / Beta"** en la UI y se bloquea el botón de confirmar hasta que exista. Hoy no hay nada que avise.

### 1.2 Automatizaciones: el editor deja publicar nodos que el motor ignora — y que cortan el flujo

`AUTO-001` (confirmado). El `nodeRegistry` del editor ofrece nodos que `executeNode` (`automationEngine.js:2659-2839`) **no sabe ejecutar**: `channel-messenger`, `channel-instagram`, `action-update-contact-field`, `action-delete-contact`, `randomizer` (aleatorizador A/B), `logic-actions-group`, `ai-step`, `data-calculator`, `data-format-*`, `action-appointment-upsert`. Todos caen al `default` y se marcan `skipped`.

Para nodos lineales se omiten en silencio (el flujo sigue, pero la acción nunca ocurre). **Lo grave:** para nodos con ramas propias (como el aleatorizador, que saca por `a`/`b`), el motor pide la arista por el handle `out` que no existe, no la encuentra, y marca la inscripción como `completed` — **todo lo que sigue al nodo nunca corre**. Y `validateFlowForPublish` no lo rechaza al publicar.

> **Lo que vive el usuario:** arma un flujo "Disparador → Aleatorizador 50/50 → WhatsApp en cada rama", lo publica **sin error**, inscribe un contacto, y no se envía nada. Cree que tiene un A/B test funcionando. No tiene nada.

### 1.3 Automatizaciones: disparadores fantasma que nunca reciben evento

`AUTO-002` (confirmado). El editor ofrece los disparadores **"Comentario en Facebook"**, **"Comentario en Instagram"**, **"Clic en anuncio de Facebook"** y **"Click-to-WhatsApp"** (`nodeRegistry.tsx:1086,1157,1226,1278`). Pero `triggerMatches` (`automationEngine.js:1089-1198`) no tiene ningún caso para esos eventos, y ningún controlador los emite jamás.

> **Lo que vive el usuario:** elige un disparador legítimo del catálogo ("se ejecuta cuando alguien comenta mi anuncio"), guarda, publica, y la automatización **queda muerta para siempre sin un solo aviso**. No hay forma de descubrir que ese disparador no está conectado a nada.

### 1.4 Automatizaciones: el nodo "Objetivo" no comprueba ningún objetivo

`AUTO-006` (probable). El nodo `logic-goal` siempre devuelve la salida "cumplido" sin evaluar nada (`automationEngine.js:2802-2803`), aunque el editor modela una rama "No cumplido". El patrón clásico de "si el contacto ya compró, sácalo del flujo" **no funciona**: un contacto que ya pagó sigue recibiendo la secuencia de seguimiento.

### 1.5 Costos: la UI promete prorrateo que el backend nunca hace

`RPT-001` (confirmado). La pantalla de Costos (`frontend/src/pages/Settings/Costs.tsx:452-453`) afirma textualmente que un costo es mensual fijo y que **"en reportes de días o años el valor se prorratea automáticamente"**. El backend (`dashboardController.js:206-222`) hace lo contrario: resta el **monto mensual completo** sin importar el rango. En un reporte de 1 día se descuenta la renta entera; en uno de 1 año se descuenta solo 1 mes.

> **Lo que vive el usuario:** configura una renta de \$20,000/mes confiando en el texto de la UI. Mira el dashboard de **hoy** y ve una ganancia neta absurdamente negativa. Mira el del año y ve una ganancia inflada. Los números nunca coinciden con lo prometido, y no hay forma de saber por qué.

### 1.6 Costos: la opción "Aplica sobre: Ganancias netas" se ignora en silencio

`RPT-003` (confirmado). La UI permite elegir que un costo aplique sobre `profit`, pero el backend solo maneja `revenue`. Si eliges "ganancias netas", el costo **desaparece del cálculo** y vale 0. El usuario configura un costo y nunca afecta sus métricas, sin aviso.

---

## 2. Errores y fallos silenciosos: el CRM no te dice qué salió mal

### 2.1 Contactos: el 409 de duplicado se traga y muestra un toast genérico

`CNT-003` (confirmado). Cuando intentas crear un contacto que ya existe, el backend responde con mensajes claros ("Ya existe un contacto con ese correo/teléfono"). Pero el frontend (`Contacts.tsx:1926-1935`) muestra un toast fijo: **"Hubo un problema al guardar... verifica los datos"**, ignorando el mensaje real.

> **Lo que vive el usuario:** no entiende por qué falló. Reintenta una y otra vez "verificando los datos" (que están bien), en lugar de buscar el contacto que ya existe — que es justo lo que el backend le estaba pidiendo hacer.

**Detalle:** lo irónico es que la misma pantalla **sí** propaga `error.message` en la edición de contacto. Es inconsistencia pura.

### 2.2 Contactos: editar el email a uno duplicado revienta con error técnico opaco

`CNT-004` (confirmado). Editar el teléfono de un contacto al de otro **fusiona** (con su propio problema grave, ver §3.1). Pero editar el **email** a uno duplicado lanza un error de constraint que cae a un **500 genérico "Error actualizando contacto"**. Comportamiento inconsistente y opaco: el usuario no sabe que el problema es un email repetido ni cómo corregirlo.

### 2.3 Meta: el token expira y los datos se congelan sin un solo aviso

`META-003` (confirmado). El backend calcula `valid/daysUntilExpiry`, pero `MetaAdsIntegration.tsx` **nunca** llama a `/api/meta/verify-token` ni muestra ese estado. Cuando el token caduca o se revoca, el cron falla en silencio y la UI sigue mostrando datos viejos.

> **Lo que vive el usuario:** ve métricas congeladas, cree que "la app no jala", y no hay ningún banner que diga "tu token expiró, renuévalo aquí". El plumbing existe a medias (hay un `verifyToken()` en el servicio del frontend) pero **nunca se invoca**.

### 2.4 HighLevel: "conexión exitosa" aunque falten permisos clave

`GHL-010` (probable). Al guardar el token de HighLevel solo se prueba `GET /locations/:id`. Un token puede pasar esa prueba pero carecer de scopes de calendarios, conversaciones o invoices. El usuario ve **"conexión exitosa"**, pero luego no aparecen citas ni chats, sin ninguna explicación accionable de que faltan permisos en el token.

### 2.5 Recordatorios de cita: no salen y el usuario no se entera

`NOTI-008` (probable). Si la plantilla del recordatorio no está `APPROVED` en YCloud y no hay fallback QR, cada cita genera una fila de error **solo en logs/DB**. La pantalla de recordatorios (`getAppointmentRemindersOverview`) **no expone estos fallos**.

> **Lo que vive el usuario:** activó los recordatorios, cree que sus clientes los reciben, y en realidad **ninguno se envía** hasta que la plantilla se apruebe (proceso asíncrono que puede tardar). No hay nada que se lo diga.

### 2.6 Conekta: el pago queda "pendiente" para siempre y la página lo promete falsamente

`PAY2-002` (confirmado). No existe webhook ni polling de órdenes Conekta. Si un cliente paga por OXXO/SPEI/3DS (asíncronos), el pago queda `pending` y **nunca pasa a `paid`** en la app. Peor: la página pública de pago (`PublicPayment.tsx:311`) dice textualmente **"Esta página se actualizará cuando se confirme"** — y nunca lo hace, porque no hay mecanismo que lo cumpla.

> **Lo que vive el usuario final:** paga en el OXXO horas después, vuelve a la página, ve "pendiente" indefinidamente. El negocio nunca ve el pago, no se dispara comprobante ni factura, y alguien tiene que conciliar a mano.

### 2.7 MercadoPago: el comprobante automático solo sale para Conekta, no para MP

`PAY2-003` (confirmado). El merchant activa una sola opción global "enviar comprobante al recibir pago". Funciona para Conekta pero **no para MercadoPago** (`updatePaymentFromMercadoPagoPayment` nunca encola el `receipt`). Comportamiento inconsistente según la pasarela, sin que el usuario sepa por qué a unos clientes les llega y a otros no.

### 2.8 MercadoPago: volver del checkout muestra "pendiente" aunque ya se pagó

`PAY2-004` (confirmado). El `back_url` de MP redirige a `?mercadopago=return`, pero la página pública solo fuerza sincronización con `?payment=return` (el de Stripe). Resultado: tras pagar en el checkout hospedado de MP y volver, la página **puede seguir mostrando "pendiente"**, lo que invita al cliente a reintentar (doble cargo) y genera soporte innecesario.

### 2.9 Mensajes salientes de WhatsApp que fallan **desaparecen del chat**

`WA-009` (probable). Cuando un envío por API falla y no hay fallback QR, no se persiste el mensaje. El operador ve un toast de error pero **no queda ningún rastro en el hilo del chat** de qué mensaje no salió. No hay forma de auditar ni reintentar desde la UI.

> **Lo que vive el usuario:** en un CRM necesitas ver qué mensajes no se enviaron para reenviarlos. Aquí simplemente se evaporan.

### 2.10 Dashboard: citas y asistencias caen a 0 si el token de HighLevel falla

`RPT-007` (probable). Las gráficas de citas/asistencias dependen del token de HighLevel. Si falta o expira, devuelven **0 citas** sin distinguir "cero real" de "integración rota". El usuario cree que no hubo citas, no que la integración falló, y no hay estado "Conecta HighLevel / Token expirado".

---

## 3. Acciones destructivas sin red de seguridad

### 3.1 Editar un teléfono **borra otro contacto** en silencio (el peor caso de UX)

`CNT-001` (confirmado). Si editas el teléfono de un contacto y pones uno que pertenece a **otro** contacto, el sistema fusiona y ejecuta `DELETE FROM contacts` (hard delete) del otro registro, **sin confirmación, sin aviso, sin papelera**. El frontend (`handleUpdateContactIdentity`, `Contacts.tsx:1075-1106`) solo refleja el contacto editado.

> **Lo que vive el usuario:** está corrigiendo rutinariamente un teléfono mal escrito. Sin saberlo, destruye otro registro de cliente (irreversible). Más tarde: *"¿dónde está fulano? ¡desapareció!"*. Y peor (`CNT-002`, confirmado): la fusión **pierde** tags, custom fields, vínculo a HighLevel y número de WhatsApp preferido del contacto absorbido.

**Recomendación operativa:** ante coincidencia de teléfono, **detener** la operación y mostrar un diálogo claro: *"Este teléfono ya pertenece a [Otro Contacto]. ¿Fusionar ambos registros?"* — con preview de lo que se conserva y se pierde. Nunca fusionar+borrar en automático.

### 3.2 Cancelar un evento en Google **borra la cita en Ristak** (incluidas las propias)

`GCAL-001` (confirmado). Si alguien con acceso al calendario de Google cancela un evento, `syncGoogleEventsToLocal` hace **hard delete** de la cita en el CRM (`deleteLocalAppointment`), no una marca de cancelación. Se pierde el contacto ligado, notas y trazabilidad.

> **Lo que vive el usuario:** una acción accidental en Google (un calendario que muchos a veces comparten) **borra datos de negocio en Ristak** sin rastro. El sistema secundario gana destructivamente sobre el sistema de registro.

### 3.3 Borrar un contacto es **hard delete en cascada** con confirmación débil

`CNT-007` (confirmado). `deleteContact` ejecuta `DELETE FROM contacts` con CASCADE (borra pagos, citas, relaciones). No hay papelera ni soft delete, y la confirmación es solo escribir una palabra. Y por `DB-003` (confirmado), el FK `payments.contact_id` es `ON DELETE CASCADE`: **borrar un contacto destruye su historial financiero**, lo que además altera los KPIs de ingresos del dashboard.

> **Lo que vive el usuario:** borra un "contacto duplicado" y, sin esperarlo, pierde transacciones ya cobradas. No hay advertencia especial para clientes con compras/LTV.

### 3.4 Borrado masivo de contactos: sin progreso, sin cancelar, borrados a medias

`CNT-011` (confirmado). El bulk delete borra contactos **uno por uno** en un `for-await` sin barra de progreso ni opción de cancelar. Borrar decenas/cientos deja la UI en "cargando" largo rato; si se cierra la pestaña, queda a medias y solo se ve un total al final (sin saber cuáles faltaron).

### 3.5 La IA puede **cancelar citas confirmadas** si OpenAI falla (severidad crítica)

`NOTI-001` (confirmado, **crítico**). En la confirmación de cita por IA, si OpenAI falla o no hay API key, el clasificador devuelve `null` y el resultado cae a `'ambiguous'`. Si el usuario configuró `no_confirm_action='cancel_appointment'`, **la cita se cancela aunque el cliente haya respondido "sí, confirmo"**.

> **Lo que vive el usuario (y su paciente/cliente):** un hipo de OpenAI cancela citas reales de gente que sí confirmó. En contexto médico esto es grave. El comportamiento por defecto ante fallo del modelo **debe** ser "no tocar nada", no "cancelar".

---

## 4. Dependencias ocultas: cosas que requieren configuración previa que nadie te explica

### 4.1 Conectar Google Calendar "parece listo" pero no sincroniza nada

`GCAL` — flujo "Conectar Google Calendar". Tras el OAuth, la UI da sensación de "conectado", pero **nada se sincroniza** hasta que el usuario vincula manualmente **cada** calendario de Ristak con uno de Google (`updateLocalCalendarGoogleSync`). El usuario no elige calendario durante el OAuth, y no hay aviso de que falta ese paso.

> **Lo que vive el usuario:** conecta Google, asume que ya jala, y sus citas no aparecen en ningún lado. Tiene que adivinar que falta vincular calendario por calendario.

### 4.2 Bloquear horarios **no hace nada** si no tienes HighLevel

`APT-004` (confirmado). Los blocked slots dependen 100% de HighLevel: sin `locationId+accessToken`, `getBlockedSlots` devuelve `[]` y crear un bloqueo da 400. No existe almacenamiento local de bloqueos, y `getLocalFreeSlots` nunca los considera.

> **Lo que vive el usuario (instalación solo-Ristak o Ristak+Google):** bloquea sus vacaciones o su horario de comida, **no pasa nada** (la lista sale vacía), y la app sigue ofreciendo y aceptando citas en esos horarios. Termina con citas agendadas en horarios que creía bloqueados.

### 4.3 Recuperar contraseña te manda a la **terminal de Render**

`AUTH-010` y `AUTH-002` (confirmados). El botón "¿Olvidé mi usuario o contraseña?" en `/login` despliega un instructivo técnico para ejecutar un comando en el **Render Shell**. No hay flujo real de "olvidé mi contraseña" por correo.

> **Lo que vive el usuario:** es un dueño de negocio no técnico. Olvidó su contraseña. La única salida que le ofrece la app es ejecutar comandos en una terminal de servidor que no tiene ni sabe usar. Queda **bloqueado de su propio CRM** hasta que un técnico intervenga. (Aparte del problema de seguridad de exhibir `admin/admin123`, que está en el capítulo de seguridad.)

### 4.4 El estado inicial de una cita es "Confirmada" ignorando el `autoConfirm` del calendario

`APT-008` (probable). Al crear una cita desde el panel, siempre nace `confirmed`, aunque el calendario tenga `autoConfirm=false` (la reserva pública sí lo respeta). Como el recordatorio de tipo "confirmación" se omite si ya está confirmada, las citas creadas por el equipo **no pasan por el flujo de confirmación** que el usuario configuró — inconsistencia silenciosa entre citas internas y públicas.

---

## 5. Cosas que obligan a adivinar (y que deberían estar automatizadas)

### 5.1 Reprogramar una cita: el recordatorio nunca se reenvía a la nueva hora

`APT-003` (confirmado). Al reprogramar, no se limpia `appointment_reminder_sends`, así que si ya existía un envío para esa cita, **el recordatorio nunca se recalcula para la nueva fecha**.

> **Lo que vive el usuario:** reprograma la cita de un cliente y **da por hecho** que el recordatorio saldrá a la nueva hora. No sale (o salió a la hora vieja). Aumentan los no-shows, y nadie sabe por qué.

### 5.2 Estado "Reprogramada" puramente cosmético

`APT-005` (confirmado). El modal ofrece el estado "Reprogramada", pero cambiar la fecha/hora **no** lo marca automáticamente, y ese estado **no se trata en ningún lado** del backend. Es decorativo. El usuario asume que reflejará la realidad y afectará reportes; no afecta nada.

### 5.3 Cambios de plan no se reflejan hasta cerrar y reabrir sesión

`LIC-008` (confirmado). Las features de licencia se capturan **solo al login**. Si el cliente compra un upgrade, la función nueva **no aparece** hasta re-login, y no hay aviso de "recarga para activar tu nueva función".

> **Lo que vive el usuario:** paga un upgrade, no ve la función nueva, y cree que **no funciona** o que le cobraron mal. Soporte innecesario. (El endpoint `/api/license/status` existe pero está muerto, nadie lo consume.)

### 5.4 Acciones masivas de WhatsApp sobre contactos sin teléfono fallan en silencio

`CNT-006` (probable). Se permite crear contactos sin teléfono, y los lotes/automatizaciones de WhatsApp no advierten de antemano cuántos contactos no tienen número. Fallan **por ítem**, individualmente, después de mandar.

> **Lo que vive el usuario:** selecciona 500 contactos para un envío masivo, confirma, y muchos fallan silenciosamente porque no tenían teléfono. La selección no le avisó antes.

### 5.5 Sincronización a HighLevel bloquea el guardado local de custom fields

`CNT-008` (confirmado). Si editas un custom field y HighLevel está caído/con token expirado, el backend hace `return 502` **antes** de guardar nada localmente. El usuario no puede editar campos personalizados cuando GHL falla, aunque el CRM local debería poder guardar y reintentar después.

---

## 6. Móvil: tenant, login y notificaciones

### 6.1 Android no puede iniciar sesión en producción (crítico)

`MOB-001` (confirmado, **crítico**). El WebView de Android usa origin `https://localhost`, que **no está** en la allowlist CORS del installer. La resolución de tenant (`POST /api/mobile/resolve`) sería rechazada, por lo que **no se puede resolver el backend ni loguear** en el binario Android. iOS sí pasa.

> **Lo que vive el usuario:** abre la app Android, intenta entrar con su correo, y simplemente **no puede**.

### 6.2 Entrar con el correo de otra empresa falla sin explicar por qué

`MOB-003` (confirmado). `/phone/login` **no re-resuelve** el tenant por correo: pega contra el backend ya cacheado. Si en ese dispositivo ya se usó la empresa A y escribes credenciales válidas de la empresa B, recibes **"usuario o contraseña incorrectos"** (que están bien).

> **Lo que vive el usuario:** dueño de otra instalación usa un dispositivo compartido, mete credenciales correctas, y el sistema le dice que están mal. El único escape es el botón "Cambiar empresa", que **existe pero no es descubrible** ante un error de credenciales.

### 6.3 Activar notificaciones falla por timeout aunque el permiso esté concedido

`MOB-005` (confirmado). El registro de push nativo se da por "denegado" si el token no llega en 16s. En redes lentas o primeras instalaciones, APNs/FCM puede tardar más. El usuario ve que "las notificaciones no se activaron" aunque sí dio permiso — justo la feature que el onboarding más insiste.

### 6.4 Toggles de notificación que dicen "este celular" pero afectan a TODO el equipo

`MOB-006` (probable). En `PhoneSettings`, varios toggles (mensajes de chat, sonido, vibración) usan config **global del tenant**, no preferencias por usuario, pese a copys del estilo "este celular".

> **Lo que vive el usuario:** un empleado apaga "Mensajes del chat" creyendo que silencia su propio teléfono, y **deja sin notificaciones a todo el equipo** sin saberlo.

### 6.5 Secciones premium en móvil muestran ceros en vez de "no incluido en tu plan"

`MOB-009` (requiere-verificación). En `PhoneApp`, las secciones de Publicidad/Reportes/Analíticas, ante un 403 por feature no contratada, devuelven arrays vacíos y muestran **métricas en cero**, en vez de comunicar que la función no está en el plan. El usuario interpreta "no tengo datos" cuando en realidad es "no tengo la licencia".

### 6.6 Fechas en hora local del dispositivo, no del negocio

`MOB-007` (probable). PhoneApp y la caché diaria usan la hora **local del dispositivo**, mientras el backend filtra por la zona de la cuenta. Un usuario en otra zona (o viajando) verá un "hoy" desfasado respecto al escritorio: citas o pagos del día equivocado.

---

## 7. Consistencia visual y de datos: cuando dos pantallas no cuadran

### 7.1 (Aclaración) "Ingresos Netos" sí descuenta los reembolsos — hallazgo refutado

`RPT-002` se reportó inicialmente como "los KPIs dicen neto pero muestran bruto sin restar reembolsos", pero fue **refutado en la verificación adversarial** y **no se cuenta como problema**: cuando un pago se reembolsa, su fila **muta a `status='refunded'`** (`webhooksController.js:1508`, `stripePaymentService.js:2731`), y los ingresos exitosos excluyen ese estado (`SUCCESS_PAYMENT_STATUSES` no incluye `refunded`). Por tanto el reembolso ya **no cuenta** como ingreso; restarlo de nuevo sería doble deducción. Se deja la aclaración para que el lector no lo confunda con un defecto de UX.

> El problema real de los KPIs financieros sí confirmado es **`RPT-001`** (costos fijos sin prorratear, §1.5) y **`RPT-003`** (costos `profit` ignorados, §1.6).

### 7.2 El número de "Citas" del funnel no coincide con el de la gráfica de citas

`RPT-006` (confirmado). El funnel cuenta citas por una fecha (cuándo se agendó) y la gráfica por otra (cuándo se registró el contacto). **Dos números distintos de "Citas" en el mismo dashboard**, sin explicación. El usuario pierde confianza en los datos.

### 7.3 CPM y CTR sistemáticamente inflados

`META-001` (confirmado). CPM y CTR se calculan con `reach` (usuarios únicos) en vez de `impressions`. Como `reach ≤ impressions`, ambas métricas quedan **infladas** y **no reconcilian con Meta Ads Manager**.

> **Lo que vive el usuario:** compara Ristak contra el panel oficial de Meta, ve números distintos, deja de confiar en la app y puede apagar campañas buenas por leer mal su rendimiento.

### 7.4 ROAS diario incoherente en la vista de atribución

`RPT-005` (probable). En la vista de atribución, el ingreso se agrupa por fecha de registro del contacto pero el gasto siempre por fecha del anuncio. Los dos ejes están en líneas de tiempo distintas, así que el ROAS por día es engañoso justo en la vista pensada para medir atribución.

---

## 8. Otros roces operativos menores

- **`AUTH-001` (confirmado) — Sin límite de intentos de login.** No es solo seguridad: un usuario que olvidó parte de su contraseña puede martillar sin bloqueo, pero tampoco hay ningún feedback de "demasiados intentos, espera". (El impacto principal está en el capítulo de seguridad.)
- **`LIC-005` (confirmado) — Fallos silenciosos en módulos premium.** Si un usuario llega a una ruta premium no incluida (deep link, UI no del todo oculta), recibe un 403 `feature_not_available` que el frontend **no interpreta**: ve un error genérico o pantalla rota, no un mensaje de "no incluido en tu plan".
- **`AUTO-010` (probable) — Variables `{{...}}` mal escritas se borran sin avisar.** Si escribes `{{nombre_contacto}}` en vez de `{{first_name}}`, se renderiza vacío. El cliente recibe **"Hola ,"** en vez de "Hola Juan,". El editor solo valida tokens del catálogo, no errores de tecleo.
- **`HighLevel sync` (whatsIncomplete) — "Sincronizando..." sin progreso visible.** Al conectar HighLevel, la respuesta dice "Sincronizando..." pero el usuario no ve avance salvo que consulte `/sync/progress`; si falla, no hay notificación.
- **`PAY2-007` (probable) — Recordatorios de pago no salen para links sin fecha de vencimiento.** El merchant activa recordatorios, crea un link de pago suelto (que no fija `due_date`), y el recordatorio **nunca se envía**, sin aviso de por qué.
- **`RPT-008` (confirmado) — Reportes sin paginación.** Listas de transacciones y contactos sin `LIMIT`: en cuentas grandes el reporte puede tardar, timeoutear o saturar memoria (instancias de 512MB).
- **`MOB-008` / `NOTI-005` (confirmados) — Apagar el dispositivo push de otro.** La baja de suscripción/dispositivo no valida pertenencia; un usuario podría silenciar las notificaciones de otro (DoS de notificaciones).

---

## 9. Veredicto: ¿puede un usuario real operar Ristak sin confundirse?

**Parcialmente, y con cicatrices.** Un operador con experiencia y mucha paciencia logra usar el CRM, pero el producto le exige **adivinar demasiado** y le **esconde demasiados fallos**:

| Síntoma operativo | Ejemplos confirmados |
|---|---|
| Funciones que no hacen lo que prometen | Campaign Builder (META-002), nodos/disparadores de automatización (AUTO-001/002), prorrateo de costos (RPT-001) |
| Errores tapados con mensajes genéricos | Duplicado de contacto (CNT-003), email duplicado a 500 (CNT-004), token Meta expirado sin aviso (META-003) |
| Acciones destructivas sin red | Edición de teléfono que borra contacto (CNT-001/002), cancelar en Google borra cita (GCAL-001), IA cancela citas confirmadas (NOTI-001, crítico) |
| Dependencias ocultas | Vincular cada calendario Google a mano, bloqueos solo con HighLevel (APT-004), recuperación por terminal de Render (AUTH-010) |
| Cosas que deberían automatizarse | Reprogramar no reenvía recordatorio (APT-003), cambios de plan no se reflejan (LIC-008) |
| Datos que se contradicen entre pantallas | Costos fijos sin prorratear (RPT-001), citas funnel vs gráfica (RPT-006), CPM/CTR inflados (META-001) |
| Móvil roto o confuso | Android sin login (MOB-001, crítico), correo de otra empresa falla sin explicar (MOB-003) |

**Las dos prioridades de UX más urgentes**, por su capacidad de causar daño real y confusión, son:

1. **Acciones destructivas silenciosas** (CNT-001, GCAL-001, NOTI-001): un usuario haciendo su trabajo normal puede destruir datos o cancelar citas reales sin saberlo. Esto erosiona la confianza más rápido que cualquier otra cosa.
2. **Funciones que mienten** (META-002, AUTO-001/002, RPT-001/RPT-003): el usuario invierte tiempo configurando algo que no funciona o que reporta datos falsos, y lo descubre tarde — a veces nunca.

El resto son fricciones que, sumadas, hacen que operar Ristak se sienta como **caminar sin red**: nada te avisa cuando algo se rompe, varias palancas no hacen lo que dicen, y de vez en cuando un movimiento rutinario borra algo importante.

---

*Documento basado exclusivamente en hallazgos del corpus de auditoría con `verifyStatus` distinto de "refutado". Los hallazgos marcados como "probable" o "requiere-verificacion-manual" se señalan como tales en el texto.*
