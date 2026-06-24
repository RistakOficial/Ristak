# Flujos de usuario — Auditoría de producto Ristak

> Documento de la auditoría de producto del CRM **Ristak**. Cubre **22 módulos** auditados. Para cada flujo describimos el recorrido paso a paso desde la perspectiva de un usuario real (que no conoce el código) y separamos: **Qué funciona**, **Qué está incompleto**, **Qué puede confundir al usuario** y **Qué puede romperse**.
>
> Notas de método:
> - Solo se listan hallazgos **confirmados** o **probables** tras la verificación adversarial. Los marcados `requiere-verificacion-manual` se señalan explícitamente.
> - Hallazgos **refutados** NO se reportan como problemas. En particular, **RPT-002** ("Ingresos Netos no resta reembolsos") fue refutado: los ingresos ya excluyen pagos `refunded` porque el reembolso cambia el `status` del pago, y restarlo de nuevo provocaría doble deducción.
> - Hallazgos duplicados entre módulos se consolidan citando ambos IDs (p. ej. el patrón "cron sin claim atómico" aparece como AUTO-003 / CRON-004; "JWT 30 días sin revocación" como AUTH-003 / SEC-007; "push expone contactos ocultos" como NOTI-004 / MOB-002).

---

## Índice de flujos

1. [Login, setup y SSO](#1-login-setup-y-sso)
2. [Sesión, logout y recuperación de cuenta](#2-sesión-logout-y-recuperación-de-cuenta)
3. [Licencia y feature flags (qué ve según su plan)](#3-licencia-y-feature-flags-qué-ve-según-su-plan)
4. [Roles de equipo y aislamiento de datos](#4-roles-de-equipo-y-aislamiento-de-datos)
5. [Contactos: crear, editar, fusionar, borrar](#5-contactos-crear-editar-fusionar-borrar)
6. [Acciones masivas de contactos](#6-acciones-masivas-de-contactos)
7. [Conexión de Google Calendar](#7-conexión-de-google-calendar)
8. [Sincronización Google Calendar (bidireccional)](#8-sincronización-google-calendar-bidireccional)
9. [Conexión de HighLevel](#9-conexión-de-highlevel)
10. [Agendar, reagendar y cancelar citas](#10-agendar-reagendar-y-cancelar-citas)
11. [Reserva pública por URL compartible](#11-reserva-pública-por-url-compartible)
12. [Bloqueo de horarios](#12-bloqueo-de-horarios)
13. [Recordatorios y confirmación de citas](#13-recordatorios-y-confirmación-de-citas)
14. [WhatsApp / chat](#14-whatsapp--chat)
15. [Automatizaciones](#15-automatizaciones)
16. [Agente conversacional de IA](#16-agente-conversacional-de-ia)
17. [Asistente de IA de la app](#17-asistente-de-ia-de-la-app)
18. [Pagos y cobros (links, parcialidades, suscripciones)](#18-pagos-y-cobros-links-parcialidades-suscripciones)
19. [Pago público (/pay/:id)](#19-pago-público-payid)
20. [Reportes, dashboard y costos](#20-reportes-dashboard-y-costos)
21. [Pixel, tracking y atribución](#21-pixel-tracking-y-atribución)
22. [Búsqueda y filtros](#22-búsqueda-y-filtros)
23. [App móvil (tenant, login, push)](#23-app-móvil-tenant-login-push)
24. [Conectar Meta Ads y ver campañas](#24-conectar-meta-ads-y-ver-campañas)
25. [Autoinstalación del cliente (Installer)](#25-autoinstalación-del-cliente-installer)
26. [Entorno demo (portal/Installer)](#26-entorno-demo-portalinstaller)

---

## 1. Login, setup y SSO

### Paso a paso
1. El cliente recibe del Installer un enlace `/setup?token=...` para crear el primer usuario (admin).
2. El frontend valida el token con `GET /setup-info`, intenta un setup automático reutilizando el hash de contraseña del portal y, si no, pide crear contraseña.
3. `POST /api/auth/setup` consume el token y crea el admin. A partir de ahí, el usuario entra por `/login` con usuario, email o teléfono + contraseña.
4. Existe un atajo SSO desde el portal: `/sso?token=...` abre sesión sin reescribir contraseña; si todavía no hay usuario, redirige a `/setup` con el mismo token.

### Qué funciona
- Login por **username / email / teléfono**, hash PBKDF2 con `timingSafeEqual`, sincronización de contraseña del dueño desde el portal y mensaje genérico que **no revela** si el usuario existe.
- Setup con **token de un solo uso** validado/consumido contra el portal, email precargado, y verificación de "no hay usuarios previos" antes de crear.
- SSO hace *peek* antes de consumir y valida licencia.

### Qué está incompleto
- La verificación "no hay usuarios" (peek) y el `INSERT` del primer admin **no son atómicos** (**AUTH-006**, `probable`): dos `POST /setup` concurrentes pueden pasar ambos el chequeo antes de insertar (TOCTOU). Raro, pero deja estado inconsistente.
- En el camino `needs_setup` del SSO, el token **NO se consume** y queda reutilizable hasta que el portal lo expire (riesgo de reuso).

### Qué puede confundir al usuario
- Si el token de setup expira mientras el usuario llena el formulario, el error solo aparece **al enviar**, no antes.
- Si el mismo token de SSO ya se usó en otra pestaña, el segundo intento muestra un **error genérico** sin explicar la causa.

### Qué puede romperse
- **AUTH-001 (`confirmado`, alto): sin rate limiting ni bloqueo de intentos.** `POST /login`, `/sso` y `/setup` no tienen throttle, retraso progresivo ni lockout (`authController.js:129-241`, `auth.routes.js:43`). Combinado con contraseñas de mínimo 6 caracteres (**AUTH-005**), un script puede reventar cuentas por fuerza bruta. Es un CRM con datos de clientes y pagos.
- **AUTH-002 (`confirmado`, alto): el instructivo público de reset deja credenciales fijas `admin/admin123`.** El panel "¿Olvidé mi usuario o contraseña?" muestra a **cualquier visitante** el comando de Render Shell y el resultado exacto (`Usuario: admin / Contraseña: admin123`) en `Login.tsx:126-132,280-305`. Quien tenga acceso al Shell (soporte, dev, ex-empleado) puede dejar la cuenta con una contraseña trivial conocida públicamente.
- **AUTH-004 (`confirmado`, medio): `JWT_SECRET` con fallback estático fuera de producción.** Si una instalación no fija `NODE_ENV=production`, los tokens se firman con la cadena `ristak-default-secret-change-me` (que está en el repo, `auth.js:5-15`): cualquiera puede forjar sesiones de admin sin contraseña.
- **AUTH-008 (`confirmado`, bajo):** `POST /verify` (sin auth, por diseño) acepta el token en el body; sin rate limiting permite sondear tokens y disparar verificaciones de licencia contra el portal sin coste.

---

## 2. Sesión, logout y recuperación de cuenta

### Paso a paso
1. Tras login, el JWT casero se guarda en `localStorage` del navegador. No hay cookies.
2. En cada request, `requireAuth` re-lee `is_active` y `role` del usuario contra la base de datos.
3. Al hacer logout, el frontend borra `auth_token` de `localStorage` y limpia el estado local.

### Qué funciona
- `requireAuth` re-valida `is_active`/`role` en **cada** request (`authMiddleware.js:25-28`): desactivar un empleado lo deja fuera al instante en el siguiente request.

### Qué está incompleto
- No hay store de sesiones ni lista de revocación; el logout es solo del lado del cliente (`AuthContext.tsx:267-272`).

### Qué puede confundir al usuario
- "Cerrar sesión" parece definitivo, pero no invalida nada del lado servidor.

### Qué puede romperse
- **AUTH-003 / SEC-007 (`confirmado`, alto): JWT de 30 días sin revocación.** El token solo lleva `userId/username/email/role/iat/exp`, sin `jti` ni `token_version` (`auth.js:94-163`). Si un token se filtra (XSS, dispositivo compartido, log), no hay forma de cortarlo: "cerrar sesión" no lo mata y **cambiar la contraseña tampoco lo invalida** (`changePassword`, `authController.js:456-463`). Solo rotar `JWT_SECRET` lo revoca, y eso tumba a TODOS los usuarios.
- **AUTH-010 (`confirmado`, medio): no existe recuperación de cuenta para el usuario final.** El único camino es ejecutar un comando en el Render Shell (`Login.tsx:252-313`). Un dueño no técnico que olvide su contraseña queda **bloqueado de su propio CRM** hasta que un técnico intervenga.
- **AUTH-007 (`probable`, medio):** en cada login fallido localmente con licencia activa, la app reenvía la contraseña del dueño al portal; `normalizeBaseUrl` no fuerza HTTPS (`licenseService.js:124-126,511-536`), así que si la URL del portal es `http://`, la contraseña viaja sin cifrar.
- **AUTH-009 (`probable`, bajo):** al crear/editar empleados se llama `requestPortalUserRefresh()` sin `await` y con catch silencioso. Si el portal falla, ese empleado puede quedar **sin login móvil por correo** de forma silenciosa, sin reintento ni alerta.

---

## 3. Licencia y feature flags (qué ve según su plan)

### Paso a paso
1. Al iniciar sesión, si la instalación es "gestionada", el backend valida la licencia contra el portal y devuelve el usuario con sus `licenseFeatures`.
2. El frontend usa esas features (capturadas al login/SSO/me) para ocultar o mostrar módulos.
3. Solo 8 routers premium tienen `requireFeature` en el backend: automations, advanced_reports, meta_ads, google_calendar, app_assistant_ai, conversational_ai, whatsapp, email.

### Qué funciona
- El login **bloquea correctamente** si el portal responde no-allowed; el frontend redirige a `/license-blocked` en login, SSO, setup y a mitad de sesión.
- Para los 8 módulos gateados, el backend sí bloquea por feature aunque se oculte la UI.

### Qué está incompleto
- Las features se capturan **solo al login/me**: no hay refresco en vivo. Si el cliente hace upgrade/downgrade a media sesión, la UI no cambia hasta re-login (**LIC-008**, `confirmado`). El endpoint `GET /api/license/status` existe pero **ningún componente del frontend lo consume** (endpoint muerto).
- **LIC-009 (`requiere-verificacion-manual`, medio):** los crons (Meta, HighLevel, automatizaciones, recordatorios) no verifican licencia/feature antes de ejecutar; siguen corriendo aunque la licencia esté suspendida o la feature no esté incluida.

### Qué puede confundir al usuario
- Un cliente que compra un upgrade **no ve la función nueva** hasta cerrar y volver a entrar; no hay aviso de "recarga para activar".
- **LIC-005 (`confirmado`, medio):** el frontend solo maneja el 403 `license_blocked`, no `feature_not_available`. Si el usuario toca una ruta premium no incluida (deep link, UI no totalmente oculta), recibe un **error opaco o pantalla rota** en vez de un mensaje "no incluida en tu plan".

### Qué puede romperse
- **LIC-001 (`confirmado`, alto): el plan se puede saltar por API directa.** Módulos que el frontend trata como premium —payments, sites, analytics, contacts, dashboard, integrations, attribution— se montan **sin** `requireFeature` (`server.js:219-256`); su única protección (`requireModuleAccess`) valida ROL, no licencia. Un cliente cuyo plan no incluya pagos tiene la UI oculta pero `/api/transactions`, `/api/stripe`, `/api/subscriptions` responden normal. Es pérdida de monetización directa.
- **LIC-003 (`confirmado`, alto): failure-open.** Si el portal responde `allowed:true` **sin** el campo `features` (bug del portal, payload truncado, endpoint viejo), `normalizeLicenseFeatures` retorna **todas** las `DEFAULT_FEATURES` en `true` (`licenseService.js:249-254,319-331`): el cliente obtiene el plan premium completo por una respuesta incompleta.
- **LIC-004 (`probable`, medio):** un downgrade parcial (p. ej. `reports:true, advanced_reports:false`) se pisa: el código fuerza la sub-feature a igualar al padre, así que el cliente conserva acceso a reportes avanzados que el portal intentó desactivar.
- **LIC-002 (`confirmado`, medio):** `requireFeature` corre **antes** de `requireAuth`, así que un atacante no autenticado puede martillar `/api/automations`, `/api/meta`, etc. y forzar llamadas repetidas al portal de licencias (amplificación). El estado `blocked` no se cachea (**LIC-006**), así que cada request re-verifica.

---

## 4. Roles de equipo y aislamiento de datos

### Paso a paso
1. El admin crea un empleado y le da acceso por módulo (`access_config`).
2. El frontend (`AccessRoute`) redirige al empleado fuera de módulos no permitidos.
3. El backend valida acceso router por router con `requireModuleAccess`.

### Qué funciona
- El **aislamiento entre clientes** es a nivel infra (DB e instalación Render separadas) y es sólido.
- Módulos contacts, dashboard, reports, payments(transactions), sites, calendars, automations y campaigns **sí** validan acceso en backend.

### Qué está incompleto
- No existe concepto de "owner" por contacto: todo empleado con acceso a Contactos ve y edita TODOS los contactos (**ACL-004**, `confirmado`, decisión de producto). `assigned_user_id` existe en citas pero nunca se usa para filtrar visibilidad.

### Qué puede confundir al usuario
- El admin cree que acotó bien el rol porque la UI bloquea al empleado, pero **la API queda abierta** en varios módulos.

### Qué puede romperse
- **ACL-001 (`confirmado`, alto): escalada horizontal de privilegios por API directa.** Varios routers que el frontend SÍ protege solo tienen `requireAuth` en el backend: tracking/analytics (`tracking.routes.js:45-86`), config (`config.routes.js`), products, attribution, contact-tags, appointment-reminders y el chat (servido bajo permiso de `contacts`, nunca de `chat` — `contacts.routes.js:37,41`, `chatEvents.routes.js:8`). Un empleado con esos módulos en "none" es bloqueado solo en la UI; llamando la API directamente **lee y escribe** esos datos.
- **ACL-006 (`confirmado`, medio):** `POST/DELETE /api/config` solo exige `requireAuth`. Un empleado sin permiso de ajustes puede **modificar configuración global** de la instalación (afecta a todos).
- **ACL-003 (`confirmado`, medio):** cualquier empleado autenticado (incluso read-only) puede crear/borrar **filtros de contactos ocultos** (`hiddenContacts.routes.js:11-15`), que afectan globalmente lo que ven todos. Puede des-ocultar contactos sensibles o esconder legítimos a sus compañeros.
- **ACL-002 / SEC-005 (`confirmado`, alto): los contactos ocultos se filtran.** La única capa de privacidad fina (hidden contacts) se aplica en listados, pero **NO** en búsqueda de contactos, búsqueda global, `getContactById` ni en la lista de transacciones de reportes. Un contacto "oculto" reaparece al buscarlo, abrirlo por ID/enlace o ver el reporte de pagos, con su nombre, email y teléfono.

---

## 5. Contactos: crear, editar, fusionar, borrar

### Paso a paso
1. **Crear:** abrir modal, capturar nombre/email/teléfono, guardar (`POST /contacts`).
2. **Editar teléfono/email:** abrir detalle, cambiar el dato, guardar (`PUT /contacts/:id`).
3. **Borrar:** confirmar escribiendo una palabra; `DELETE /contacts/:id` ejecuta hard delete con CASCADE.

### Qué funciona
- Crear valida que haya al menos nombre/email/teléfono, deduplica por email exacto y por candidatos de teléfono (devuelve 409), registra el teléfono principal y dispara la automatización `contact-created`.
- Editar teléfono normaliza a E.164 y actualiza la tabla de teléfonos del contacto.

### Qué está incompleto
- El servicio del frontend manda `createdAt = now` siempre, sin respetar una fecha manual.
- La dedup de email es match exacto en minúsculas, sin normalizar variantes de Gmail (puntos / +alias).

### Qué puede confundir al usuario
- **CNT-003 (`confirmado`, medio):** cuando el backend devuelve 409 "ya existe con ese correo/teléfono", el frontend muestra un toast genérico ("Hubo un problema… verifica los datos") y **no** el mensaje real (`Contacts.tsx:1926-1935`). El usuario reintenta una y otra vez en lugar de buscar el contacto existente.
- **CNT-001 (`confirmado`, alto):** al editar un teléfono y poner el de otro contacto, **ese otro contacto desaparece de la lista sin ninguna explicación**.

### Qué puede romperse
- **CNT-001 (`confirmado`, alto): editar teléfono/email fusiona y BORRA otro contacto en silencio.** Si el nuevo teléfono coincide con el de OTRO contacto, `prepareContactPhoneUpsert` llama `mergeContactIds` que termina en `DELETE FROM contacts` (hard delete, `contactIdentityService.js:423`) **sin confirmación ni aviso**. Un usuario corrigiendo un teléfono puede destruir otro registro de cliente. Es irreversible (no hay papelera).
- **CNT-002 (`confirmado`, alto): la fusión pierde tags, custom_fields, `ghl_contact_id` y el WhatsApp preferido del contacto absorbido.** El UPDATE del merge solo copia teléfono/email/nombre/atribución/stats (`contactIdentityService.js:372-410`); las etiquetas y campos personalizados capturados se descartan al borrar el origen.
- **CNT-005 (`probable`, medio):** la dedup por teléfono confunde números nacionales de distinto país. Un número MX (+52) y uno US (+1) con los mismos 10 dígitos generan candidatos solapados (`phoneUtils.js:69-88`); pueden tratarse como duplicados y, vía CNT-001, fusionarse/borrarse contactos legítimamente distintos.
- **CNT-004 (`confirmado`, medio):** editar el email a uno duplicado **no se deduplica** y revienta con un **500 genérico** (constraint UNIQUE), en vez de un 409 amigable. Inconsistente con el teléfono, que fusiona.
- **CNT-008 (`confirmado`, medio):** al editar campos personalizados, si la sync a HighLevel falla, se hace `return 502` **antes** de persistir cualquier cambio local (`contactsController.js:3320-3331`). Con HighLevel caído, el usuario no puede guardar nada.
- **CNT-007 (`confirmado`, medio, decisión de producto):** el borrado es **hard delete** con CASCADE, sin papelera ni protección especial para contactos con compras/LTV. Eliminar un cliente con historial de pagos/citas borra todo en cascada de forma irreversible (ver también **DB-003**).
- **CNT-009 (`probable`, medio):** las definiciones de campos personalizados se segmentan por `owner_user_id`; un campo creado por el empleado A puede "desaparecer" para el empleado B dentro del mismo tenant.

---

## 6. Acciones masivas de contactos

### Paso a paso
1. Seleccionar contactos (máximo 1000 por lote).
2. Elegir plantilla de WhatsApp o automatización, con programación/drip.
3. Crear el lote; un cron procesa los ítems.

### Qué funciona
- Locking por ítem (`UPDATE WHERE status='scheduled'`), contadores, pausa/reanuda/reprograma/cancela, drip por intervalos y progreso visible.

### Qué está incompleto
- **CNT-006 (`probable`, medio):** contactos sin teléfono pueden enrolarse en lotes/automatizaciones de WhatsApp. El ítem falla individualmente (`processWhatsAppTemplateItem`), pero **la selección no advierte de antemano** cuántos contactos no tienen teléfono.

### Qué puede confundir al usuario
- El límite de 1000 por lote rechaza selecciones mayores.
- **CNT-011 (`confirmado`, bajo):** el borrado masivo es secuencial (una petición DELETE por contacto) sin barra de progreso ni cancelación (`Contacts.tsx:1704-1739`). Borrar decenas/cientos deja la UI "cargando" largo rato; si la pestaña se cierra, queda a medias.

### Qué puede romperse
- Con réplicas del proceso web, el guard "running" del cron es por proceso; el locking por ítem evita doble envío, pero los contadores/estado pueden tener carreras.

---

## 7. Conexión de Google Calendar

### Paso a paso
1. En Ajustes → Calendarios → Google, el usuario pulsa Conectar.
2. La app pide un connect-url al Installer y redirige a Google (`prompt=consent`, `access_type=offline`).
3. Google regresa al Installer, que intercambia el code y crea un **handoff cifrado de 10 min** con el refresh token.
4. La app reclama el handoff y guarda el refresh token **cifrado** localmente.
5. El usuario debe vincular **cada** calendario local de Ristak con uno de Google escribible.

### Qué funciona
- PKCE + state de un solo uso, refresh token **cifrado en reposo**, scopes verificados, email/nombre mostrados.

### Qué está incompleto
- El usuario **no elige** qué calendario de Google se usa durante el OAuth; la selección real ocurre después, calendario por calendario.

### Qué puede confundir al usuario
- Tras conectar parece "listo", pero **nada se sincroniza** hasta vincular manualmente cada calendario Ristak con uno de Google.

### Qué puede romperse
- Si Google no devuelve refresh_token (cuenta ya autorizada), el claim falla; el handoff vence en 10 min y obliga a rehacer todo el OAuth.
- **GCAL-005 (`confirmado`, medio): desconectar NO revoca nada.** Al "desconectar", la app solo borra la config local (`googleCalendarService.js:226-229`); **no** llama al Installer ni revoca el token en Google, y los calendarios locales conservan su `googleCalendarId`. El usuario cree que desconectó, pero el acceso de Ristak a su Google sigue concedido.

---

## 8. Sincronización Google Calendar (bidireccional)

### Paso a paso
1. Al crear/editar/eliminar una cita local, la app empuja a Google (PATCH/POST) y guarda `google_event_id`.
2. La dirección Google → local solo corre **bajo demanda**: con el botón de sync manual o al pedir free-slots de un rango.

### Qué funciona
- Persiste `googleEventId`, recrea el evento ante 404/410, y los errores no rompen el guardado local.

### Qué está incompleto
- **GCAL-002 (`confirmado`, alto): no hay cron de sincronización.** Google → local solo corre on-demand. Una cita creada/movida en Google **no aparece** en Ristak hasta que alguien fuerce un sync. Y las citas con `google_sync_status='error'` **nunca se reintentan**: ningún proceso vuelve a leer ese estado. No es sync bidireccional real, es pull manual.
- **GCAL-006 (`probable`, medio):** las citas importadas de Google entran **sin contacto** y **no disparan** recordatorios ni automatizaciones (esos solo viven en `createAppointment`). El dueño asume que sí.

### Qué puede confundir al usuario
- **GCAL-007 (`requiere-verificacion-manual`, medio):** la UI no muestra estado de sync **por cita**; el usuario no sabe si una cita específica llegó a Google o falló. Combinado con GCAL-002 (sin reintento), una cita fallida queda invisible como problema.

### Qué puede romperse
- **GCAL-001 (`confirmado`, alto): cancelar un evento en Google hace HARD DELETE de la cita en Ristak**, incluidas las creadas en Ristak (`googleCalendarService.js:514-530,601-606`). No es marca de cancelación: borra el registro con su contacto, notas y trazabilidad, sin confirmación ni papelera. Una acción accidental en Google borra datos de negocio.
- **GCAL-003 (`confirmado`, alto): el sync entrante pisa ediciones locales recientes.** El upsert fija fecha/hora/título/notas con los valores de Google sin comparar `date_updated` (`localCalendarService.js:2752-2807`). Si el usuario editó la cita en Ristak pero el push a Google falló o no corrió, el siguiente pull trae la versión **vieja** de Google y revierte el cambio fresco del usuario. No hay "gana el más reciente".
- **GCAL-004 (`probable`, medio):** los eventos de día completo de Google se guardan a medianoche UTC; en zonas no-UTC (p. ej. México UTC-6) aparecen el **día anterior**.

---

## 9. Conexión de HighLevel

### Paso a paso
1. En Ajustes → HighLevel, el usuario pega Location ID + Private Integration Token.
2. `saveConfig` valida con `GET /locations/:id`. Si cambió el location, se limpian los espejos.
3. Arranca el sync en background; un cron horario (minuto :17) sincroniza contactos, citas, productos, pagos y conversaciones.

### Qué funciona
- Valida credenciales antes de guardar, detecta cambio de location y limpia espejos preservando datos locales, y arranca el sync automático.

### Qué está incompleto
- No hay refresh de token (es de larga vida); si se revoca/expira, el cron falla en silencio sin re-auth guiado.
- **GHL-010 (`probable`, bajo):** el gate de conexión solo prueba `GET /locations/:id`. Un token puede pasar esa prueba pero **carecer de scopes** para calendarios/conversaciones/invoices; el usuario ve "conexión exitosa" pero faltan citas y chats sin explicación.

### Qué puede confundir al usuario
- El sync arranca en background ("Sincronizando…") y el usuario no ve progreso a menos que consulte `/sync/progress`; si falla, no hay notificación.

### Qué puede romperse
- **GHL-001 (`confirmado`, alto): el token de HighLevel se guarda en texto plano y hay un endpoint que lo devuelve completo.** A diferencia de otros secretos (que sí se cifran), `api_token` está en claro (`database.js:1140`), y `GET /config/reveal/api_token` lo entrega **íntegro a cualquier usuario autenticado** (`highlevelController.js:1155-1180`; la ruta solo exige `requireAuth`). Es la credencial maestra del CRM externo: con ella se opera toda la cuenta de HighLevel fuera de Ristak.
- **GHL-007 (`confirmado`, medio):** las rutas privadas de HighLevel solo exigen `requireAuth` (`highlevel.routes.js:46-96`). Un empleado restringido puede llamar directamente para **revelar el token, crear cobros (text2pay/record-payment) o desconectar** la integración.
- **GHL-002 (`confirmado`, alto): el sync HL→local nunca borra entidades eliminadas en HighLevel.** Solo hace upsert. Un contacto/cita/invoice borrado en HL **permanece para siempre** en Ristak, inflando métricas (total_paid, conteos de leads) con datos zombie.
- **GHL-003 (`confirmado`, alto): el pull horario pisa ediciones locales recientes de citas** (mismo patrón que GCAL-003, sin last-write-wins).
- **GHL-011 (`probable`, medio):** el emparejamiento WhatsApp→HL toma el primer candidato con id por email o teléfono, sin corroborar un segundo identificador; puede **fusionar dos personas distintas** (mezcla de chats, pagos y citas) si comparten teléfono.
- **GHL-009 (`confirmado`, medio, decisión de producto):** sincronizar HighLevel **muta silenciosamente la integración de Meta** en cada cron (`reconcileMetaBusinessWithHighLevel`), pudiendo reconfigurar las credenciales de Meta Ads sin que el usuario lo pidiera.

---

## 10. Agendar, reagendar y cancelar citas

### Paso a paso
1. **Agendar (admin):** abrir `AppointmentModal`, elegir contacto/calendario/fecha/hora/estado, guardar (`POST /api/calendars/appointments`).
2. **Reagendar:** abrir la cita, cambiar la hora, guardar (`PUT /appointments/:id`).
3. **Cancelar:** eliminar desde el modal (`DELETE /events/:id`) o cambiar el estado a "Cancelada".

### Qué funciona
- Crea la cita local, intenta sync a HighLevel y Google, dispara push y evento de Meta/WhatsApp; normaliza el instante a UTC con la zona de la cuenta (respeta la fecha/hora elegida, según commit reciente).

### Qué está incompleto
- **APT-005 (`confirmado`, medio): el ciclo de vida de estados está a medio implementar.** El modal ofrece "Reprogramada", "Asistió", "No asistió", pero cambiar la hora **no** marca `rescheduled`; ese estado no tiene semántica en ningún lado, y Google solo reacciona a "cancelled". Marcar "asistió/no asistió" no se propaga semánticamente a HighLevel.

### Qué puede confundir al usuario
- **APT-008 (`probable`, bajo):** la cita nace siempre como `confirmed` aunque el calendario tenga `autoConfirm=false` (la reserva pública sí lo respeta). Por eso, citas creadas por el equipo **omiten el flujo de confirmación** (el recordatorio de tipo "confirmation" se salta si ya está confirmed).
- El usuario cree que el recordatorio saldrá a la nueva hora tras reagendar — y no es así (ver abajo).

### Qué puede romperse
- **APT-001 (`confirmado`, alto): el admin puede crear doble-booking.** `createAppointment` crea la cita **sin** verificar disponibilidad, horario, bloqueos ni solapamiento (`calendarsController.js:1519-1571`). En un calendario Ristak con un cupo por slot, una recepcionista puede agendar dos pacientes a la misma hora sin ninguna advertencia.
- **APT-003 (`confirmado`, alto): reagendar no reenvía el recordatorio.** El cron deduplica por `reminder_id|appointment_id`; al reprogramar (mismo id, nueva hora) no se borra ese registro (`updateAppointment` no limpia `appointment_reminder_sends`), así que el recordatorio **nunca se recalcula** para la nueva fecha. El cliente no recibe (o recibe a la hora vieja) su recordatorio, aumentando los no-shows.
- **APT-006 (`probable`, medio):** cancelar cambiando el estado a "Cancelada" (en vez de Eliminar) borra el evento de Google pero **no garantiza la cancelación en HighLevel** en ese mismo PUT. La cita queda fantasma activa en HL.
- **APT-009 (`requiere-verificacion-manual`, medio) / CRON-003 (`confirmado`):** con múltiples instancias o solape de deploy, los recordatorios pueden enviarse **dos veces** (no hay claim atómico antes del envío — ver flujo 13).

---

## 11. Reserva pública por URL compartible

### Paso a paso
1. El visitante abre `/calendar/:slug`.
2. `GET free-slots` calcula horarios libres.
3. `POST /public/:slug/appointments` crea la cita y el contacto.

### Qué funciona
- Valida que el slot esté disponible y sea futuro, crea/une el contacto, crea la cita y dispara el evento de conversión y push. **Sí** respeta `autoConfirm` (a diferencia del admin).

### Qué está incompleto
- **APT-007 (`confirmado`, bajo):** la disponibilidad pública se calcula 100% local (`getLocalFreeSlots`), ignorando citas/bloqueos que solo existan en HighLevel hasta que se hayan espejado. Si HL tiene una cita aún no sincronizada, el slot se ofrece como libre.

### Qué puede confundir al usuario
- Nada visible en el flujo feliz.

### Qué puede romperse
- **APT-002 (`confirmado`, alto): carrera TOCTOU permite doble reserva del mismo slot.** Verificar disponibilidad y crear la cita son pasos separados, sin transacción, lock ni índice único por (calendario, hora) (`calendarsController.js:1144-1211`, `localCalendarService.js:2752-2807`). Dos visitantes simultáneos (típico en campañas) pasan ambos la verificación y ambos reciben confirmación para el mismo horario.

---

## 12. Bloqueo de horarios

### Paso a paso
1. Abrir `BlockedSlotModal`, definir el rango.
2. Guardar (`POST /block-slots`).

### Qué funciona
- Crea el bloqueo en HighLevel cuando hay token y locationId.

### Qué está incompleto / Qué puede romperse
- **APT-004 (`confirmado`, alto): el bloqueo solo funciona con HighLevel.** No existe almacenamiento local de bloqueos (`getBlockedSlots:1396-1408`, `getLocalFreeSlots:3017-3087`). En instalaciones **sin** HighLevel (solo Ristak, o Ristak+Google), bloquear un horario **no tiene efecto**: la lista sale vacía y el cálculo de slots libres nunca considera el bloqueo.

### Qué puede confundir al usuario
- Un usuario sin HighLevel "bloquea" sus vacaciones u horario de comida y no pasa nada (lista vacía), y la app sigue **ofreciendo y aceptando citas** en esos horarios.

---

## 13. Recordatorios y confirmación de citas

### Paso a paso
1. Al crear una cita con contacto que tenga teléfono, un cron (cada 60s) busca citas en la ventana de envío.
2. Calcula la hora de envío con la zona de la cuenta y manda la plantilla de WhatsApp (con fallback QR).
3. Para la **confirmación con IA**: sale un mensaje de confirmación; cuando el contacto responde, se abre una ventana de 2 min (debounce) y OpenAI clasifica la respuesta para confirmar/cancelar.

### Qué funciona
- Cálculo de horario inteligente respeta la zona de la cuenta; el `UNIQUE(reminder_id, appointment_id)` evita registros duplicados; gracia de 3h marca "skipped" citas creadas tarde.
- La ventana de confirmación hace claim atómico (`waiting→processing`) evitando doble proceso dentro de un mismo run.

### Qué está incompleto
- **NOTI-003 (`confirmado`, alto): la confirmación por respuesta solo funciona vía WhatsApp API.** Si el contacto responde por SMS / Messenger / Instagram / WhatsApp-de-GHL, la ventana de confirmación **nunca se abre** y la cita nunca se marca confirmada. Muchos clientes operan por HighLevel.
- **NOTI-008 (`probable`, medio):** si la plantilla no está aprobada (APPROVED) y no hay fallback QR, el recordatorio se registra como "error" **solo en logs**; la UI no lo expone. El usuario cree que sus recordatorios salen y ninguno sale.

### Qué puede confundir al usuario
- El usuario configura "cancelar cita si no confirma" sin saber que una caída de OpenAI puede disparar esa cancelación (ver abajo).

### Qué puede romperse
- **NOTI-001 (`confirmado`, CRÍTICO): una caída o ausencia de OpenAI puede CANCELAR citas que el cliente SÍ confirmó.** Si el clasificador devuelve `null` (sin API key, error de red, JSON inválido, timeout), el resultado cae a "ambiguous" (`appointmentConfirmationService.js:203-235`) y se ejecuta la acción de no-confirmación; si el usuario eligió `cancel_appointment`, la cita se cancela aunque el contacto haya respondido "sí, confirmo". En contexto médico es destructivo. **El fallo del clasificador no se distingue de un "ambiguo" real.**
- **NOTI-002 / CRON-003 (`confirmado`, alto): los recordatorios pueden enviarse dos veces.** El anti-duplicado se carga en un Set en memoria y el registro en DB ocurre **después** del envío (`appointmentRemindersService.js:577-672`). Con dos instancias (o solape de deploy), ambas leen el Set vacío, ambas envían el WhatsApp, y el `UNIQUE` solo evita la segunda fila de log, no el segundo mensaje. El cliente recibe el recordatorio duplicado.
- **NOTI-007 (`probable`, medio):** un mensaje programado atorado en "sending" tras un crash se **reenvía** pasados 10 min, sin verificar con el proveedor si ya se entregó; el contacto puede recibirlo dos veces.

---

## 14. WhatsApp / chat

### Paso a paso
1. **Conectar:** pegar la API Key de YCloud (oficial), o usar Meta directo, o conectar por **QR/Baileys** (no oficial, con consentimiento de riesgo de bloqueo).
2. **Recibir:** los mensajes entrantes crean/actualizan contacto, guardan atribución de anuncio y disparan automatizaciones / agente IA / push.
3. **Enviar:** texto, imagen, audio, documento, interactivo y plantillas aprobadas.

### Qué funciona
- Limpieza de API keys pegadas con headers/curl; sincronización de números/plantillas/balance; verificación de que el número exista en WhatsApp antes de enviar por QR; drip anti-bloqueo y watchdog que reabre sesiones tras deploy.
- Extracción robusta de atribución Click-to-WhatsApp (ad_id/ctwa_clid).

### Qué está incompleto
- **WA-009 (`probable`, medio):** cuando un envío por API falla y no procede fallback QR, el mensaje **no se persiste** en el chat (`sendWhatsAppApiTextMessage:7491-7549`). El operador ve un toast de error pero no queda rastro ni opción de reintento en el hilo.
- **WA-006 (`confirmado`, medio):** si Bunny (CDN de media) falla y el fallback local está activo, la media se guarda en disco efímero de Render (se pierde al deploy) y la API oficial no puede enviarla (exige URL HTTPS pública). Es un fallback que da falsa sensación de resiliencia.

### Qué puede confundir al usuario
- **WA-002 (`confirmado`, alto):** un envío por QR a un destinatario **offline** (teléfono apagado/sin red, caso común) se reporta como **fallido** si no llega ack de entrega en 20s (`whatsappQrService.js:780-799`), aunque WhatsApp ya lo aceptó. El mensaje **no se guarda**, el operador reenvía, y el cliente recibe **mensajes duplicados** al reconectarse.
- **WA-005 (`probable`, medio):** si los "hints" de número de negocio no están cargados (justo tras conectar o tras deploy), un mensaje saliente puede guardarse como **entrante** (`inferMessageDirection:3914-3941`), alterando el hilo y disparando automatizaciones/IA como si fuera del cliente. (La existencia de una rutina de reparación masiva confirma que ya ocurrió en producción.)

### Qué puede romperse
- **WA-001 (`confirmado`, alto): el webhook de YCloud acepta payloads sin firmar cuando no hay `webhook_secret`.** Si la creación del webhook falló (API key sin permisos) y solo se guardó un warning, el endpoint público procesa **cualquier** payload sin verificación (`processYCloudWhatsAppWebhook:5566-5594`). Un atacante puede inyectar mensajes/contactos falsos y disparar automatizaciones y el agente de IA.
- **WA-004 (`confirmado`, alto): el webhook de atribución es público y sin firma.** Cualquiera que conozca/adivine el teléfono de un contacto puede sobrescribir su `attribution_ad_id`/`ad_name` (`webhooksController.js:1747-1855`), **contaminando los reportes de ROI/campañas**. Siempre responde 200, incluso ante error.
- **WA-003 (`confirmado`, alto): el watchdog QR no tiene lock entre instancias.** Con varias réplicas, cada una abre el mismo socket Baileys con las mismas credenciales → `connectionReplaced` y una **guerra de reconexiones** que nunca estabiliza la sesión, con mayor riesgo de bloqueo del número.
- **WA-007 (`probable`, medio):** el estado "failed" es terminal: si llega un "failed" transitorio antes de un "delivered" posterior, el mensaje queda marcado como fallido para siempre (salvo el caso de fallback QR).

---

## 15. Automatizaciones

### Paso a paso
1. Crear una automatización (draft), agregar un disparador, arrastrar nodos de acción/lógica y conectarlos.
2. Configurar cada nodo y **Publicar** (valida estructura, ciclos, nodos sueltos, variables).
3. Cuando ocurre un evento (mensaje, contacto creado, etiqueta, formulario, pago, cita…), se inscribe el contacto y el flujo se recorre paso a paso. Las esperas se reanudan con un scheduler cada 20s.

### Qué funciona
- La validación de publicación cubre falta de disparador, aristas rotas, ciclos, nodos sueltos, variables no disponibles y configuraciones de drip/aleatorizador mal hechas.
- Eventos cableados (mensaje WA/IG/Messenger/email, contact-created/updated, tag-changed, form-submitted, payment-received, refund, appointment-booked/status, webhook-received, trigger-link-clicked, scheduler) disparan y matchean filtros.

### Qué está incompleto
- **AUTO-001 (`confirmado`, alto): el editor permite publicar nodos que el motor NO ejecuta.** Messenger, Instagram, "actualizar campo", "eliminar contacto", **aleatorizador (A/B)**, grupo de acciones, IA y nodos de datos caen en un `default` que los marca "skipped" (`executeNode:2659-2839`). Para nodos lineales se omiten en silencio; para nodos con **salidas ramificadas** (aleatorizador), el motor pide una arista que no existe y marca la inscripción como "completed", **cortando todo el resto del flujo sin rastro de error**. El usuario lo publica sin advertencia y asume que funciona.
- **AUTO-002 (`confirmado`, alto): hay disparadores ofrecidos que nunca reciben evento.** "Comentario en Facebook/Instagram", "Clic en anuncio" y "Click-to-WhatsApp" no tienen ningún case en el motor (`triggerMatches:1089-1198`). Una automatización con esos disparadores **jamás se ejecuta**, sin pista de por qué.
- **AUTO-006 (`probable`, medio):** el nodo "Objetivo" siempre toma la salida "cumplido" sin evaluar nada (`logic-goal:2802-2803`). Contactos que ya cumplieron la meta (p. ej. ya pagaron) siguen recibiendo la secuencia; la rama "no cumplido" nunca se usa.
- **AUTO-007 (`probable`, medio):** "pausar" se trata igual que "despublicar"; los contactos en espera por duración terminan **expulsados ("exited") de forma irreversible** cuando vence su espera, en vez de quedar suspendidos hasta reanudar.

### Qué puede confundir al usuario
- **AUTO-010 (`probable`, bajo):** una variable mal escrita (p. ej. `{{nombre_contacto}}` en vez de `{{first_name}}`) se renderiza como cadena vacía sin aviso; el cliente recibe "Hola ," en vez de "Hola Juan,".

### Qué puede romperse
- **AUTO-003 / CRON-004 (`confirmado`, alto): reanudación de esperas sin claim atómico.** `processDueResumes` lee las inscripciones en espera y ejecuta el flujo **antes** de reservar la fila (`automationEngine.js:3621-3688`). Con réplicas o ticks solapados, dos procesos reanudan la misma inscripción y ejecutan la rama dos veces → **mensajes y acciones duplicados** (etiquetas, webhooks salientes, cobros).
- **AUTO-004 (`probable`, medio):** la garantía de "no inscribir dos veces al mismo contacto" es un check-then-insert sin constraint único; bajo eventos concurrentes (webhooks de pago, mensajes en ráfaga) el contacto recibe la secuencia dos veces.
- **AUTO-005 (`confirmado`, medio):** un fallo transitorio de un nodo (WhatsApp/email caído un instante) marca la inscripción como "exited" **sin reintento** (`runFrom:2861-2868`), abortando el resto de la secuencia para ese contacto.
- **AUTO-009 (`confirmado`, medio):** el endpoint de assets de automatización es **público por ID, sin auth ni expiración** (`automations.routes.js:31-34`); una URL filtrada da acceso indefinido a adjuntos potencialmente sensibles.

---

## 16. Agente conversacional de IA

### Paso a paso
1. Llega un mensaje entrante (WhatsApp/IG/Messenger/SMS/webchat/email).
2. El servicio de mensajería invoca el agente; debounce de 4s, se resuelve qué agente atiende, se "reclama" el último mensaje.
3. El modelo genera la respuesta y ejecuta acciones (agendar, crear link de pago, enviar enlace, pasar a humano, descartar). La respuesta se divide en burbujas y se entrega por el canal correcto; se programa un follow-up.

### Qué funciona
- Soporte multicanal real, entrega por el canal correcto, supresión si llega un mensaje más nuevo durante el delay, idempotencia básica de cita (no duplica cita futura activa) y sanitizado del razonamiento interno.

### Qué está incompleto
- **AI-003 (`confirmado`, medio):** los follow-ups viven en `setTimeout` en memoria y la recuperación de pendientes corre **solo en el boot**, sin cron de respaldo. Si OpenAI falla en un inbound, el catch solo loggea (sin reintento ni cola): ese mensaje puede quedar **sin respuesta hasta el próximo reinicio**.
- **AI-002 (`requiere-verificacion-manual`, alto):** el runtime del agente **no valida el feature flag premium** `conversational_ai`. Si a un cliente se le revoca esa feature (downgrade/impago), el agente **sigue respondiendo** a los clientes finales y gastando su API key. Falta confirmar si el provisioning lo apaga por otra vía.
- **AI-007 (`confirmado`, medio, decisión de producto):** apagar el toggle global **no detiene** a los agentes publicados (el runtime se re-habilita si hay agentes en estado publicado). No hay un "kill switch" confiable; en una emergencia hay que despublicar cada agente.

### Qué puede confundir al usuario
- **AI-006 (`probable`, medio):** con un proveedor no-OpenAI sin API key de OpenAI guardada, los audios e imágenes entrantes **no se transcriben/describen**; el agente responde "a ciegas" sin avisar al negocio que falta esa key.

### Qué puede romperse
- **AI-001 / CRON-007 (`confirmado`, alto): doble respuesta y doble acción en multi-instancia.** La protección contra ejecuciones concurrentes es un Set en memoria + un claim no atómico (read-then-write, no compare-and-set; `runner.js:1432-1486`). Con dos instancias o un webhook reenviado, ambas pueden responder y **ejecutar acciones reales dos veces**.
- **AI-004 (`confirmado`, alto): `create_payment_link` no es idempotente.** A diferencia de agendar cita (que sí valida una existente), crear link de pago no tiene guard (`tools.js:645-704`). Combinado con AI-001 o un reintento del modelo, se generan **dos links/cobros** por el mismo concepto; si el cliente paga ambos, doble cobro.

---

## 17. Asistente de IA de la app

### Paso a paso
1. El usuario abre el AI Agent, configura su API key de OpenAI y el contexto del negocio.
2. Escribe una pregunta; el triage la clasifica por categoría (citas, pagos, contactos, anuncios…).
3. El especialista usa herramientas que reutilizan los controllers reales (lectura DB + acciones). Las acciones destructivas piden confirmación textual.

### Qué funciona
- Routing por triage + handoffs entre especialistas; las tools reutilizan los controllers reales (mismas validaciones/sync); ledger de pasos; soporte de adjuntos imagen/PDF/texto.

### Qué está incompleto
- El ledger es **solo auditoría**: no hay idempotencia por mensaje del usuario.

### Qué puede confundir al usuario
- La inferencia local de categoría y el triage del modelo pueden discrepar, sin que el usuario vea por qué cae en una u otra especialidad.

### Qué puede romperse
- **AI-005 (`probable`, medio):** si OpenAI falla **después** de que una tool ya impactó la DB (crear contacto, registrar pago), el chat devuelve "error" pero la acción ya ocurrió (`runSpecializedAgentReply:461-510`). El usuario reintenta y **duplica** la acción, sin saber que la primera vez sí se ejecutó.
- **AI-008 (`probable`, bajo):** los traces de runs conversacionales se guardan con `user_id NULL` y son visibles para cualquier usuario con módulo `ai_agent` que conozca el traceId; posible exposición de contenido de conversaciones entre empleados del mismo tenant.

---

## 18. Pagos y cobros (links, parcialidades, suscripciones)

### Paso a paso
1. **Link de pago:** crear con monto/contacto; se genera un `public_payment_id` aleatorio y se comparte `/pay/:id`.
2. **Parcialidades:** definir primer pago + cuotas; un cron cada 30 min procesa las vencidas (Stripe/Conekta cobran con tarjeta guardada; MercadoPago genera link).
3. **Suscripción recurrente:** crear (Stripe/MP) y, en teoría, gestionarla.
4. **Pago manual:** registrar desde `RecordPaymentModal` (`POST /api/transactions`).

### Qué funciona
- El `public_payment_id` es aleatorio e imposible de adivinar; se valida monto > 0.
- Stripe cobra parcialidades con `idempotencyKey` estable (evita doble cargo aun con dos procesos) y recupera filas "processing" atoradas.
- Las automatizaciones de pago (recordatorio/comprobante/fallido) usan dedup correcto (`payment_automation_dispatches` con ON CONFLICT).
- Cancelar una suscripción Stripe vía `actionSubscription('cancel')` **sí** la cancela en Stripe antes de marcar local.

### Qué está incompleto
- **PAY2-002 (`confirmado`, alto): Conekta no tiene webhook ni polling.** Un pago Conekta que queda "pending" (3DS, OXXO, SPEI) **nunca pasa a "paid"** en la app (`conekta.routes.js:19-31`): el cliente paga horas después en OXXO y la app jamás lo refleja; no se dispara el comprobante ni la factura ni se actualizan stats. La página pública incluso promete "se actualizará cuando se confirme" y nunca ocurre.
- **PAY2-003 (`confirmado`, medio): MercadoPago no encola el comprobante automático.** Conekta sí lo hace; MP no (`updatePaymentFromMercadoPagoPayment:2464-2471`). El merchant activa "enviar comprobante" y le llega para Conekta pero **no** para MercadoPago.
- **PAY2-006 (`confirmado`, medio): la facturación Gigstack no tiene reintentos.** Si el primer intento falla, marca "error" y solo loggea; ningún cron lo reintenta. La factura fiscal nunca se emite ante un fallo transitorio.
- **PAY2-007 (`probable`, medio):** los recordatorios de pago solo salen para links con `due_date`, pero los links sueltos no la fijan; la automatización queda **silenciosamente inactiva** para la mayoría de links.
- **CRON-005 (`confirmado`, medio): el cron de parcialidades de MercadoPago está construido pero NUNCA se arranca** en `server.js`. Las parcialidades de planes MP no generan su link automáticamente; a diferencia de Stripe/Conekta, el plan no avanza solo.

### Qué puede confundir al usuario
- Mezcla de estados (scheduled/sent/processing/failed) entre `installment_payments`, `payments` y `payment_flows`.

### Qué puede romperse
- **PAY-001 (`confirmado`, alto): eliminar una suscripción NO la cancela en Stripe.** `deleteSubscription` cancela MercadoPago y Conekta pero **omite Stripe** (ni siquiera trae `stripe_subscription_id`, `subscriptionsService.js:868-888`). Una suscripción Stripe sin cobros aún registrados queda "deleted" en Ristak mientras **Stripe la sigue cobrando indefinidamente** al cliente final. Fuga de dinero y chargebacks.
- **PAY-002 (`confirmado`, alto): un reembolso parcial marca el pago como totalmente reembolsado.** El webhook `charge.refunded` pone `status='refunded'` sin comparar montos (`markStripePaymentAsRefunded:2706-2746`); Stripe lo dispara también en reembolsos parciales. Un reembolso de $100 sobre $1000 oculta los $1000 completos, distorsionando ingresos y stats.
- **PAY2-001 / CRON-001 (`confirmado`, alto): doble cobro de parcialidades Conekta.** El POST `/orders` de Conekta **no envía Idempotency-Key** y el reclamo del trabajo no es atómico (`conektaPaymentService.js:1899-2016,359-380`). Con solape de deploy o un trigger concurrente, se pueden crear DOS órdenes para la misma parcialidad = **doble cargo real** al cliente, irreversible (requiere reembolso manual).
- **PAY-003 (`probable`/`ajustado`, medio):** si el INSERT local de una suscripción Stripe falla **después** de crearla en Stripe, no hay rollback: la suscripción queda viva facturando sin registro en Ristak.
- **PAY-007 / PAY-009 (`probable`, medio/bajo):** un pago manual reenviado por reintento de red puede crear un **duplicado** (sin clave de idempotencia); y dos clics en el link público pueden crear PaymentIntents huérfanos confirmables.
- **PAY-006 / DB-005 (`confirmado`, medio): SQL probado solo en SQLite truena en Postgres prod** ("could not determine data type of parameter"). Es un patrón recurrente que tumba flujos de pago/parcialidades **solo en producción**, difícil de reproducir localmente.
- **PAY2-005 (`confirmado`, medio):** el webhook de MercadoPago acepta peticiones **sin firma** cuando no hay secret configurado (mitigado porque reconsulta el pago real en MP).

---

## 19. Pago público (/pay/:id)

### Paso a paso
1. El cliente abre `/pay/:id`; la app carga los datos públicos del pago.
2. Monta el formulario de tarjeta (Stripe / Brick de MP / tokenizador de Conekta) o checkout hospedado.
3. Tokeniza la tarjeta y envía; el backend crea el pago/orden y devuelve el estado.

### Qué funciona
- Pago con tarjeta tokenizada funciona síncrono; bloquea recobro si ya está pagado/reembolsado/anulado (409); badges de estado en la página.

### Qué está incompleto
- **PAY2-004 (`confirmado`, medio): la página no refresca tras volver del checkout hospedado de MercadoPago.** El back_url usa `?mercadopago=return`, pero la página solo fuerza sync con `?payment=return` (que es de Stripe). Tras pagar en MP, la página puede seguir mostrando "pendiente" hasta que el webhook procese y el usuario recargue. **No hay polling.**

### Qué puede confundir al usuario
- El texto promete "esta página se actualizará cuando se confirme", pero **nunca se auto-refresca**. El cliente puede creer que el pago falló y reintentar (doble cargo desde su lado).

### Qué puede romperse
- **PAY2-008 (`confirmado`, bajo, decisión de producto):** en cada pago público Conekta, la tarjeta del cliente se guarda **por defecto** (sin opt-in explícito visible), habilitando cobros off-session futuros. Posible problema de consentimiento.
- **PAY2-009 (`confirmado`, bajo):** la página pública expone la **identidad fiscal del merchant** (RFC, razón social, CP, régimen) a cualquier visitante del link.

---

## 20. Reportes, dashboard y costos

### Paso a paso
1. El usuario entra al dashboard, elige un rango de fechas y ve KPIs (ingresos, gasto Meta, ROAS, ganancia neta, LTV), gráficas y el funnel.
2. En Ajustes → Costos crea costos fijos o porcentuales que se restan en la ganancia neta.

### Qué funciona
- Cálculo de ingresos exitosos, gasto Meta, ROAS y variación vs periodo anterior; respeta zona horaria en Postgres; estados vacíos devuelven 0.
- **Los ingresos ya excluyen los reembolsos correctamente** (RPT-002 **refutado**: el reembolso cambia el `status` del pago a `refunded`, que queda fuera de los estados de éxito; restarlo de nuevo sería doble deducción).

### Qué está incompleto
- **RPT-003 (`confirmado`, medio):** los costos con "Aplica sobre: Ganancias netas" (`profit`) se **ignoran silenciosamente** (solo se maneja `revenue`, `dashboardController.js:211-219`). El usuario configura un costo que nunca afecta sus métricas.
- **RPT-007 (`probable`, medio):** citas y asistencias caen a **0 en silencio** si falta o expira el token de HighLevel, sin distinguir "cero real" de "integración caída". El usuario cree que no hubo citas.
- **RPT-008 (`confirmado`, medio):** las listas de transacciones y contactos no tienen paginación ni límite (`getTransactionsList:353-371`); en cuentas con miles de pagos el reporte puede tardar, timeoutear o saturar memoria (riesgo de 502/OOM en instancias de 512MB).

### Qué puede confundir al usuario
- **RPT-001 (`confirmado`, alto): los costos fijos NO se prorratean ni se filtran por fecha, contradiciendo la propia UI.** La pantalla de Costos afirma que cada costo es "mensual" y que "en reportes de días o años se prorratea automáticamente", pero el dashboard resta el monto **completo** sin importar el rango (`computeFinancialSnapshot:204-227`). Un rango de 1 día resta la renta mensual completa (ganancia neta absurdamente negativa); un rango de 1 año resta solo 1 mes (ganancia inflada). El prorrateo real solo existe para los gastos manuales, no para la tabla `costs`.
- **RPT-006 (`confirmado`, medio):** el número de "Citas" del funnel y el de la gráfica de Citas usan definiciones distintas (fecha de agenda vs fecha de registro del contacto) y **no coinciden** en la misma pantalla.
- **RPT-005 (`probable`, medio):** en la vista de atribución, el ingreso se agrupa por fecha de registro pero el gasto **siempre** por fecha del anuncio; el ROAS diario mezcla dos líneas de tiempo distintas y es engañoso.

### Qué puede romperse
- **RPT-010 (`confirmado`, bajo):** si la query de costos falla, el dashboard cae a un fallback de **IVA 16% hardcodeado** (supuesto fiscal mexicano), produciendo una ganancia neta basada en un número inventado.

---

## 21. Pixel, tracking y atribución

### Paso a paso
1. Una página con el pixel carga `snip.js`, que genera un `visitor_id` y manda `POST /collect` con UTMs, click IDs y datos de anuncio.
2. Cuando el visitante se convierte en contacto (vía `_ud` de HighLevel), se vinculan sus sesiones y se unifican sus `visitor_id`.
3. Un formulario de Site público crea contactos; trigger links redirigen (302) y registran clicks.

### Qué funciona
- Captura UTMs, click IDs, device y geo; soporta SPA; modo no-track para previews. Vincula sesiones históricas y unifica `visitor_id`.

### Qué está incompleto
- **TRK-002 (`probable`, medio):** no hay deduplicación de sesiones; `session_end` y reenvíos por keepalive inflan los page_views y hacen crecer la tabla.
- **TRK-006 (`confirmado`, medio):** la reatribución por fallback sobrescribe `attribution_ad_id` **sin guardar el valor anterior** ni marcar que es inferido (heurística ≥80% de URL). Irreversible; mezcla atribución "dura" (gclid/fbclid) con adivinada sin trazabilidad.

### Qué puede confundir al usuario
- **TRK-005 (`confirmado`, medio):** la **vista previa** de la reatribución usa UTC y la **ejecución** usa la zona de HighLevel; el admin aprueba viendo un resultado y la ejecución hace otro (contactos cerca de medianoche difieren).

### Qué puede romperse
- **TRK-001 (`confirmado`, alto): `/collect` acepta sesiones falsas.** El endpoint es público, con CORS abierto y sin firma ni validación de origen (`trackingController.js:858-952`, `server.js:152`). Cualquiera puede inyectar visitas/conversiones falsas y **contaminar la atribución y el revenue por campaña**; con un `contact_id` válido puede incluso reasignar la identidad de un contacto (`unifyVisitorIds` reescribe los visitor_id). Toda la atribución depende de datos que cualquiera en internet puede falsificar.
- **TRK-004 (`confirmado`, alto): el submit público de Sites no tiene rate limiting, honeypot ni captcha.** Un bot puede crear **contactos ilimitados**, ensuciar el CRM, gastar cuota de CAPI de Meta y disparar automatizaciones/mensajes en masa con datos basura (`submitPublicSiteHandler:762-772`).
- **TRK-007 (`confirmado`, medio):** los trigger links toman `contact_id`/`visitor_id` del query string sin verificar pertenencia, y `click_count` se incrementa en cada GET sin deduplicar. Los **link scanners de email** (Outlook SafeLinks) y el prefetch inflan los clicks y disparan automatizaciones para contactos que no hicieron clic real.
- **TRK-003 (`confirmado`, medio):** la geolocalización se resuelve de forma **síncrona** contra `ip-api.com` (HTTP sin TLS, 45 req/min) dentro de cada `/collect`; en tráfico alto degrada el endpoint y la IP del visitante viaja en claro a un tercero.

---

## 22. Búsqueda y filtros

### Paso a paso
1. El usuario busca un contacto por nombre/teléfono, usa el buscador global o abre un contacto por su enlace/ID.

### Qué funciona
- La búsqueda de contactos, el buscador global y la apertura por ID encuentran y muestran los datos.

### Qué puede romperse / confundir
- **ACL-002 / SEC-005 (`confirmado`, alto): los contactos ocultos reaparecen en la búsqueda.** El filtro de privacidad se aplica en listados y dashboard, pero **no** en `searchContacts`, `globalSearch`, `getContactById` ni en la lista de transacciones de reportes (`contactsController.js:2728-2808,2310-2389`; `searchController.js:104-127`; `reportsController.js:353-369`). Un contacto que el admin ocultó deliberadamente vuelve a aparecer —con nombre, email y teléfono— al buscarlo, abrirlo por enlace o ver el reporte de pagos. El mecanismo de privacidad es evitable y da falsa sensación de seguridad. (Mismo defecto que en los flujos 4 y 5.)

---

## 23. App móvil (tenant, login, push)

### Paso a paso
1. Primer arranque: el gate redirige a `/phone/tenant` si no hay tenant resuelto.
2. El usuario pone correo + contraseña; `resolveAndStoreMobileTenant` consulta al portal a qué backend de cliente pertenece el correo y autentica.
3. Onboarding de notificaciones push (web o nativo Capacitor); el dispositivo se registra en `/push/mobile-devices`.

### Qué funciona
- En iOS nativo, el gate fuerza `/phone/tenant` cuando no hay baseUrl y el login por correo enruta por el portal.
- Tokens push inválidos se deshabilitan automáticamente; preferencias por usuario/rol filtran destinatarios.

### Qué está incompleto
- **MOB-005 (`confirmado`, medio):** el registro de push nativo se da por **"denegado" tras un timeout de 16s** (`mobileAppService.ts:302-307`); en redes lentas o primeras instalaciones, APNs/FCM puede tardar más, y el usuario ve que las notificaciones "no se activaron" aunque el permiso esté concedido.
- **MOB-009 (`requiere-verificacion-manual`, bajo):** las secciones premium (Publicidad/Reportes) muestran **ceros** ante un 403 de feature en vez de avisar "no incluido en tu plan".

### Qué puede confundir al usuario
- **MOB-003 (`confirmado`, alto): `/phone/login` no re-resuelve el tenant.** Si ya hay un tenant guardado (empresa A) y el usuario teclea el correo de **otra** empresa (B), el login pega al backend equivocado y devuelve "usuario o contraseña incorrectos" sin explicar que es un problema de empresa. Hay que descubrir el botón "Cambiar empresa".
- **MOB-004 (`ajustado`, medio):** en un iPhone real (shell de chat), **no hay un botón de "cerrar sesión" descubrible**; el usuario queda atado al último tenant en dispositivos compartidos. (En el panel ancho/tablet sí existe.)
- **MOB-006 (`probable`, medio):** los toggles de notificación en Ajustes parecen "de este celular" pero varios son **config global del tenant**; un empleado que apaga "Mensajes del chat" lo apaga para **todo el equipo**.
- **MOB-007 (`probable`, medio):** las fechas y la caché móvil usan la **hora local del dispositivo**, no la zona del negocio; un usuario en otra zona ve métricas/citas del "hoy" desfasadas respecto al escritorio.

### Qué puede romperse
- **MOB-001 (`probable`, CRÍTICO): la app Android no puede loguear en producción.** El WebView de Android usa origin `https://localhost`, que **no está en la allowlist CORS del Installer** (`capacitor.config.ts:10-12`, Installer `server.js:42-58`); el `POST /api/mobile/resolve` es rechazado, así que no se puede resolver el backend del cliente ni iniciar sesión en el binario Android. (iOS sí pasa.)
- **MOB-002 / NOTI-004 (`confirmado`, alto): los push de chat exponen contactos ocultos.** El push de chat lleva nombre del contacto y texto del mensaje en la pantalla de bloqueo, y **no se consulta el filtro de contactos ocultos** (`pushNotificationsService.js:1022-1054`; `notificationPreferencesService.js:105-140`). Un empleado con visibilidad restringida recibe el contenido (posiblemente médico) de conversaciones que no debería ver.
- **MOB-008 (`confirmado`, bajo):** `DELETE /push/mobile-devices` desactiva por token sin verificar dueño; un usuario podría silenciar las notificaciones de otro.

---

## 24. Conectar Meta Ads y ver campañas

### Paso a paso
1. En Ajustes → Meta, el usuario pega un Access Token de larga duración (System User).
2. La app valida con `debug_token`, lista cuentas/pixels/páginas y dispara un sync de hasta 35 meses.
3. El cron horario actualiza los últimos 7 días; las métricas se ven en la vista de Campañas.

### Qué funciona
- Validación previa del token, credenciales cifradas antes de persistir, dropdowns de cuentas/pixels/páginas, y un probador de Pixel/CAPI con enlace público firmado y TTL.
- El sync histórico borra y reinserta por chunk mensual (no deja ventana de gasto=0).

### Qué está incompleto
- **META-002 (`confirmado`, alto): el Campaign Builder NUNCA crea campañas reales en Meta.** Tras armar y confirmar el draft, la ejecución siempre termina en `mcp_not_connected` o `adapter_missing` (`metaCampaignBuilderService.js:949-1008`): el runtime que ejecutaría las tools no está implementado. Es una función expuesta que no produce ninguna campaña. (Además no hay UI de campaign builder en el frontend.)
- **META-003 (`confirmado`, alto): el frontend nunca muestra el estado/expiración del token.** El backend calcula días para expirar, pero la UI no lo consume ni lo renderiza. Cuando el token caduca/se revoca, el cron falla en silencio y la app **sigue mostrando datos viejos sin avisar**.

### Qué puede confundir al usuario
- El usuario llega hasta "confirmar" en el Campaign Builder creyendo que creará la campaña, y solo recibe un mensaje de que el MCP no está conectado.

### Qué puede romperse
- **META-001 (`confirmado`, alto): CPM y CTR se calculan con `reach` en vez de `impressions`.** Como `reach` (usuarios únicos) siempre es menor que las impresiones (`metaAdsService.js:738-739`), **ambas métricas quedan sistemáticamente infladas** y no reconcilian con Meta Ads Manager. Peor: Meta ni siquiera pide el campo `impressions`, así que el dato correcto nunca se trae. Decisiones de presupuesto sobre números erróneos.
- **META-005 (`confirmado`, medio):** el access token de Meta se revela completo al navegador y se manda como **query string** a endpoints propios (`?accessToken=`), quedando en logs/historial/referers. Es un token de larga duración muy sensible.
- **META-004 (`probable`, medio):** la auto-detección de versión de Graph API puede **saltar automáticamente** a una versión recién publicada (hasta v30) que la app no probó, rompiendo insights/creatives/CAPI sin que nadie lo decida.

---

## 25. Autoinstalación del cliente (Installer)

### Paso a paso
1. El cliente pega su Render API Key y elige un subdominio.
2. El Installer crea una Postgres, espera estabilización, crea el web service con env vars, espera el deploy y el health check, y genera un setup token de un solo uso.
3. El cliente ve los pasos por polling y, al terminar, recibe la URL + botón a `/setup`.

### Qué funciona
- Flujo guiado con pasos visibles, reintentos internos de deploy, verificación de env vars aplicadas, setup token de un solo uso y correo opcional "tu app está lista".

### Qué está incompleto
- **INST-001 (`confirmado`, alto): una instalación fallida deja Postgres y web service huérfanos COBRANDO en Render.** El catch solo marca "failed"; nunca borra los recursos ya creados (`installer.service.js:390-394`). Peor: el botón "Intentar de nuevo" crea una instalación **nueva** con base y servicio nuevos, **multiplicando los huérfanos** en cada reintento.
- **INST-002 (`confirmado`, alto): el flag `auto_update_on_push` es código muerto.** El webhook actualiza TODO el canal Test ignorando el flag; apagarlo en una app Test **no impide** su redeploy automático. El toggle del panel no hace lo que dice.

### Qué puede confundir al usuario
- **INST-010 (`probable`, bajo):** no hay rate limiting en `/api/install`; tras un "failed" el cliente puede reintentar repetidamente, acumulando recursos/cobros.

### Qué puede romperse
- **INST-003 (`probable`, alto): auto-update masivo de Test sin canary ni rollback.** Cada push a `main` redespliega de inmediato TODAS las apps Test; si la imagen arranca mal (migración rota, crash), **todos los clientes Test caen a la vez** sin freno automático.
- **INST-004 (`probable`, alto): la llave de cifrado de la Render API Key se deriva de `JWT_SECRET`.** Si en Render se rota/regenera `JWT_SECRET` del portal, el descifrado falla y se pierde el acceso a la API key de **todas** las instalaciones: ni updates ni cancelación centralizada funcionan.
- **INST-008 (`confirmado`, medio):** la Postgres de cada cliente se abre a `0.0.0.0/0` de forma **permanente** (no solo durante soporte); la base con datos del cliente queda accesible desde toda Internet, protegida solo por credenciales.

### Notas a nivel plataforma (no de un flujo de usuario concreto)
- **DB-001 (`confirmado`, alto):** no existe runner de migraciones versionado; los `.sql` en `backend/migrations` **nunca corren en boot** (son scripts manuales). El esquema diverge entre clientes.
- **DB-002 (`confirmado`, alto):** migraciones de datos destructivas (fusión/borrado de contactos) corren en **cada boot sin advisory lock**; con solape de deploy pueden corromper contactos y referencias.
- **DB-003 (`confirmado`/`ajustado`, alto):** el FK `payments.contact_id` es `ON DELETE CASCADE`; **borrar un contacto destruye su historial de pagos** (la fusión, en cambio, sí re-apunta los pagos antes de borrar).
- **CRON-009 (`confirmado`, medio):** todos los crons corren dentro del proceso web sin leader-election ni advisory locks; la corrección depende de que Render mantenga **exactamente 1 instancia**, supuesto no garantizado por código. Cualquier escalado horizontal rompe la idempotencia de CRON-001/003/004/007.
- **SEC-001 (`confirmado`, CRÍTICO):** el proxy `POST /api/external/highlevel/request` permite a cualquier portador de un API token (no admin) ejecutar `method+path` arbitrarios contra HighLevel, tomando **control total** de la cuenta GHL ligada (leer/escribir/borrar contactos, conversaciones, usuarios), incluido DELETE.
- **SEC-002 (`confirmado`, alto):** los webhooks de pago/contacto/refund/appointment se aceptan **sin firma**; cualquiera con la URL puede inyectar pagos y contactos falsos.
- **SEC-003 (`confirmado`, alto):** si falta `ENCRYPTION_MASTER_KEY`, la llave maestra se guarda **en plano en la misma DB** que cifra; un dump del backup entrega llave + ciphertext.
- **SEC-004 (`confirmado`, alto):** no hay rate limiting en login, OAuth authorize ni API externa (mismo defecto que AUTH-001).

---

## 26. Entorno demo (portal/Installer)

### Paso a paso
1. El admin crea un `demo_user` para revisores (p. ej. Meta App Review).
2. El revisor entra por `/api/demo/login` (token tipo demo, 30 días) y navega los endpoints de integraciones.

### Qué funciona
- Token demo separado del de admin, cuenta revocable (se revalida en cada request) y rate limit en el login.

### Qué puede romperse
- **PORTAL-001 (`confirmado`, alto): el demo NO está aislado.** Usa los servicios **globales** de WhatsApp y Meta Ads (las mismas conexiones reales del admin, `demo.routes.js:215-340`). Un `demo_user` puede **enviar mensajes de WhatsApp reales** a terceros, **crear/borrar plantillas reales** en Meta y **cambiar la selección de Meta Ads de producción** (ad account/page/pixel). El revisor cree estar en un sandbox y opera sobre la conexión real.

### Notas a nivel portal (seguridad, no flujo de usuario directo)
- **PORTAL-002 (`confirmado`, alto):** `setup-token/verify` (peek) devuelve el **hash de contraseña del dueño** de forma repetible, y el token viaja en query string (`/sso?token=`); quien lo capture puede extraer el hash para crackeo offline.
- **PORTAL-003 (`confirmado`, alto):** el token de release móvil **no es de un solo uso** y su endpoint de credenciales no tiene rate limit; una filtración da acceso 120 min a **todas las credenciales de firma** iOS/Android (p8, certificados, keystores, passwords).
- **PORTAL-005 (`probable`, medio):** `app_url` puede promoverse a un dominio arbitrario desde una llamada de `verify` sin confirmación, redirigiendo returns de OAuth o webhooks a un dominio del atacante.
- **PORTAL-008 (`confirmado`, bajo):** los mensajes de bloqueo de licencia son indistinguibles (mismo texto para `app_url_mismatch`, `installation_mismatch`, etc.), dificultando el diagnóstico del cliente (parece problema de pago cuando es de configuración).

---

## Resumen consolidado de hallazgos por flujo (deduplicado)

| Severidad | Conteo (deduplicado, aprox.) | Ejemplos representativos |
|---|---|---|
| **Crítico** | 3 | NOTI-001 (IA cancela citas confirmadas), SEC-001 (proxy GHL total), MOB-001 (login Android roto en prod) |
| **Alto** | ~38 | CNT-001 (borrado silencioso al editar teléfono), GHL-001 (token en claro revelable), APT-001/002 (doble-booking), AI-004 (link de pago no idempotente), PAY-001 (suscripción Stripe sigue cobrando), PAY-002 (reembolso parcial=total), TRK-001/004 (tracking/forms sin protección), META-001/002 (CPM con reach, Campaign Builder no crea), RPT-001 (costos sin prorrateo), LIC-001/003 (bypass de plan, failure-open), ACL-001/002 (escalada horizontal, contactos ocultos), WA-001/002/003/004, INST-001/002/003/004 |
| **Medio** | ~50 | NOTI-003 (confirmación solo por WA API), GHL-003 (pisa ediciones locales), PAY2-001/002/003 (Conekta doble cobro / sin webhook / MP sin comprobante), AUTO-005/006/007, AI-003/006/007, GCAL-004/005/006/007, META-004/005/006, RPT-003/005/006/007/008, MOB-003/004/006/007 |
| **Bajo** | ~25 | CNT-011 (bulk delete sin progreso), AUTO-010 (variables vacías), AI-008 (traces), TRK-008/009/010, RPT-010 (IVA 16% hardcodeado), PORTAL-008 |

> **Patrones transversales repetidos** (consolidados, citando IDs duplicados):
> - **Crons sin claim atómico / sin lock entre instancias:** APT-009 / CRON-003, AUTO-003 / CRON-004, AI-001 / CRON-007, PAY-008 / PAY2-001 / CRON-001, NOTI-002, GHL-005, META-006, WA-003, CRON-009.
> - **JWT 30 días sin revocación:** AUTH-003 / SEC-007.
> - **Push expone contactos ocultos:** NOTI-004 / MOB-002.
> - **Filtro de contactos ocultos evitable por búsqueda/ID:** ACL-002 / SEC-005.
> - **Webhooks públicos sin firma:** WA-001, WA-004, SEC-002, PAY2-005.
> - **Sin rate limiting:** AUTH-001 / SEC-004 / INST-010 / PORTAL-007 / TRK-004.
> - **SQL solo probado en SQLite truena en Postgres:** PAY-006 / DB-005.

> **Recordatorio honesto:** RPT-002 fue **refutado** y por eso NO se lista como problema: los ingresos del dashboard ya excluyen los reembolsos correctamente.
