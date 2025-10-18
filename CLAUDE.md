- # 🧠 CONTEXTO MAESTRO - RISTAK APP
> **IMPORTANTE**: Este archivo es la fuente de verdad del proyecto. La IA DEBE leerlo SIEMPRE antes de cualquier tarea y actualizarlo cuando haga cambios estructurales.

## 📋 REGLAS CRÍTICAS DE DESARROLLO

### ⚠️ MANDAMIENTOS INQUEBRANTABLES
1. **NUNCA crear archivos nuevos si ya existe uno similar** - SIEMPRE modificar el existente
2. **NUNCA dejar código muerto o componentes huérfanos** - Si no se usa, se elimina
3. **NUNCA duplicar funcionalidad** - Una sola fuente de verdad para cada cosa
4. **NUNCA hacer cambios sin verificar el contexto completo** - Leer TODO el proyecto antes
5. **SIEMPRE actualizar este archivo** cuando cambies la estructura o agregues features
6. **SIEMPRE limpiar imports no usados** y dependencias fantasma
7. **NUNCA commitear console.logs** de debug en producción
8. **🔴 BASE DE DATOS: PRODUCCIÓN = PostgreSQL (Render) - DESARROLLO = SQLite (local nos vale madres)**

### �� FILOSOFÍA DE CÓDIGO
- **Limpio > Rápido**: Preferir código mantenible sobre optimizaciones prematuras
- **Explícito > Implícito**: Nombres descriptivos, nada de magia negra
- **Consistente > Creativo**: Seguir los patrones ya establecidos
- **Actualizar > Parchear**: Si algo está roto, arreglarlo bien, no poner curitas

---

## 🏗️ ARQUITECTURA ACTUAL

### Stack Tecnológico
```
Frontend:
├── React 19.0.0 + TypeScript 5.7.2
├── Vite 6.0.11 (bundler)
├── React Router DOM 7.1.3
├── Recharts 2.15.0 (gráficas)
├── Lucide React (iconos)
└── Lodash 4.17.21 (utilidades)

Backend:
├── Node.js 20+ con ES Modules
├── Express 4.21.2
├── PostgreSQL (pg 8.11.3) - PRODUCCIÓN en Render
├── SQLite3 5.1.7 (desarrollo local - nos vale madres)
├── Node-cron 3.0.3 (tareas programadas)
└── CORS 2.8.5
```

### Estructura de Carpetas
```
/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── common/        # Componentes reutilizables
│   │   │   │   ├── Button/
│   │   │   │   ├── Card/
│   │   │   │   ├── ContactDetailsModal/
│   │   │   │   ├── ContactSearchInput/
│   │   │   │   ├── DateRangePicker/
│   │   │   │   ├── Icon/
│   │   │   │   ├── KpiCard/
│   │   │   │   ├── LineChart/
│   │   │   │   ├── Modal/
│   │   │   │   ├── TabList/
│   │   │   │   ├── Table/
│   │   │   │   ├── Toast/
│   │   │   │   ├── ViewSelector/
│   │   │   │   ├── SyncProgressBar/
│   │   │   │   ├── RecordPaymentModal/  # Modal de registro de pagos offline
│   │   │   │   └── index.ts   # Exportaciones centralizadas
│   │   │   └── layout/
│   │   │       └── AppShell/  # Layout principal
│   │   ├── contexts/          # Estado global
│   │   │   ├── AuthContext.tsx
│   │   │   ├── DateRangeContext.tsx
│   │   │   ├── NotificationContext.tsx
│   │   │   ├── ThemeContext.tsx
│   │   │   └── TimezoneContext.tsx
│   │   ├── pages/             # Páginas/Vistas
│   │   │   ├── Dashboard/
│   │   │   ├── Campaigns/
│   │   │   ├── Contacts/
│   │   │   ├── Reports/
│   │   │   ├── Settings/
│   │   │   │   ├── Settings.tsx
│   │   │   │   ├── HighLevelIntegration.tsx
│   │   │   │   ├── MetaAdsIntegration.tsx
│   │   │   │   ├── PaymentsConfiguration.tsx
│   │   │   │   └── WebTracking.tsx    # Página de configuración del pixel de tracking
│   │   │   ├── Transactions/
│   │   │   ├── Appointments/  # Gestión de calendarios y citas de HighLevel
│   │   │   └── Analytics/     # Página de analíticas (solo visible si tracking configurado)
│   │   ├── services/          # Llamadas API
│   │   │   ├── apiClient.ts
│   │   │   ├── campaignsService.ts
│   │   │   ├── contactsService.ts
│   │   │   ├── dashboardService.ts
│   │   │   ├── highLevelService.ts
│   │   │   ├── reportsService.ts
│   │   │   ├── transactionsService.ts
│   │   │   ├── calendarsService.ts   # Servicio para Calendarios de HighLevel
│   │   │   ├── trackingService.ts    # Servicio para Pixel de Tracking
│   │   │   └── analyticsService.ts   # Servicio para Analíticas
│   │   ├── styles/            # Estilos globales
│   │   │   ├── index.css
│   │   │   ├── theme.css
│   │   │   └── tokens.css
│   │   ├── types/             # TypeScript types
│   │   │   ├── index.ts
│   │   │   ├── facebook.d.ts
│   │   │   └── metrics.ts
│   │   ├── utils/             # Utilidades
│   │   │   ├── format.ts
│   │   │   ├── tableStorage.ts
│   │   │   └── timezone.ts
│   │   ├── App.tsx            # Componente raíz
│   │   └── main.tsx           # Entry point
│   └── dist/                  # Build de producción
│
├── backend/
│   └── src/
│       ├── config/
│       │   ├── constants.js
│       │   └── database.js    # Conexión DB (SQLite/PostgreSQL)
│       ├── controllers/
│       │   ├── dashboardController.js
│       │   ├── highlevelController.js
│       │   ├── metaController.js
│       │   ├── reportsController.js
│       │   ├── webhooksController.js
│       │   ├── calendarsController.js  # Controlador para Calendarios de HighLevel
│       │   └── trackingController.js   # Controlador para Pixel de Tracking
│       ├── jobs/
│       │   └── metaSync.cron.js
│       ├── routes/
│       │   ├── dashboard.routes.js
│       │   ├── highlevel.routes.js
│       │   ├── meta.routes.js
│       │   ├── reports.routes.js
│       │   ├── webhooks.routes.js
│       │   ├── calendars.routes.js    # Rutas para Calendarios API
│       │   └── tracking.routes.js     # Rutas para Pixel de Tracking
│       ├── services/
│       │   ├── highlevelSyncService.js
│       │   ├── metaAdsService.js
│       │   ├── highlevelCalendarService.js  # Servicio para API de Calendarios GHL
│       │   └── trackingService.js     # Servicio para gestión de sesiones de tracking
│       ├── utils/
│       │   ├── dateUtils.js
│       │   └── logger.js      # Sistema de logging personalizado
│       └── server.js          # Entry point del backend
│
└── ristak.db                  # SQLite local (solo para desarrollo - nos vale madres)
```

---

## 🔌 INTEGRACIONES ACTIVAS

### HighLevel
- **Estado**: Implementación parcial (contactos, pipelines, calendarios)
- **Endpoints**: `/api/highlevel/*`, `/api/calendars/*`
- **Servicios**: `highlevelSyncService.js`, `highLevelService.ts`, `highlevelCalendarService.js`, `calendarsService.ts`
- **Funcionalidad**:
  - Sincronización de contactos y pipelines
  - Gestión de calendarios y citas
  - Visualización de horarios disponibles
  - Estadísticas de citas (pendientes, confirmadas, canceladas, reprogramadas)

### Meta Ads (Facebook)
- **Estado**: Parcialmente implementado
- **Endpoints**: `/api/meta/*`
- **Servicios**: `metaAdsService.js`, `campaignsService.ts`
- **Cron Job**: Sincronización cada X minutos via `metaSync.cron.js`
- **Funcionalidad**: Métricas de campañas publicitarias

### Webhooks
- **Estado**: Configurado
- **Endpoint**: `/webhook/*`
- **Controlador**: `webhooksController.js`
- **Funcionalidad**: Recepción de eventos externos

### Pixel de Tracking
- **Estado**: Implementado completamente
- **Endpoints**: `/snip.js`, `/collect`, `/api/tracking/sessions`
- **Servicios**: `trackingService.js`
- **Funcionalidad**:
  - Pixel JavaScript dinámico que captura visitas
  - Same-Origin usando CNAME del cliente (ej. ristak.sudominio.com)
  - Captura UTMs, click IDs (gclid, fbclid, msclkid, ttclid, wbraid, gbraid)
  - Cookies de Facebook (fbc, fbp)
  - Información de dispositivo, navegador, idioma, timezone
  - Gestión automática de sesiones (visitor_id + session_id)
  - API para consultar sesiones capturadas
- **Documentación**: Ver `TRACKING_PIXEL.md`

---

## 📊 MODELO DE DATOS

### Tablas Principales
```sql
-- Estructura actual en uso
contacts: id, email, phone, name, tags, created_at, updated_at
campaigns: id, name, platform, status, metrics, created_at
transactions: id, contact_id, amount, type, date, metadata
reports: id, type, data, generated_at
sessions: session_id, visitor_id, contact_id, utm_*, gclid, fbclid, etc (ver TRACKING_PIXEL.md)
```

### API Endpoints
```
GET    /api/health                      # Health check
GET    /api/dashboard/stats             # KPIs principales
GET    /api/dashboard/chart             # Datos para gráficas
GET    /api/contacts                    # Lista de contactos
GET    /api/campaigns                   # Campañas activas
GET    /api/transactions                # Transacciones
GET    /api/reports                     # Reportes generados

# Calendarios (HighLevel)
GET    /api/calendars                   # Obtener todos los calendarios
GET    /api/calendars/:id               # Obtener calendario específico
GET    /api/calendars/events            # Obtener eventos/citas de un rango
GET    /api/calendars/:id/free-slots    # Obtener slots disponibles
POST   /api/calendars/appointments      # Crear nueva cita
PUT    /api/calendars/appointments/:id  # Actualizar cita
DELETE /api/calendars/events/:id        # Eliminar evento

# Pixel de Tracking (Auto-configuración)
GET    /snip.js                         # Pixel JavaScript (dinámico por dominio)
POST   /collect                         # Recibir eventos del pixel
GET    /api/tracking/sessions           # Obtener sesiones capturadas
GET    /api/tracking/sessions/:id       # Obtener sesión específica
GET    /api/tracking/config             # Detectar dominio automáticamente
POST   /api/tracking/configure          # Guardar snippet en HighLevel

# Webhooks
POST   /webhook/highlevel               # Webhook de HighLevel
POST   /webhook/meta                    # Webhook de Meta
```

---

## 🎨 PATRONES DE DISEÑO

### Frontend
- **CSS Modules** para estilos componentes (`.module.css`)
- **Context API** para estado global (no Redux)
- **Services Layer** para todas las llamadas API
- **Custom Hooks** cuando se reutiliza lógica
- **Barrel exports** en carpetas de componentes (`index.ts`)

### Backend
- **MVC Pattern** (Model-View-Controller)
- **Service Layer** para lógica de negocio
- **Route Handlers** delgados (solo validación y respuesta)
- **Utils** para funciones helper reutilizables
- **Logger personalizado** en vez de console.log

---

## 🔧 CONFIGURACIÓN DE ENTORNO

### ⚠️ REGLA CRÍTICA - PUERTOS FIJOS
**BACKEND SIEMPRE EN PUERTO 3001 - FRONTEND SIEMPRE EN PUERTO 3000**
**NUNCA CAMBIAR ESTOS PUERTOS - ESTÁN HARDCODEADOS EN MÚLTIPLES LUGARES**

### Variables Requeridas
```bash
# ⚠️ DESARROLLO LOCAL - PUERTOS FIJOS ⚠️
# Backend: PORT=3001 (NO CAMBIAR)
# Frontend: puerto 3000 (configurado en vite.config.ts)
# Frontend Proxy: apunta a http://localhost:3001 (FIJO en vite.config.ts)

# Backend .env (desarrollo):
PORT=3001
NODE_ENV=development

# Frontend .env (desarrollo):
VITE_API_URL=http://localhost:3001

# Base de datos:
# PRODUCCIÓN (Render): PostgreSQL con DATABASE_URL (esto es lo que importa)
# DESARROLLO (local): SQLite (ristak.db) - se crea automáticamente (nos vale madres)
```

---

## 📝 ESTADO DE COMPONENTES

### ✅ Componentes Activos y Funcionales
- AppShell, Button, Card, Modal, TabList
- KpiCard, LineChart, Table, SyncProgressBar
- DateRangePicker, ContactDetailsModal, ContactSearchInput
- ViewSelector, Icon, Toast, ToastContainer

### ❌ Componentes Eliminados (NO RECREAR)
- Badge, Select, Input, DatePicker
- SingleDatePicker, DateRangeInput
- SyncProgressBanner

---

## 🚀 CÓMO ARRANCAR LA APP

### ⚠️ REGLA #1 INQUEBRANTABLE ⚠️
**SIEMPRE USAR EL SCRIPT `start-local.sh` DESDE LA RAÍZ DEL PROYECTO**
**NUNCA arrancar frontend o backend por separado con npm run dev**

### Comando Correcto (ÚNICO)
```bash
# Desde la raíz del proyecto /Users/raulgomez/Desktop/Ristak - High Level/
bash start-local.sh

# O con permisos de ejecución:
./start-local.sh
```

### ¿Por qué SIEMPRE usar start-local.sh?
- ✅ Mata procesos viejos en puertos 3000 y 3001
- ✅ Carga variables de entorno correctamente
- ✅ Arranca backend primero y espera que esté listo
- ✅ Arranca frontend después
- ✅ Abre el navegador automáticamente
- ✅ Usa SQLite en local (PostgreSQL es solo para Render/producción)

### ❌ NUNCA hacer esto:
```bash
# ❌ NO hacer esto:
cd backend && npm run dev
cd frontend && npm run dev

# ❌ NO cambiar puertos manualmente
# ❌ NO editar vite.config.ts para cambiar el proxy
# ❌ NO arrancar con DATABASE_URL en el .env del backend
```

## 🛑 COMANDOS ESENCIALES (Solo para casos especiales)

```bash
# Si necesitas detener todo manualmente:
killall node
lsof -ti:3000,3001 | xargs kill -9

# Build de producción (solo cuando sea necesario):
cd frontend && npm run build
```

---

## 🐛 PROBLEMAS CONOCIDOS

### Actuales
- Bundle size warning (>500KB) - Considerar code splitting
- Falta implementación completa de HighLevel API

### Funcionalidades Implementadas
- ✓ Edición de contactos desde la tabla (modal con campos editables: nombre, email, teléfono, fuente, nombre del anuncio, ID del anuncio)
- ✓ Eliminación de contactos con modal de confirmación
- ✓ Endpoints backend PUT /api/contacts/:id y DELETE /api/contacts/:id
- ✓ Protección contra eliminación accidental con confirmación explícita
- ✓ Registro de pagos offline (RecordPaymentModal):
  - Búsqueda de contactos en tiempo real
  - 2 tipos de cobro: directo (solo monto) o desde productos guardados
  - Permite personalizar monto del producto seleccionado
  - Crea invoice en HighLevel y lo marca como pagado automáticamente
  - 3 opciones de pago: Enviar enlace, Cobrar tarjeta guardada (solo si Stripe está conectado), Registrar pago manual
  - Detección automática de Stripe: Si no está configurado, solo muestra opciones de enlace y pago manual
  - Alerta visual cuando Stripe no está disponible con instrucciones para configurarlo
  - Endpoints: GET /api/highlevel/products, GET /api/highlevel/products/:id/prices, POST /api/highlevel/invoices, POST /api/highlevel/invoices/:id/record-payment, GET /api/highlevel/stripe-config
  - Integrado en página de Transactions con botón "+ Registrar pago"
  - ⚠️ Nota: Cargar productos requiere scope `products.readonly` en el token de HighLevel. El cobro directo funciona sin este scope.

- ✓ Gestión de Calendarios y Citas (página Appointments):
  - Visualización de calendarios de HighLevel con navegación entre calendarios
  - Vista mensual de calendario con eventos agrupados por día
  - KPIs de citas: pendientes, canceladas, confirmadas, reprogramadas
  - Lista de próximas citas ordenadas cronológicamente
  - Código de colores según estado de cita (confirmada, pendiente, cancelada, etc.)
  - Integración completa con API de Calendarios de HighLevel
  - Backend endpoints: GET /api/calendars, GET /api/calendars/:id, GET /api/calendars/events, GET /api/calendars/:id/free-slots
  - Servicios: highlevelCalendarService.js (backend), calendarsService.ts (frontend)
  - Ruta: /appointments
  - ⚠️ Nota: Requiere locationId y accessToken de HighLevel configurados
  - ⚠️ Vista semana/día en desarrollo (placeholder implementado)

- ✓ **Pixel de Tracking implementado (2025-10-17)**:
  - Sistema completo de tracking con pixel JavaScript dinámico
  - Same-Origin usando CNAME (ej. ristak.cliente.com)
  - Captura UTMs, click IDs (gclid, fbclid, msclkid, ttclid, wbraid, gbraid)
  - Cookies de Facebook (fbc, fbp), device info, referrer, IP
  - Tabla `sessions` con 50+ campos de atribución
  - **Auto-configuración de 1 clic**: GET /api/tracking/config, POST /api/tracking/configure
  - Detección automática de dominio personalizado (prioridad: TRACKING_DOMAIN env var > req.headers.host > RENDER_EXTERNAL_URL)
  - Guarda snippet automáticamente en HighLevel custom value `rstktrack`
  - Usuario solo agrega `{{ custom_values.rstktrack }}` en <head> de su sitio
  - Endpoints: GET /snip.js, POST /collect, GET /api/tracking/sessions
  - Backend: trackingController.js, trackingService.js, tracking.routes.js
  - Frontend: WebTracking.tsx (en Settings), trackingService.ts
  - Página de configuración con snippet generator y stats en tiempo real
  - Ruta: /settings/tracking
  - Documentación completa en TRACKING_PIXEL.md y PIXEL_SETUP.md
  - Sin hardcodear dominios (detección dinámica por req.headers.host)
  - Base de datos: PostgreSQL en producción (Render), SQLite en local

- ✓ **Página de Analíticas implementada (2025-10-18)**:
  - Página completa de analíticas basada en datos de la tabla `sessions`
  - **Visibilidad condicional**: Solo aparece en el menú si el tracking está configurado en HighLevel
  - 8 KPIs principales con tendencias vs período anterior:
    - Visualizaciones de página, Visitantes únicos, Registros, Conversión
    - Tasa de rebote, Duración promedio, Usuarios recurrentes, Páginas/sesión
  - Gráfico de área dual: Visitas totales + Visitantes únicos por fecha
  - Comparación automática con período anterior (mismo número de días hacia atrás)
  - Cálculo de registros reales: contactos que aparecen tanto en `contacts` como en `sessions`
  - Backend endpoints: GET /api/tracking/sessions?start=YYYY-MM-DD&end=YYYY-MM-DD
  - Usa endpoint existente GET /api/tracking/config para detectar si tracking está activo
  - Backend: trackingController.js (modificado), trackingService.js (getSessionsByDateRange agregado)
  - Frontend: Analytics.tsx, analyticsService.ts
  - Sidebar.tsx: Llama a checkTrackingStatus() y agrega "Analíticas" al menú solo si isConfigured === true
  - Ruta: /analytics (solo accesible si tracking configurado)
  - Diseño adaptado al estilo de la app (mismo patrón que Dashboard y otras páginas)
  - Duración promedio estimada (events_count * 45 segundos) - No es tiempo real

### Resueltos
- ✓ Lodash instalado como dependencia directa
- ✓ 7 componentes huérfanos eliminados (Badge, Select, Input, DatePicker, SingleDatePicker, DateRangeInput, SyncProgressBanner)
- ✓ Imports no usados limpiados
- ✓ Puerto sincronizado a 3001 en todo el proyecto (antes era inconsistente 3001 vs 3002)
- ✓ Health check endpoint corregido en start-local.sh (/api/health)
- ✓ useEffect con dependencias incorrectas arreglado en Campaigns.tsx
- ✓ URL hardcodeada eliminada en Campaigns.tsx (ahora usa campaignsService)
- ✓ console.logs de producción eliminados (frontend y backend)
- ✓ Backend usa logger consistentemente en lugar de console.log
- ✓ formatChartDate movido a utils/format.ts para reutilización
- ✓ Archivos .env.example consolidados (solo uno en raíz con documentación completa)
- ✓ Mapeo correcto de fechas de GHL: created_at guarda dateAdded (no fecha de sincronización)
- ✓ Tabla contacts actualizada con campo updated_at
- ✓ Sincronización actualiza estadísticas de contactos automáticamente (total_paid, purchases_count, last_purchase_date)
- ✓ Webhooks recalculan estadísticas en tiempo real al recibir pagos/reembolsos
- ✓ appointment_date se actualiza correctamente al sincronizar/recibir citas
- ✓ Tooltips en gráficos corregidos (LineChart y AreaChart):
  - Reemplazado SmartRechartsTooltip roto (heredado de otra app)
  - Implementación simplificada que funciona correctamente con Recharts
  - Props simplificadas (solo content, cursor, wrapperStyle)
  - Tooltips ahora visibles al hacer hover sobre los gráficos
  - CSS mejorado para .recharts-tooltip-wrapper y .recharts-default-tooltip
  - Build exitoso sin errores de compilación
- ✓ Tracking pixel: prioridad de detección de dominio corregida (2025-10-17):
  - Bug: Detectaba ristak-app.onrender.com en vez de ristak.midominio.com
  - Fix: Cambió prioridad a TRACKING_DOMAIN env var > req.headers.host > RENDER_EXTERNAL_URL
  - Ahora captura correctamente custom domains cuando el usuario accede vía CNAME
  - Aplicado en getTrackingConfig y configureTracking
  - Probado con curl -H "Host: ristak.midominio.com" → funciona correctamente

---

## 📅 ÚLTIMA ACTUALIZACIÓN

**Fecha**: 2025-10-18
**Versión**: 1.8.1
**Último cambio estructural**:
- **Fix crítico: PostgreSQL restaurado para producción**
  - Dependencia 'pg' agregada de vuelta al package.json
  - PRODUCCIÓN (Render): Usa PostgreSQL con DATABASE_URL - ESTO ES LO QUE IMPORTA
  - DESARROLLO (local): Usa SQLite - nos vale madres, solo para testing local
  - Componentes faltantes agregados: Layout, Badge
  - Build en Render exitoso

---

## ⚡ CHECKLIST ANTES DE MODIFICAR

Antes de hacer CUALQUIER cambio, la IA debe:

- [ ] Leer este archivo completo
- [ ] Verificar si ya existe código similar
- [ ] Buscar componentes/funciones relacionadas
- [ ] Validar que no rompe nada existente
- [ ] Actualizar este archivo si cambia la estructura
- [ ] Eliminar código muerto que genere
- [ ] Verificar imports y dependencias
- [ ] **VERIFICAR que los puertos sigan siendo 3000 (frontend) y 3001 (backend)**
- [ ] **VERIFICAR que start-local.sh sigue siendo el método de inicio**
- [ ] Hacer build para confirmar que compila

---

## 🔴 RECORDATORIO FINAL

**NUNCA OLVIDES**: Este proyecto debe mantenerse LIMPIO, ORDENADO y SIN REDUNDANCIAS. Cada línea de código debe tener un propósito. Si no lo tiene, no debe existir.

**ACTUALIZA ESTE ARCHIVO** cuando:
- Agregues/elimines componentes
- Cambies la estructura de carpetas
- Implementes nuevas integraciones
- Modifiques el modelo de datos
- Encuentres/resuelvas problemas

NO agregues historial de cambios. ACTUALIZA la información existente para reflejar el estado ACTUAL.
- Siempre se usa este archivo para correr la app @start-local.sh y las direcciones que vienen ahi
