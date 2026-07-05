# Mobile Native Parity Checklist

Este documento es el autoprompt persistente para migrar `mobile/` a React
Native sin perder paridad con `/movil`. Si el contexto del chat se compacta o se
pierde, el siguiente agente debe leer este archivo antes de tocar codigo movil.

## Autoprompt obligatorio

Eres el agente encargado de recrear en `mobile/` la experiencia movil publicada
de Ristak bajo `/movil`. No redisenes, no simplifiques y no inventes flujos. Tu
tarea es copiar el resultado final de usuario usando React Native: misma
jerarquia, textos visibles, iconografia, colores, estados, acciones, filtros,
permisos, errores, vacios, loading, gestos y comportamiento.

Antes de implementar cualquier pantalla o subfuncion:

1. Lee la implementacion original relevante en `frontend/src/pages/PhoneChat/`,
   `frontend/src/components/phone/`, servicios usados y CSS asociado.
2. Enumera los elementos visibles, estados y acciones de esa superficie.
3. Implementa el equivalente nativo en `mobile/src/`.
4. Valida typecheck y, cuando aplique, instala en iPhone/Android real.
5. Actualiza este checklist con lo terminado, lo pendiente y cualquier brecha
   temporal documentada.

Si dudas si algo debe existir, vuelve al codigo original. No confies en memoria.

## Fuentes de verdad

- Chat movil original: `frontend/src/pages/PhoneChat/PhoneChat.tsx`.
- Estilos de chat original: `frontend/src/pages/PhoneChat/PhoneChat.module.css`.
- Navegacion movil original: `frontend/src/components/phone/phoneNavigation.ts`.
- Chips/filtros moviles: `frontend/src/components/phone/ui/PhoneFilterChips.tsx`
  y la configuracion en `PhoneChat.tsx`.
- Iconos de canal: `frontend/src/components/phone/PhoneMessageChannelIcon.tsx`.
- App nativa nueva: `mobile/src/App.tsx`, `mobile/src/api.ts`,
  `mobile/src/types.ts`.
- Contrato movil: `docs/MOBILE_APP.md`.
- Manual maestro: `docs/RISTAK_MASTER_MANUAL.md`.

## Estado general

- [x] Crear app React Native/Expo en `mobile/`.
- [x] Separar bundle nativo temporal `com.ristak.native`.
- [x] Login por URL de instalacion + email/password.
- [x] Shell inicial con Chat, Citas, Pagos, Analiticas y Ajustes.
- [x] Primer pase de lista de chats con API real, filtros basicos y filas planas.
- [ ] Paridad completa de Chat.
- [ ] Paridad completa de Citas.
- [ ] Paridad completa de Pagos.
- [ ] Paridad completa de Analiticas.
- [ ] Paridad completa de Ajustes.
- [ ] Push/permisos/entitlements nativos listos para reemplazar `com.ristak.app`.

## Fase Chat

### 1. Bandeja de chats

- [x] Consumir `/api/contacts/chats`.
- [x] Remover layout tipo card en filas.
- [x] Agregar buscador y chips visibles.
- [x] Agregar avatar con foto/inicial y badge de canal.
- [x] Quitar elementos que no existen en `/movil`, como mostrar el correo de
  sesion debajo de `Chats`.
- [x] Usar iconos equivalentes a `/movil` en acciones superiores, buscador,
  chips, vacios, canales y dock.
- [ ] Replicar `PhoneFilterChips`: opciones visibles, conteos, separadores,
  estado activo, chip `+` y comportamiento de manager.
  - Avance: el manager nativo ya abre desde `+`, lista filtros por seccion y
    permite agregar/quitar filtros visibles. Los filtros visibles ya persisten
    localmente en el dispositivo. Falta persistir en `app_config` y conectar
    numeros WhatsApp/presets personalizados reales.
- [ ] Replicar filtros reales: todos, no leidos, citas, clientes, leads,
  comentarios, agente, archivados, numeros WhatsApp y presets personalizados.
- [ ] Replicar fila de archivados y vista de archivados.
  - Avance: `mobile/` ya guarda archivados localmente, oculta esos chats de la
    bandeja normal, muestra fila `Archivados`, permite entrar/salir de la vista
    y restaurar desde acciones del chat. Falta sincronizar con cualquier
    almacenamiento backend si se decide que archivados sea multi-dispositivo.
- [ ] Replicar chat fijo de `Asistente Personal AI`.
  - Avance: la bandeja nativa ya muestra la fila fija `Asistente Personal AI`
    antes de `Archivados` y abre una pantalla nativa placeholder. La fila usa
    la estructura de la fila original: avatar de 48px dentro de slot de 52px,
    texto centrado, meta `Fijo` independiente y separador inferior de ancho
    completo. Falta conectar el historial/proveedor real del asistente de
    `/movil`.
- [ ] Replicar estados de agente: prioridad humana, agente activo/inactivo,
  hub de agente y badges.
- [x] Replicar swipe de fila: Mas, Archivar/Restaurar.
  - Avance: `mobile/` ya desplaza la fila a la izquierda con acciones `Mas` y
    `Archivar/Restaurar`. `Mas` abre un bottom sheet nativo con marcar leido,
    archivar/restaurar y seleccionar; el sheet exacto completo de `/movil`
    queda pendiente en "Mas acciones de chat". El swipe debe mantener la fila
    abierta despues de soltar, mostrar las acciones con alto/ancho alineados a la
    fila, permitir tocar `Mas`/`Archivar` sin que la fila animada tape los
    botones y cerrarse al tocar otra fila o empezar scroll. La apertura no debe
    rebotar/cerrarse por umbral alto ni por cancelacion del responder horizontal:
    un arrastre corto a la izquierda abre y, una vez abierta, un arrastre corto a
    la derecha cierra. Los separadores de chats deben salir del borde inferior
    del area estirada de la fila, no de una linea falsa con padding debajo del
    texto. Las filas base deben conservar altura tactil amplia y avatar grande.
- [x] Replicar filtros horizontales de chat.
  - Avance: los chips de filtros en `mobile/` usan todo el ancho util y arrancan
    al margen izquierdo de la pantalla; no deben quedar centrados con `Todos` o
    cualquier chip lateral cortado al cambiar de filtro.
- [x] Replicar fechas relativas de la lista.
  - Avance: la lista nativa formatea con zona horaria del negocio: `Hoy`,
    `Ayer`, dia de semana para 2 a 6 dias y fecha corta despues de una semana.
- [x] Replicar long press/seleccion multiple.
  - Avance: mantener presionada una fila entra en seleccion multiple, muestra
    check circular, oculta filtros, permite seleccionar visibles, cancelar,
    marcar como leidos via API y archivar/restaurar seleccionados.
- [x] Replicar pull to refresh y copy visible.
  - Avance: la lista nativa ya usa pull to refresh, textos de loading/error y
    vacios equivalentes de primer pase. Aun falta el estado cache-refresh exacto
    de `/movil` cuando se muestra cache y actualiza en segundo plano.
- [ ] Replicar empty/loading/cache-refresh states.
- [ ] Validar visualmente contra `/movil` en telefono.

### 2. Conversacion

- [ ] Header de conversacion con avatar/canal/estado como `/movil`.
  - Avance: `mobile/` ya abre `NativeConversationScreen` desde la bandeja, usa
    avatar/foto/inicial, aro/badge de canal, nombre del contacto, detalle
    principal y acciones de agente, etiqueta y busqueda en el header. Falta
    replicar estado online/agente exacto y selector de numero/remitente de
    `/movil`.
- [ ] Timeline con globos inbound/outbound, email desplegable, media, ubicacion,
  notas de voz, documentos y comentarios FB/IG.
  - Avance: el parser nativo de `buildMessagesFromJourney` ya entiende
    `whatsapp_message`, `meta_message`, `email_message`,
    `appointment_confirmation`, adjuntos basicos, ubicacion, comentarios,
    estados, timestamps de lectura/entrega, reacciones y mensajes de sistema.
    La UI nativa ya agrupa por dia con zona horaria del negocio, pinta globos
    inbound/outbound, media imagen, tarjetas de archivo/ubicacion, contexto de
    comentario, receipts y errores. Falta correo desplegable completo, player
    real de audio/video, documentos abribles y carga incremental de mensajes
    anteriores.
- [ ] Composer completo: texto, adjuntos, camara, ubicacion, sugerencia IA,
  voice note, reply/reactions y teclado.
  - Avance: el composer nativo ya muestra boton de canal, `+`, texto multilinea,
    reloj para programar cuando hay texto, camara cuando esta vacio, preview de
    respuesta, tira de fotos preparadas y boton enviar/mic visual. El `+` abre
    sheet con tomar foto, elegir foto, cita, pagos, programar, etiqueta y mas
    acciones. Falta voice note real, ubicacion, sugerencia IA, plantillas,
    picker avanzado de fecha/hora y soporte de video/audio/documento desde el
    picker.
- [ ] Envio por canal correcto: WhatsApp API, QR, HighLevel, Messenger,
  Instagram, email/SMS cuando aplique.
  - Avance: texto nativo usa `/whatsapp-api/messages/text`; fotos del composer
    usan `/whatsapp-api/messages/image`; programacion usa
    `/whatsapp-api/messages/scheduled`; reacciones intentan
    `/whatsapp-api/messages/reaction`. Falta rutas QR/Baileys, HighLevel,
    Messenger/Instagram Meta nativo, email/SMS y fallback por ventana de 24h
    como en `/movil`.
- [ ] Info de mensaje, receipts, errores, pendientes y reintentos.
  - Avance: long press sobre globo abre bottom sheet con preview, reacciones
    rapidas, responder e informacion de canal/estado/hora. Los globos muestran
    pending/error y ticks sent/delivered/read. Falta reintento real, pantalla
    completa de info del mensaje y acciones especiales de programados.
- [ ] Contact info/modal movil y campos personalizados.
- [ ] Agenda desde chat.
- [ ] Validar en iPhone real.

### 3. Menus y sheets

- [ ] Nuevo chat / selector de contacto.
  - Avance: el boton `+` ya abre bottom sheet nativo reusable, busca contactos
    via `/contacts/search`, mezcla resultados con chats recientes y abre la
    conversacion seleccionada. Falta crear contacto nuevo si no existe y replicar
    todos los estados del sheet original.
- [ ] Selector de destinatarios despues de foto/video.
  - Avance: el boton de camara ya pide permiso, abre camara nativa con
    `expo-image-picker`, muestra preview y selector de destinatario. Falta
    conectar el envio multimedia real por canal/composer.
- [ ] Menu global de agente.
- [ ] Administrador de filtros.
- [ ] Mas acciones de chat.
  - Avance: `mobile/` ya usa bottom sheet desde swipe `Mas`, no `Alert.alert`.
    Incluye agendar cita, registrar pagos, programar mensaje, agregar etiqueta,
    silenciar/quitar silencio, controles del agente, marcar leido,
    archivar/restaurar y seleccionar. `Agregar etiqueta` usa las APIs reales de
    `/contact-tags` y `/contacts/bulk/tags`; `Programar mensaje` usa
    `/whatsapp-api/messages/scheduled` con envio en 1 hora; las acciones del
    agente usan `/conversational-agent/states/:contactId`. El sheet conserva el
    contacto hasta terminar el cierre para poder abrir/cerrar/reabrir sobre el
    mismo chat sin quedarse atorado. El fondo debe atenuarse con fade
    independiente mientras solo el panel se desliza; no debe aparecer un bloque
    oscuro subiendo junto con el sheet. Falta replicar formularios nativos
    completos para crear cita/pago dentro del sheet y selector de fecha/hora
    avanzado para programacion.
- [ ] Sheets de configuracion movil relevantes.

## Validacion minima por fase

- `npm run mobile:native:typecheck`.
- `git diff --check`.
- Instalar Release en iPhone fisico cuando cambie UI principal:
  `npx expo run:ios --device "iPhone Pro de Raúl" --configuration Release`.
- Lanzar `com.ristak.native` sin Metro para confirmar bundle embebido.
- Comparar contra `/movil` abierto localmente o contra el codigo fuente original
  si no hay screenshot disponible.
