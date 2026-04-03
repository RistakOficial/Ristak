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
7. **NUNCA commitear logs de consola** de debug en producción
8. **🔴 ENTORNO DE TRABAJO: TODO ES RENDER (PRODUCCIÓN)**
   - SIEMPRE commit + push después de cada cambio
   - Los cambios se ven en Render directamente
   - PostgreSQL es la ÚNICA base de datos
   - Render auto-deploya en cada push a main
9. **❌ NUNCA usar alertas nativas del browser** - SIEMPRE usar modales personalizados
   - ❌ Prohibido: `alert()`, `confirm()`, `prompt()`, `window.alert()`, `window.confirm()`, `window.prompt()`
   - ✅ Usar: `showConfirm()`, `showAlert()`, `showInfo()` del NotificationContext
   - ✅ Para modales personalizados: Modal component con `createPortal` de React
   - ✅ Diseño minimalista: sin barras de colores, sin fondos en iconos, gris neutro
   - 🎯 Objetivo: UX consistente, elegante y profesional en toda la app
10. **🚫 NUNCA implementar OAuth centralizado para integraciones de terceros**
   - ❌ PROHIBIDO: OAuth flows donde la app de Ristak actúa como intermediario
   - ❌ Razón: Cada usuario tiene su propia app de Facebook/Meta/Google con credenciales únicas
   - ❌ No se puede usar un App ID/Secret centralizado para todos los usuarios
   - ✅ En su lugar: Configuración manual con tokens de acceso propios de cada usuario
   - ✅ Documentación clara de cómo obtener sus propias credenciales
   - 🎯 Aplica a: Meta Ads, Google Ads, TikTok Ads, cualquier plataforma de anuncios
11. **💰 NUNCA sumar pagos reembolsados o cancelados como ingresos** [CRÍTICO]
   - ❌ PROHIBIDO: Sumar payments sin filtrar por status
   - ❌ NO CONTAR: 'refunded', 'cancelled', 'void', 'failed', 'pending'
   - ✅ SOLO CONTAR: 'succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'
   - 🎯 Filtrar en:
     - Queries SQL: `WHERE LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')`
     - JavaScript/TypeScript: `.filter(p => validStatuses.includes(p.status?.toLowerCase()))`
   - 📍 Aplica a:
     - `total_paid` en contactos (tabla contacts y cálculos)
     - LTV/Revenue en métricas y dashboards
     - Totales en modales de contactos
     - Reportes de transacciones
     - Cualquier suma de amounts de pagos
   - 🔧 Constante en backend: `SUCCESS_PAYMENT_STATUSES` (analyticsService.js:53)
12. **🔒 NUNCA borrar Custom Values en HighLevel al eliminar campos en Ristak** [SEGURIDAD]
   - ❌ PROHIBIDO: Enviar valores vacíos (`''` o `null`) a HighLevel Custom Values
   - ❌ PROHIBIDO: Hacer DELETE de Custom Values desde Ristak
   - ✅ Al borrar un chip en UI: SOLO limpiar estado local + base de datos de Ristak
   - ✅ Custom Values en HighLevel se mantienen INTACTOS cuando borras
   - ✅ Custom Values solo se REEMPLAZAN cuando guardas un NUEVO valor válido
   - 🎯 Implementado en:
     - Frontend: `handleRemoveCredential()` solo limpia estado (MetaAdsIntegration.tsx:227)
     - Backend: Filtro en `syncMetaCustomValues()` (metaAdsService.js:190)
     - Backend: Filtro en `saveMetaCustomValues()` (highlevelSyncService.js:1007)
   - 🔧 Filtro: `if (!value || value.trim() === '') continue` (NO envía a HighLevel)
   - 📍 Razón: Protección contra borrado accidental de credenciales importantes en HighLevel

### 🎯 FILOSOFÍA DE CÓDIGO
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
├── PostgreSQL (pg 8.11.3)
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
│       │   └── database.js    # Conexión DB PostgreSQL
│       ├── controllers/
│       │   ├── dashboardController.js
│       │   ├── highlevelController.js
│       │   ├── metaController.js
│       │   ├── reportsController.js
│       │   ├── webhooksController.js
│       │   ├── calendarsController.js  # Controlador para Calendarios de HighLevel
│       │   └── trackingController.js   # Controlador para Pixel de Tracking
│       ├── jobs/
│       │   ├── metaSync.cron.js           # Cron: Sincroniza Meta Ads cada hora
│       │   └── contactsSync.cron.js       # Cron: Sincroniza contactos de GHL cada hora (silencioso)
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
- **Cron Job**: Sincronización cada hora via `metaSync.cron.js`
- **Funcionalidad**: Métricas de campañas publicitarias
- **🆕 Selección Automática de Cuentas y Pixeles (2025-10-20)**:
  - **Nuevos endpoints**:
    - `GET /api/meta/ad-accounts?accessToken=xxx`: Obtiene todas las cuentas de anuncios del usuario
    - `GET /api/meta/pixels?adAccountId=act_xxx&accessToken=xxx`: Obtiene pixeles de una cuenta
  - **Frontend mejorado** (MetaAdsIntegration.tsx):
    - Sección "Selección Rápida" con dropdowns automáticos
    - Usuario ingresa Access Token → click "Cargar Cuentas" → selecciona de dropdown
    - Al seleccionar cuenta → auto-carga pixeles → selecciona de dropdown
    - Información completa: nombre, ID, moneda, timezone de cada cuenta
    - UX 1000% mejor: sin copiar/pegar, sin errores de tipeo
  - **Almacenamiento de Pixel ID**: Nuevo campo `pixel_id` en tabla `meta_config`
- **Auto-configuración de Custom Values**:
  - Al conectar cuenta de Meta, se crean/actualizan automáticamente 5 custom values en HighLevel:
    - `Facebook - Ad Account ID`: ID de la cuenta de anuncios
    - `Facebook - App Access Token`: Token de acceso (sin encriptar en GHL)
    - `Facebook - Pixel ID`: ID del pixel seleccionado (nuevo, opcional)
    - `Facebook - App ID`: App ID de Facebook (opcional)
    - `Facebook - App Secret`: App Secret de Facebook (opcional, sin encriptar en GHL)
  - Si no existe configuración de HighLevel, se salta este paso con warning
  - La función `syncMetaCustomValues()` crea nuevos o actualiza existentes (POST/PUT automático)
- **Timezone**:
  - Al conectar cuenta de Meta, se obtiene automáticamente `timezone_id`, `timezone_name`, `timezone_offset_hours_utc`
  - Ejemplo: timezone_name = "America/Los_Angeles", timezone_offset_hours_utc = -8
  - Las fechas de Meta se guardan TAL CUAL (representan el "día" en el timezone del anunciante)
  - **Importante**: Las fechas de Meta NO se convierten a UTC (se guardan como vienen: YYYY-MM-DD)
  - Utilidades en `dateUtils.js`: `convertMetaDateToUTC()`, `convertUTCToMetaDate()` (disponibles si se necesitan)

### Cron Jobs (Tareas Programadas)
- **Estado**: Implementado y activo
- **Archivos**: `backend/src/jobs/*.cron.js`
- **Cron Jobs Activos**:
  1. **`metaSync.cron.js`**: Sincroniza anuncios de Meta Ads cada hora (a las XX:00)
     - Actualiza métricas de campañas publicitarias (gasto, clicks, alcance, impresiones)

  2. **`highlevelSync.cron.js`**: Sincroniza TODO de HighLevel cada hora (a las XX:00)
     - Sincroniza: **Contactos, Citas (Appointments), Pagos (Invoices/Transacciones)**
     - **Característica importante**: Este cron usa `triggerSource: 'cron'` para NO mostrar la barra lateral de progreso
     - Solo las sincronizaciones manuales (desde Settings) muestran la barra lateral (`triggerSource: 'manual'`)
     - Mantiene la DB actualizada automáticamente en caso de cambios externos
     - **Nota**: NO necesitas cron separado de invoices, este ya sincroniza pagos/invoices

  3. **`metaVersionCron.js`**: Actualiza versión de Meta API cada 6 meses
     - Se ejecuta día 1 y 15 de cada mes a las 3:00 AM (timezone: America/Mexico_City)
     - Verifica si han pasado 6 meses desde la última actualización
     - Detecta y actualiza a la versión más reciente de Meta API automáticamente

- **Configuración**: Se inician automáticamente al arrancar el servidor (`server.js` líneas 117-119)

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
meta_config: id, ad_account_id, access_token, timezone_id, timezone_name, timezone_offset_hours_utc
meta_ads: id, date, ad_account_id, campaign_id, ad_id, spend, reach, clicks, cpc, cpm, ctr
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
POST   /api/calendars/appointments      # Crear nueva cita (acepta contactId y assignedUserId opcionales)
PUT    /api/calendars/appointments/:id  # Actualizar cita
DELETE /api/calendars/events/:id        # Eliminar evento

# Contactos y Usuarios (HighLevel)
POST   /api/highlevel/contacts/search   # Buscar contactos en tiempo real
GET    /api/highlevel/contacts/:id      # Obtener contacto por ID
GET    /api/highlevel/users             # Obtener usuarios del location

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
- **Componente Table con re-cómputo reactivo** (`Table.tsx:89`):
  - Las columnas se recomputan automáticamente cuando cambian las dependencias (ej: dateRange, viewType)
  - Los render callbacks de cada columna se sincronizan con el estado actual sin recargar la página
  - Evita callbacks obsoletos (stale closures) que causaban que los modales mostraran datos de rangos anteriores
  - useEffect observa: `[columns, savedLayout]` → recomputa `processedColumns` → sincroniza con `internalColumns`
  - ⚠️ **Crítico**: Sin este patrón, la tabla cache los primeros callbacks y los modales consultan fechas viejas

### Backend
- **MVC Pattern** (Model-View-Controller)
- **Service Layer** para lógica de negocio
- **Route Handlers** delgados (solo validación y respuesta)
- **Utils** para funciones helper reutilizables
- **Logger personalizado** en vez de usar la consola

---

## 🔧 CONFIGURACIÓN DE ENTORNO

### Variables Requeridas en Render
```bash
# Backend en Render:
NODE_ENV=production
DATABASE_URL=<postgres-connection-string>  # Auto-generado por Render
HIGHLEVEL_CLIENT_ID=<tu-client-id>
HIGHLEVEL_CLIENT_SECRET=<tu-client-secret>
TRACKING_DOMAIN=<tu-dominio-personalizado>  # Opcional, ej: ristak.tudominio.com

# Frontend en Render:
VITE_API_URL=<url-backend-render>  # ej: https://ristak-api.onrender.com
```

---

## 📝 SISTEMA DE NOTIFICACIONES Y MODALES ESTANDARIZADO

### 🎯 Regla de Oro
**NUNCA usar alertas/confirmaciones nativas del browser. SIEMPRE usar NotificationContext.**

### ✅ Cómo Usar Notificaciones y Modales

#### 1. Importar el hook
```typescript
import { useNotification } from '@/contexts/NotificationContext'

const { showToast, showConfirm, showAlert, showInfo } = useNotification()
```

#### 2. Mostrar Toasts (notificaciones temporales)
```typescript
// Éxito
showToast('success', 'Operación exitosa', 'El registro se guardó correctamente')

// Error
showToast('error', 'Error al guardar', 'No se pudo completar la operación')

// Advertencia
showToast('warning', 'Atención', 'Algunos campos no están completos')

// Información
showToast('info', 'Información', 'Esta acción puede tardar unos minutos')
```

#### 3. Mostrar Modales de Confirmación
```typescript
// Confirmación (con botones Cancelar y Aceptar)
showConfirm(
  'Eliminar pago',
  '¿Estás seguro de eliminar este pago? Esta acción no se puede deshacer.',
  async () => {
    // Acción al confirmar
    await deletePayment(id)
    showToast('success', 'Pago eliminado')
  },
  'Eliminar',  // Texto del botón confirmar (opcional)
  'Cancelar'   // Texto del botón cancelar (opcional)
)

// Alerta (solo botón Aceptar)
showAlert(
  'Error crítico',
  'No se pudo conectar con el servidor. Intenta nuevamente.',
  'Entendido'  // Texto del botón (opcional)
)

// Información (solo botón Aceptar, diseño neutral)
showInfo(
  'Actualización disponible',
  'Hay una nueva versión de la aplicación disponible.',
  'Aceptar'  // Texto del botón (opcional)
)
```

#### 4. Modales Personalizados
Para modales con contenido custom (formularios, etc):
```typescript
import { Modal } from '@/components/common'
import { createPortal } from 'react-dom'

const [isOpen, setIsOpen] = useState(false)

return createPortal(
  <Modal
    isOpen={isOpen}
    onClose={() => setIsOpen(false)}
    title="Título del Modal"
    size="md"  // sm | md | lg | xl
    type="custom"
  >
    {/* Contenido custom aquí */}
  </Modal>,
  document.body
)
```

### 🎨 Diseño de Modales Estandarizado
- ✅ Sin barras de colores superiores
- ✅ Iconos grises simples (24x24px)
- ✅ Sin fondos de colores en iconos
- ✅ Diseño minimalista y elegante
- ✅ Consistente en toda la app

---

## 📝 ESTADO DE COMPONENTES

### ✅ Componentes Activos y Funcionales
- AppShell, Button, Card, Modal, TabList
- KpiCard, LineChart, Table, SyncProgressBar
- DateRangePicker, DateTimePicker, ContactDetailsModal, ContactSearchInput
- ViewSelector, Icon, Toast, ToastContainer, RecordPaymentModal, AppointmentModal

### ❌ Componentes Eliminados (NO RECREAR)
- Badge, Select, Input, DatePicker
- SingleDatePicker, DateRangeInput
- SyncProgressBanner

---

## 🚀 CÓMO DEPLOYAR CAMBIOS

### Flujo de Trabajo en Render
1. **Hacer cambios** en el código (en GitHub o con git)
2. **Commit + Push** a la rama `main`:
   ```bash
   git add .
   git commit -m "feat: descripción del cambio"
   git push origin main
   ```
3. **Render auto-deploya** en ~3-5 minutos
4. **Verificar** en la URL de producción

### Comandos Git Útiles
```bash
# Ver estado de cambios
git status

# Hacer commit de todos los cambios
git add .
git commit -m "descripción del cambio"

# Subir a Render (trigger deploy automático)
git push origin main

# Ver logs del último commit
git log -1
```

---

## 🐛 PROBLEMAS CONOCIDOS

### Actuales
- Bundle size warning (>500KB) - Considerar code splitting
- Falta implementación completa de HighLevel API

### Funcionalidades Implementadas
- ✓ **Página de Contactos (Contacts.tsx)**:
  - Edición de contactos desde la tabla (modal con campos editables: nombre, email, teléfono, fuente, nombre del anuncio, ID del anuncio)
  - Eliminación de contactos con modal de confirmación
  - **Modal de detalles de contacto** con secciones:
    - Información Personal (nombre, email, teléfono, estado)
    - Historial de Compras (total de compras, pagos totales, última compra)
    - **Citas** (primera cita histórica, próxima cita agendada)
    - De dónde llegó el contacto (fuente, anuncio, ID del anuncio)
  - Backend calcula fechas de citas desde tabla `appointments`:
    - `firstAppointmentDate`: la cita más antigua del contacto
    - `nextAppointmentDate`: la cita más cercana en el futuro que no esté cancelada
    - **🎯 ATRIBUCIÓN**: Para métricas de campañas, las citas se cuentan basándose en la **fecha de creación del contacto**, NO en la fecha de la cita. Esto es crítico para medir correctamente la atribución de marketing:
      - Si un contacto se creó el 1 de enero y agenda su primera cita el 15 de febrero, la cita se atribuye a las campañas del 1 de enero
      - Esto permite medir el verdadero impacto de las campañas publicitarias en la generación de citas
      - Un contacto con múltiples citas cuenta como 1 solo contacto con cita (métrica binaria: tiene o no tiene cita)
      - La lógica está implementada en `metaController.js` y `analyticsService.js`
  - Datos de citas: Se obtienen primero de la DB local (tabla `appointments`), y si no existen, se hace fallback a HighLevel API en tiempo real
  - Endpoints backend: PUT /api/contacts/:id, DELETE /api/contacts/:id, GET /api/contacts/:id
  - Protección contra eliminación accidental con confirmación explícita
- ✓ Registro de pagos offline (RecordPaymentModal):
  - Búsqueda de contactos en tiempo real
  - 2 tipos de cobro: directo (solo monto) o desde productos guardados
  - Permite personalizar monto del producto seleccionado
  - Crea invoice en HighLevel y lo marca como pagado automáticamente
  - **Text2Pay implementado (2025-10-25)**: Envío de links de pago por Email, WhatsApp/SMS, o Ambos
    - 3 botones separados en vez de solo "Enviar enlace"
    - "Enviar por Email" → Envía invoice por correo electrónico
    - "Enviar por WhatsApp" → Envía invoice por SMS/WhatsApp (según configuración de GHL)
    - "Enviar por Ambos" → Envía por email Y WhatsApp simultáneamente
    - HighLevel maneja el envío internamente (no requiere Twilio ni servicios externos)
    - Método `sendInvoice()` acepta parámetro `sendMethod`: 'email' | 'sms' | 'both' | 'none'
    - Respeta modo de Stripe (test/live) automáticamente
  - 3 opciones de pago: Enviar enlace (con Text2Pay), Cobrar tarjeta guardada (solo si Stripe está conectado), Registrar pago manual
  - Detección automática de Stripe: Si no está configurado, solo muestra opciones de enlace y pago manual
  - Alerta visual cuando Stripe no está disponible con instrucciones para configurarlo
  - Endpoints: GET /api/highlevel/products, GET /api/highlevel/products/:id/prices, POST /api/highlevel/invoices, POST /api/highlevel/invoices/:id/send, POST /api/highlevel/invoices/:id/record-payment, POST /api/highlevel/text2pay, GET /api/highlevel/stripe-config
  - Integrado en página de Transactions con botón "+ Registrar pago"
  - ⚠️ Nota: Cargar productos requiere scope `products.readonly` en el token de HighLevel. El cobro directo funciona sin este scope.

- ✓ Gestión de Calendarios y Citas (página Appointments):
  - Visualización de calendarios de HighLevel con navegación entre calendarios
  - Vista mensual de calendario con eventos agrupados por día
  - KPIs de citas: pendientes, canceladas, confirmadas, reprogramadas
  - Lista de próximas citas ordenadas cronológicamente
  - Código de colores según estado de cita (confirmada, pendiente, cancelada, etc.)
  - **Creación/edición de citas con modal en 2 columnas**:
    - Modal con layout responsivo: columna izquierda (asignación), columna derecha (configuración)
    - Búsqueda en tiempo real de contactos por nombre, email o teléfono (OBLIGATORIO)
    - Auto-fill del título con el nombre del contacto seleccionado
    - **Soporte para calendarios Round Robin**:
      - Detección automática de calendarios Round Robin (calendarType o eventType)
      - Filtrado de usuarios: solo muestra team members del calendario Round Robin
      - Selector de team member obligatorio para Round Robin
      - Texto de ayuda explicando la funcionalidad
    - Validaciones: contacto siempre requerido, team member requerido para Round Robin
    - Modal de confirmación para eliminación (nunca usa alert() del browser)
    - Backend endpoints: GET /api/highlevel/contacts/:id, GET /api/highlevel/users
  - Integración completa con API de Calendarios de HighLevel
  - Backend endpoints: GET /api/calendars, GET /api/calendars/:id, GET /api/calendars/events, GET /api/calendars/:id/free-slots, POST /api/calendars/appointments, PUT /api/calendars/appointments/:id, DELETE /api/calendars/events/:id
  - Servicios: highlevelCalendarService.js (backend), calendarsService.ts (frontend), ghlClient.js (método getLocationUsers)
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
  - Base de datos: PostgreSQL

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

- ✓ **Sistema Híbrido de Configuración (2025-10-18)** [IMPLEMENTADO]:
  - Sistema centralizado para TODA la configuración de la app (preferencias, columnas de tablas, etc)
  - **Arquitectura híbrida**:
    - **LocalStorage**: Cache de lectura rápida (0ms, funciona offline)
    - **PostgreSQL**: Fuente de verdad (persistencia confiable, sync entre dispositivos)
    - **Sincronización automática**: Al cargar la página, valida con DB y actualiza cache si difiere
  - **Endpoints backend**:
    - GET /api/config: Lee toda la configuración o keys específicas (?keys=key1,key2)
    - POST /api/config: Guarda una o múltiples configs (body: {key, value} o {config: {...}})
    - DELETE /api/config: Elimina configs (?keys=key1,key2)
  - **Hooks frontend**:
    - `useAppConfig(key, defaultValue)`: Config individual con cache + DB sync
    - `useAppConfigs([keys])`: Múltiples configs a la vez
    - `useTableConfig(tableId)`: Específico para configuración de tablas (columnas, orden, visibilidad)
  - **Migración completada**:
    - ✅ visitor_source preference (plataforma vs tracking interno)
    - ✅ show_analytics preference (mostrar/ocultar Analytics en menú)
    - ✅ Configuración de columnas de todas las tablas (orden, visibilidad, anchos)
  - **Ventajas**:
    - Lectura instantánea desde cache (no espera a DB)
    - Persiste aunque borres cookies/localStorage (respaldo en DB)
    - Consistente entre dispositivos (sincroniza desde DB)
    - Resiliente: funciona offline con cache
    - Centralizado: un solo sistema para toda la app
  - **Archivos**:
    - Backend: configController.js, config.routes.js
    - Frontend: hooks/useAppConfig.ts, hooks/index.ts
    - Modificados: WebTracking.tsx, Campaigns.tsx, Reports.tsx, Table.tsx
  - **Deprecado**: utils/tableStorage.ts (reemplazado por useTableConfig hook)

- ✓ **Toggle de Fuente de Visitantes (2025-10-18)** [USA SISTEMA HÍBRIDO]:
  - Opción en Settings/Web Tracking para elegir fuente de visitantes: "Plataforma de Anuncios" vs "Tracking Interno"
  - Afecta páginas de Campaigns y Reports mostrando visitantes de Meta/Google o del tracking interno
  - **Ahora usa sistema híbrido de configuración** (useAppConfig hook)
  - **Páginas afectadas**:
    - **Campaigns**: Actualiza visitantes en ads cuando está en modo "Tracking Interno"
    - **Reports**: Actualiza columna de visitantes cuando está en modo "Tracking Interno"
  - **Backend endpoints**:
    - GET /api/tracking/visitors-by-ad: Obtiene visitantes únicos por ad_id desde sessions
    - GET /api/tracking/visitors-by-period: Obtiene visitantes agrupados por período (día/semana/mes/año)
  - **Persistencia**: Sistema híbrido (cache + PostgreSQL app_config)
  - **Detección de visitor**: Webhook /contacts SOLO acepta campo 'rkvi_id' (prohibido visitor_id o rstk_vid)
  - **Matching visitor-contacto**: 4 métodos (form submit, _ud cookie, link manual, rkvi_id en _ud)

- ✓ **Configuración de Calendarios (2025-10-19)** [USA SISTEMA HÍBRIDO]:
  - Nueva sección en Settings para configurar calendarios
  - **Funcionalidades**:
    - **Calendario Predeterminado**: Se selecciona automáticamente al abrir página de Appointments
    - **Calendarios de Atribución**: Elegir qué calendarios cuentan para métricas de marketing
  - **Impacto**:
    - Citas de calendarios NO seleccionados NO aparecen en:
      - Columna "Citas" en Reports y Campaigns
      - Timeline del Viaje del Cliente (Customer Journey)
      - Métricas de atribución de campañas
      - Dashboard de métricas generales
  - **Sistema híbrido** (useAppConfig):
    - `default_calendar_id`: Calendario que se selecciona automáticamente
    - `attribution_calendar_ids`: Array de IDs de calendarios para atribución
  - **Backend modificado**:
    - appointmentsCache.js: Filtra eventos por calendarios de atribución
    - analyticsService.js: Filtra queries de appointments con calendar_id IN (...)
    - metaController.js: Filtra queries de funnel charts con calendar_id IN (...)
    - contactsController.js: Filtra citas del journey con calendar_id IN (...)
  - **Frontend modificado**:
    - CalendarsConfiguration.tsx: Nueva página de configuración
    - Settings.tsx: Agregado menú "Calendarios" (entre Meta Ads y Web Tracking)
    - Appointments.tsx: Lee calendario predeterminado con useAppConfig
  - **Fallback**: Si no hay calendarios configurados, usa TODOS los calendarios disponibles
  - **Ruta**: /settings/calendars
  - **Archivos**:
    - Frontend: CalendarsConfiguration.tsx, Settings.tsx, Appointments.tsx
    - Backend: appointmentsCache.js, analyticsService.js, metaController.js, contactsController.js

### Resueltos
- ✓ Lodash instalado como dependencia directa
- ✓ 7 componentes huérfanos eliminados (Badge, Select, Input, DatePicker, SingleDatePicker, DateRangeInput, SyncProgressBanner)
- ✓ Imports no usados limpiados
- ✓ Puerto sincronizado a 3001 en todo el proyecto (antes era inconsistente 3001 vs 3002)
- ✓ Health check endpoint implementado (/api/health)
- ✓ useEffect con dependencias incorrectas arreglado en Campaigns.tsx
- ✓ URL hardcodeada eliminada en Campaigns.tsx (ahora usa campaignsService)
- ✓ Logs de producción eliminados (frontend y backend)
- ✓ Backend usa logger consistentemente en lugar de salidas directas a consola
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
- ✓ **Chips y badges invisibles en dark mode (2025-10-18)**:
  - Bug crítico: Los estilos usaban `[data-theme="dark"]` pero el sistema usa `body.dark` y `body.light`
  - Primer intento fallido: Cambió selectores a `body.dark` pero CSS Modules hashea las clases (`.success` → `._success_mfnum_26`)
  - **Fix definitivo**: Usar `:global(body.dark)` en CSS Modules para escapar el scope del hash
  - Archivos afectados: Badge.module.css, Appointments.module.css
  - Aumentada opacidad de fondos (0.2→0.3 en badges, 0.25→0.35 en appointments) para mejor contraste
  - Texto blanco (#ffffff) con font-weight 600/700 en todos los chips en dark mode
  - Afecta: Badges (success, warning, error, info, purple, default), Chips de citas (Confirmed, Pending, Cancelled, Showed, Noshow, Rescheduled), chip "Hoy", chip de hora en próximas citas
  - El sistema de temas está en ThemeContext.tsx que aplica clases `body.dark` y `body.light` (líneas 98-99)
  - Solución: `:global(body.dark) .localClass` permite que CSS Modules encuentre la clase global body.dark
  - Ahora todos los chips y badges son completamente legibles en dark mode
- ✓ **Modal de confirmación para eliminar citas (2025-10-18)**:
  - Bug: Usaba `window.confirm()` en vez de modal personalizado (violaba reglas del proyecto)
  - Fix: Implementado modal de confirmación usando `createPortal` de React (patrón de Contacts.tsx)
  - Estado `showDeleteConfirm` para controlar visibilidad del modal
  - Modal con overlay, título, mensaje descriptivo y botones Cancelar/Eliminar
  - Estilos: deleteModalOverlay, deleteModal, deleteModalHeader, deleteModalActions en AppointmentModal.module.css
  - Botón eliminar ahora muestra "Eliminando..." durante la operación
  - Archivo modificado: AppointmentModal.tsx, AppointmentModal.module.css
  - Nueva regla añadida a MANDAMIENTOS INQUEBRANTABLES: Nunca usar alert(), confirm() o prompt()
- ✓ **Modal de creación de citas rediseñado con 2 columnas (2025-10-18)**:
  - Layout con grid responsivo: columna izquierda 300px (asignación), columna derecha flexible (configuración)
  - Columna izquierda: búsqueda de contacto + selector de usuario/team member
  - Columna derecha: título, estado, fechas, ubicación, notas
  - Auto-fill del título con nombre del contacto seleccionado
  - Contacto ahora es OBLIGATORIO para crear citas (antes era opcional)
  - Validación con toast notifications en vez de alert()
  - Responsive: columnas se apilan verticalmente en pantallas <900px
  - Max-width del modal aumentado de 640px a 900px
- ✓ **Soporte para calendarios Round Robin (2025-10-18)**:
  - **Flujo correcto según API de HighLevel**:
    1. GET /calendars/:id → obtiene teamMembers[] con userId
    2. POST /api/highlevel/users/by-ids → obtiene datos completos de usuarios
  - Detección automática: calendarType === 'round_robin' o eventType.includes('RoundRobin')
  - Backend: métodos getUserById(), getUsersByIds() en ghlClient.js
  - Nuevo endpoint: POST /api/highlevel/users/by-ids (recibe array de userIds)
  - Frontend: loadUsers() hace POST con teamMemberIds extraídos de calendar.teamMembers
  - **Fallback inteligente**: Si falta scope `users.readonly`, muestra "Usuario {id}..." en selector
  - UI condicional: "Team member *" (obligatorio) para RR vs "Usuario asignado (opcional)" para normales
  - Validación obligatoria de assignedUserId para calendarios Round Robin
  - ⚠️ **Limitación actual**: Token sin scope `users.readonly` → solo muestra IDs truncados
  - ✅ **Funcionalidad**: Asignación funciona perfectamente aunque falte el nombre pretty
  - Archivos: ghlClient.js, highlevelController.js, highlevel.routes.js, AppointmentModal.tsx
  - Script de prueba: test-round-robin.js para debugging
- ✓ **Modales con datos obsoletos al cambiar fechas (2025-10-18)**:
  - Bug crítico: Al cambiar dateRange, los modales mantenían datos de fechas anteriores
  - Root cause: Table.tsx cacheaba los primeros render callbacks de columnas (stale closures)
  - Fix en `Table.tsx:89`: useEffect recomputa `processedColumns` cuando cambian `[columns, savedLayout]`
  - Ahora los callbacks de modal se sincronizan con el estado actual automáticamente
  - Afectaba: Campaigns.tsx y Reports.tsx (modales de contactos, visitantes, citas)
  - Solución adicional: useEffect en páginas que limpia y recarga datos de modales al cambiar dateRange
  - Archivos: Table.tsx, Campaigns.tsx, Reports.tsx
  - Sin este fix: usuario cambia fechas → tabla actualiza números → click en número → modal muestra datos viejos
- ✓ **Logs de debugging eliminados (2025-10-18)**:
  - Removidos todos los logs con emojis (🔵, 🟡, 🟠, 🔴, 🟢) y prefijos de debug
  - Archivos limpiados: analyticsService.js, metaController.js, trackingController.js
  - Eliminados ~190 líneas de código de debugging
  - Mantenido solo logger para errores y eventos importantes
  - App ahora production-ready sin logs innecesarios
- ✓ **Números en badges de modales eliminados (2025-10-18)**:
  - Regla: Solo mostrar monto total pagado si es cliente, NUNCA otros números en badges
  - ContactDetailsModal: Eliminado LTV de lista y tarjeta "Pagos" (mantenido "Valor Total")
  - VisitorDetailsModal: Eliminado LTV de lista de visitantes
  - Badges ahora solo muestran texto: "Cliente", "Agendó cita", "Lead"
  - Únicos números permitidos: monto en pesos del cliente en sección de métricas/detalles

- ✓ **Unificación de lógica de fuentes de tráfico (2025-10-18)**:
  - Problema: Dashboard y Analytics usaban lógicas diferentes para el gráfico de fuentes
  - **Dashboard antes**: Solo usaba `source_platform`, sin normalizar ("fb", "ig")
  - **Analytics**: Usaba cascada `site_source_name` → `source_platform` → `utm_source` + normalización
  - **Fix**: Dashboard ahora usa la MISMA lógica que Analytics
  - Creada función `normalizePlatformName` en backend (utils/platformNormalizer.js)
  - Endpoint `/api/dashboard/traffic-sources` actualizado:
    - Prioridad: `site_source_name` → `source_platform` → `utm_source`
    - Normaliza: "fb" → "Facebook", "ig" → "Instagram", etc.
    - Agrupa por plataforma normalizada antes de ordenar
  - Ahora ambos gráficos muestran datos consistentes y legibles
  - Archivos: backend/src/utils/platformNormalizer.js, dashboardController.js

- ✓ **Deduplicación mejorada: Email O Teléfono (2025-10-18)**:
  - Problema: Deduplicación solo usaba teléfono en reportes
  - **Casos no detectados**:
    - Contacto cambia de teléfono pero mantiene email → contaba como 2 personas
    - Contacto usa mismo email con teléfonos diferentes → contaba como 2 personas
    - HighLevel crea múltiples IDs para misma persona (diferentes formularios)
  - **Fix**: Deduplicación ahora usa email O teléfono
  - Función `buildContactKey()` actualizada con prioridades:
    1. Email (normalizado: lowercase + trim) → `email::usuario@dominio.com`
    2. Teléfono (últimos 10 dígitos) → `phone::5512345678`
    3. Contact ID (fallback) → `id::abc123`
  - Prefijos en keys evitan colisiones entre diferentes tipos
  - Query SQL incluye campo `email` en `buildReportMetrics`
  - Afecta: Leads, Customers, Appointments en página de Reports
  - Resultado: Métricas más precisas, menos duplicados inflados
  - Archivo: backend/src/services/analyticsService.js

---

## 📅 ÚLTIMA ACTUALIZACIÓN

**Fecha**: 2026-04-03
**Versión**: 1.24.0
**Últimos cambios críticos**:
- **Removal: Eliminada extracción de Ad ID desde mensajes de WhatsApp (2026-04-03)**
  - **Removido**: Funciones `extractAdIdFromMessage()` y `resolveAdIdWithValidation()` del webhook
  - **Simplificado**: Handler `handleWhatsAppAttributionWebhook()` para usar solo `referral_source_id`
  - **Razón**: Simplificar lógica de atribución, usar solo fuentes confiables de HighLevel
  - **Archivo modificado**: `webhooksController.js`

- **Feature: Pantalla de Setup para crear el Primer Usuario (2026-04-01)** ⭐
  - **Problema**: La app creaba un usuario "admin/admin123" por defecto automáticamente. Inseguro y poco profesional.
  - **Solución**: Primera vez que se abre la app → mostrar pantalla "Configura tu acceso" → el usuario elige su propio usuario y contraseña.
  - **Implementación**:
    - **Backend**:
      - `auth.js`: Función `initializeDefaultUser()` modificada → ya NO crea usuario admin por defecto
      - `authController.js`: 2 nuevas funciones:
        - `checkSetup(req, res)`: Verifica si existen usuarios. Retorna `{ needsSetup: true/false }`
        - `setup(req, res)`: Crea el primer usuario. CRÍTICO: solo funciona si NO hay usuarios previos (403 si hay).
      - `auth.routes.js`: Nuevas rutas:
        - `GET /api/auth/setup` → llama checkSetup
        - `POST /api/auth/setup` → llama setup (crea usuario + devuelve token JWT)
    - **Frontend**:
      - `AuthContext.tsx`: Agregado estado `needsSetup: boolean` + función `setupAccount(username, password)`
        - Al iniciar sin token, verifica `GET /api/auth/setup` para saber si necesita setup
      - Nuevo componente: `Setup.tsx` (en carpeta Login/ para reutilizar estilos de Login.module.css)
        - UI idéntica a Login pero para crear usuario
        - 3 inputs: usuario (min 3 chars), contraseña (min 6 chars), confirmar contraseña
        - Botón "Crear mi acceso"
        - Validaciones de entrada (lado cliente)
        - Al crear exitosamente → login automático → redirige a /dashboard
        - Si ya hay usuarios creados (`needsSetup === false`) → redirige a /login
      - `App.tsx`: Agregada nueva ruta y componente `SetupRoute`
        - Ruta `/setup` → muestra Setup component si `needsSetup === true`
        - ProtectedRoute modificada: si `needsSetup === true` → redirige a /setup antes de pedir login
  - **Flujo Completo**:
    ```
    1. App arranca sin token
    2. AuthContext verifica: GET /api/auth/setup
    3. ¿Hay usuarios? NO → needsSetup = true → redirige a /setup
    4. Usuario llena formulario
    5. POST /api/auth/setup → crea usuario + token
    6. Login automático → /dashboard
    7. Siguiente vez: /login normal con credenciales elegidas
    ```
  - **Seguridad**:
    - `POST /api/auth/setup` devuelve 403 si ya existen usuarios (protección)
    - Las contraseñas se hashean con PBKDF2 (100,000 iteraciones) antes de guardar
    - Después de crear el primer usuario, la ruta /setup queda inactiva
  - **Archivos modificados/creados**:
    - Backend: `auth.js`, `authController.js`, `auth.routes.js`
    - Frontend: `AuthContext.tsx`, `App.tsx`, ✨NEW: `Setup.tsx`
  - **Verificación**: 
    1. Borrar usuario de BD → app abre en /setup ✅
    2. Llenar formulario → crea usuario + redirige a /dashboard ✅
    3. Logout → va a /login (no a /setup) ✅
    4. Intentar ir a /setup cuando hay usuarios → redirige a /login ✅

- **Fix: Agrupación inteligente de datos en gráficos de Campaigns (2025-10-27)**
  - **Problema detectado**: Gráficos se quedaban en blanco con rangos largos (365+ días)
    - Al seleccionar un año completo, intentaba renderizar 365 puntos diarios
    - El gráfico se saturaba y no mostraba nada o era ilegible
  - **Solución implementada**:
    - Función `groupChartData()` agrupa datos dinámicamente según el rango
    - Función `getGroupingType()` determina el tipo de agrupación:
      - <= 30 días: Vista diaria (sin cambios)
      - 31-90 días: Agrupa por semana (lunes como inicio)
      - > 90 días: Agrupa por mes
    - Aplicado a TODOS los gráficos: Revenue, Visitors, Leads, Appointments
    - Los valores se suman correctamente al agrupar períodos
  - **Resultado**: Los gráficos ahora funcionan perfectamente con cualquier rango de fechas
  - **Archivo modificado**: `frontend/src/pages/Campaigns/Campaigns.tsx`

- **Feature: Indicador visual de timezone en fechas de Meta Ads (2025-10-26)**
  - **Problema detectado**: Las fechas de Meta se muestran en su timezone original, no en el timezone de HighLevel
    - Meta reporta "24 de octubre" en LA (UTC-8)
    - HighLevel puede estar configurado en México (UTC-6)
    - Usuario veía mismas fechas sin saber que representan períodos diferentes
  - **Solución implementada**:
    - Hook `useMetaTimezone` mejorado con función `adjustMetaDateToLocal()`
    - Detecta automáticamente discrepancias entre timezones (tolerancia 30 minutos)
    - Agrega indicador de timezone a fechas cuando hay discrepancia
    - Ejemplo: "2025-10-24 (LA)" cuando Meta está en Los Angeles
    - Abreviaciones inteligentes: LA, NY, CHI, CDMX, DEN, PHX, TOR, LON, PAR, MAD
  - **Aplicado en**:
    - **Campaigns**: Todos los gráficos (Revenue, Visitors, Leads, Appointments, Sales)
    - **Reports**: Gráficos y tabla de métricas (columna de fecha)
    - **Dashboard**: Hook disponible (vista mensual no requiere ajuste crítico)
  - **Sin cambios visuales cuando**: Ambos timezones coinciden o diferencia < 30 minutos
  - **Archivos modificados**: useMetaTimezone.ts, Campaigns.tsx, Reports.tsx, Dashboard.tsx
- **Fix: Tooltips de gráficos en Reports + Layout 2x2 (2025-10-24)**
  - **Problema detectado**: Los tooltips en Reports no seguían el patrón profesional del Dashboard
    - No posicionaban el tooltip en el punto más alto cuando hay múltiples series
    - Distancia del cursor no era óptima
    - Layout de métricas era responsive variable, no 2x2 consistente
  - **Solución implementada** (3 componentes de gráficos):
    - **SimpleLineChart**: Captura punto más alto como AreaChart.tsx del Dashboard
    - **SimpleBarChart**: Mismo sistema de captura de posición del bar más alto
    - **SimpleAreaChart**: Mismo sistema para múltiples áreas
  - **Lógica de tooltip mejorada** (igual que Dashboard):
    - Cálculo dinámico de `IDEAL_MIN_GAP = 18px` (distancia mínima del cursor)
    - Cálculo de `IDEAL_MAX_GAP = 54px` (distancia máxima)
    - Usa `requestAnimationFrame` para evitar setState durante render
    - Cuando hay múltiples puntos/barras activos, elige el más alto (menor valor Y)
    - Resalta con sombra al hover: `drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2))`
    - Resetea estado al cambiar de índice para evitar ghosts
  - **Layout 2x2 de métricas**:
    - Cambio de grid: `repeat(auto-fit, minmax(...))` → `repeat(2, 1fr)` (2 columnas fijas)
    - Responsive: automáticamente a 1 columna en pantallas < 1200px
    - Tarjetas ahora están más compactas y organizadas
  - **Archivos modificados**:
    - `frontend/src/pages/Reports/Reports.tsx`: Todos los 3 componentes de gráficos (SimpleLineChart, SimpleBarChart, SimpleAreaChart)
    - `frontend/src/pages/Reports/Reports.module.css`: Grid layout 2x2 + media query responsive

- **Fix: Etiquetas personalizadas en Reports (Métricas) (2025-10-24)**
  - **Problema detectado**: La página de Reports mostraba "Clientes" y "Transacciones por Cliente" hardcodeados, sin reflejar personalizaciones
  - **Impacto**: Si un usuario renombraba "Cliente" → "Paciente", los labels en Reports no se actualizaban
  - **Fix aplicado** (3 ubicaciones):
    - Línea 695: `title: 'Clientes'` → `title: labels.customers` (título de tarjeta de métricas)
    - Línea 701: `'Transacciones por Cliente'` → `` `Transacciones por ${labels.customer}` `` (item de métrica)
    - Línea 708: `label="Clientes Nuevos"` → `label={\`${labels.customers} Nuevos\`}` (etiqueta de gráfico)
  - **Verificado**:
    - ✅ Columnas de tabla ya usaban `labels.leads` correctamente (línea 1177)
    - ✅ Columnas de conversión ya usaban `labels.leads` correctamente (líneas 1308, 1317)
    - ✅ Dashboard.tsx: No tiene problemas, usa labels.leads correctamente
    - ✅ ContactDetailsModal.tsx: Usa labels.customer y labels.lead en badges
  - **Resultado**: Ahora todos los labels en Reports se actualizan automáticamente cuando el usuario personaliza las etiquetas
  - **Archivos modificados**:
    - `frontend/src/pages/Reports/Reports.tsx`: 3 cambios
    - `frontend/src/components/common/ContactDetailsModal/ContactDetailsModal.tsx`: Verificado (sin cambios necesarios)

- **Feature: Detección de Discrepancias de Timezone (2025-10-19)**
  - **Nueva funcionalidad**: Frontend detecta y alerta cuando hay diferencias de timezone entre Meta y HighLevel
  - **Hook personalizado**: `useMetaTimezone()`
    - Obtiene timezone de Meta desde `/api/meta/config`
    - Compara con timezone de HighLevel (TimezoneContext)
    - Calcula discrepancia en horas
    - Retorna: `{ metaTimezoneName, metaTimezoneOffset, highLevelTimezoneName, highLevelTimezoneOffset, hasDiscrepancy, discrepancyHours, isLoading }`
  - **Alerta visual en Campaigns**:
    - Banner naranja que aparece automáticamente si hay discrepancia
    - Muestra ambos timezones y la diferencia en horas
    - Ejemplo: "Tu cuenta de Meta está en America/Los_Angeles (UTC-8h), pero tu app usa America/Mexico_City (UTC-6h). Hay una diferencia de 2 horas."
    - Estilos adaptados para dark mode
  - **Mejora en endpoint backend**:
    - `GET /api/meta/config` ahora devuelve `timezoneId`, `timezoneName`, `timezoneOffsetHoursUtc`
    - Disponible para que frontend detecte discrepancias
  - **Archivos creados/modificados**:
    - Nuevo: `frontend/src/hooks/useMetaTimezone.ts`
    - Modificado: `backend/src/controllers/metaController.js` (getConfig con timezone fields)
    - Modificado: `frontend/src/services/campaignsService.ts` (getMetaConfig method)
    - Modificado: `frontend/src/pages/Campaigns/Campaigns.tsx` (alerta visual)
    - Modificado: `frontend/src/pages/Campaigns/Campaigns.module.css` (estilos de alerta)
    - Modificado: `frontend/src/hooks/index.ts` (export del hook)
  - **Beneficio**: Los usuarios ahora sabrán si sus fechas pueden verse incorrectas debido a diferencias de timezone

- **Feature: Sistema de Timezone para Meta Ads (2025-10-19)**
  - **Nueva funcionalidad**: Al conectar cuenta de Meta, se obtiene automáticamente el timezone configurado
  - **Campos agregados a meta_config**:
    - `timezone_id`: ID numérico del timezone (ej: 47 para Ciudad de México, 1 para Los Ángeles)
    - `timezone_name`: Nombre IANA del timezone (ej: "America/Mexico_City", "America/Los_Angeles")
    - `timezone_offset_hours_utc`: Offset en horas desde UTC (ej: -6 para CDMX, -8 para LA)
  - **Cómo funciona**:
    - Al guardar configuración de Meta, se hace llamada automática a Meta API: `GET /act_{id}?fields=timezone_id,timezone_name,timezone_offset_hours_utc`
    - Los datos se guardan en la tabla `meta_config` junto con el access_token
    - Logs informativos muestran el timezone detectado (ej: "America/Los_Angeles (ID: 1, Offset: -8h)")
  - **Comportamiento de fechas**:
    - Las fechas de Meta vienen como "YYYY-MM-DD" en el timezone de la cuenta
    - Se guardan TAL CUAL en la base de datos (representan el "día" en el timezone del anunciante)
    - **NO se convierten a UTC** (esto es intencional para preservar el "día" del anunciante)
    - El frontend muestra las fechas en el timezone del usuario de HighLevel
  - **Utilidades creadas**:
    - `convertMetaDateToUTC(date, timezoneOffsetHours)` en `dateUtils.js`
    - `convertUTCToMetaDate(utcDate, timezoneOffsetHours)` en `dateUtils.js`
    - Disponibles para uso futuro si se necesita conversión explícita
  - **Migración automática**:
    - Las columnas se agregan automáticamente al iniciar el servidor (ALTER TABLE con try/catch)
    - Compatible con PostgreSQL (Render) y SQLite (local)
  - **Archivos modificados**:
    - `backend/src/config/database.js`: Agregadas columnas con ALTER TABLE
    - `backend/src/services/metaAdsService.js`:
      - Nueva función `getAdAccountTimezone()`
      - Modificado `saveMetaConfig()` para obtener y guardar timezone
      - Agregados comentarios explicativos en `saveAdsToDatabase()`
    - `backend/src/utils/dateUtils.js`: Agregadas funciones de conversión
    - `CLAUDE.md`: Documentación actualizada
  - **Próximos pasos sugeridos**:
    - Frontend puede usar timezone_name para mostrar fechas correctamente
    - Posible integración con TimezoneContext del frontend
    - Detección de discrepancias entre timezone de Meta y timezone de HighLevel


- **Fix: Formato de fechas limpio en toda la app (2025-10-19)**
  - **Problema**: Fechas se mostraban con formato feo "14/10/2025, 11:02 p.m." (slashes, punto, lowercase)
  - **Solución**: Implementadas 2 nuevas funciones en TimezoneContext:
    - `formatLocalDateShort(date)` → "16 oct" o "16 oct 2025" (sin hora, sin slashes)
    - `formatLocalDateTime(date)` → "16 oct, 11:02 PM" o "16 oct 2025, 11:02 PM"
  - **Archivos actualizados**:
    - ✅ `TimezoneContext.tsx`: Agregadas nuevas funciones de formato
    - ✅ `Contacts.tsx`: Columna "Fecha de creación" usa formatLocalDateShort
    - ✅ `Transactions.tsx`: Columna "Fecha" usa formatLocalDateShort
    - ✅ `Appointments.tsx`: Búsqueda y lista de próximas citas usan formatLocalDateShort
  - **Formato nuevo**: Español, sin año si es año actual, sin hora en tablas
  - **Archivos NO modificados**: Dashboard, Campaigns, Reports, Analytics, WebTracking (ya usaban formatos correctos)
  - **Backend**: Ya estaba correcto - todos los endpoints usan `resolveDateRangeWithGHLTimezone()`
  - **Timezone de HighLevel**: America/Mexico_City (configurado por usuario en GHL)
  - **Resultado**: Todas las fechas ahora son consistentes, limpias y legibles
- **Fix CRÍTICO: Pagos reembolsados/cancelados se sumaban como ingresos (2025-10-19)**
  - **Bug crítico detectado**: Toda la app sumaba pagos sin filtrar por status
  - **Problema**: Reembolsos y cancelaciones se contaban como ingresos, inflando métricas
  - **Impacto**: LTV, Revenue, total_paid, métricas de campañas y modales mostraban datos incorrectos
  - **Fix aplicado en 4 archivos**:
    1. `invoicesSyncService.js`: Función updateContactStats() ahora filtra por status exitoso
    2. `metaController.js`: totalFromPayments filtra por validStatuses antes de reduce
    3. `analyticsService.js`: buildContactsList() filtra payments por status exitoso
    4. `ContactDetailsModal.tsx`: payments y refunds separados correctamente por status
  - **Regla agregada**: Mandamiento #11 en CLAUDE.md
  - **Constante estandarizada**: SUCCESS_PAYMENT_STATUSES en analyticsService.js
  - **Status válidos**: 'succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'
  - **Status excluidos**: 'refunded', 'cancelled', 'void', 'failed', 'pending'
  - **Resultado**: Todas las métricas de dinero ahora son precisas y confiables

- **Feature: Configuración de Calendarios para Atribución (2025-10-19)**
  - **Nueva funcionalidad**: Página de configuración en Settings para gestionar calendarios
  - **Calendario Predeterminado**: Se selecciona automáticamente al abrir Appointments
  - **Calendarios de Atribución**: Define qué calendarios cuentan para métricas de marketing
    - Solo las citas de calendarios seleccionados aparecen en:
      - Reports y Campaigns (columna "Citas")
      - Customer Journey (timeline)
      - Dashboard (métricas generales)
      - Gráficos de funnel en Campaigns
  - **Sistema híbrido**: useAppConfig para persistencia (cache + PostgreSQL)
  - **Filtrado en backend**:
    - appointmentsCache.js: Filtra eventos al cargar desde API
    - analyticsService.js: Filtra queries SQL con calendar_id IN (...)
    - metaController.js: Filtra queries de funnel charts
    - contactsController.js: Filtra citas del journey
  - **Fallback inteligente**: Sin configuración = usa TODOS los calendarios
  - **Ruta**: /settings/calendars (entre Meta Ads y Web Tracking)
  - **Archivos nuevos**: CalendarsConfiguration.tsx
  - **Archivos modificados**: 7 archivos (Settings.tsx, Appointments.tsx, appointmentsCache.js, analyticsService.js, metaController.js, contactsController.js, CLAUDE.md)

- **Performance: Optimización masiva de verificación de citas (2025-10-19)**
  - **Problema**: Dashboard, Campaigns y Reports hacían verificación híbrida (DB + API contacto por contacto)
    - Dashboard: Verificaba 12 meses de contactos = potencialmente 1000+ llamadas API
    - Campaigns: Batch de 50 en paralelo, pero aún 50-500+ llamadas
    - Reports: Mismo problema en métricas y modales
    - Resultado: Dashboard tardaba 10-30 segundos en cargar (BLOQUEO TOTAL)

  - **Solución**: Método optimizado copiado de Contacts.tsx (carga masiva de eventos)
    - Creado servicio centralizado `appointmentsCache.js`
    - Carga TODOS los eventos de TODOS los calendarios (1-5 llamadas API)
    - Filtra contactos en memoria (instantáneo)
    - Método usado en: Dashboard, Campaigns (tabla + modales), Reports (tabla + modales)

  - **Mejoras de performance**:
    - **Antes**: 50-1000+ llamadas API por página
    - **Ahora**: 1-5 llamadas API (1 por calendario)
    - Dashboard carga **100x más rápido** (instantáneo vs 10-30 segundos)
    - Campaigns y Reports también cargan instantáneamente

  - **Archivos modificados**:
    - `backend/src/services/appointmentsCache.js` (nuevo, servicio centralizado)
    - `backend/src/controllers/dashboardController.js` (getAppointmentsData optimizado)
    - `backend/src/controllers/metaController.js` (getCampaigns + getContactsByType)
    - `backend/src/services/analyticsService.js` (buildReportMetrics + buildContactsList)
    - Queries simplificadas: sin LEFT JOIN innecesario con appointments

  - **Funcionalidad intacta**: Los datos siguen siendo exactamente los mismos, solo 100x más rápido
  - **Cache inteligente**: Eventos se guardan en DB para consultas futuras más rápidas

- **Feature: 3 Modos de Atribución en Gráfico de Conversiones (Dashboard) (2025-10-19)**
  - **Nueva funcionalidad**: Gráfico de Conversiones ahora tiene 3 vistas de atribución (como Reports)
  - **TabList con 3 opciones**:
    1. **"Todos"**: Agrupa cada métrica por **fecha del evento real**
       - Citas → por `date_added` (cuando se agendó la cita)
       - Clientes nuevos → por fecha del **PRIMER pago** (MIN(date) FROM payments)
       - Refleja el flujo real día a día
    2. **"Último toque"**: Agrupa TODO por **fecha de creación del contacto**
       - Todos los contactos del rango (sin filtrar por ad_id)
       - Si un contacto se creó el 1 de enero y pagó el 15 de febrero, TODO se atribuye al 1 de enero
       - Citas: Contactos que TIENEN al menos 1 cita (cualquier fecha)
       - Clientes: Contactos con `purchases_count > 0`
    3. **"Último toque desde anuncio"**: Igual que "Último toque" + solo contactos con `ad_id`
       - Filtra: `attribution_ad_id IS NOT NULL AND EXISTS (SELECT 1 FROM meta_ads...)`
       - Mide el impacto directo de las campañas publicitarias

  - **Lógica por métrica** (copiada de `analyticsService.js`):
    - **Visitantes**: Siempre de sessions (no cambia con scope)
    - **Leads**: `COUNT(*) FROM contacts WHERE created_at BETWEEN...` + filtro de ad_id si aplica
    - **Citas**:
      - scope='all': Híbrido DB+API filtrado por `date_added`
      - scope='attribution'|'campaigns': `getContactsWithAppointmentsHybrid()` agrupado por `created_at`
    - **Clientes nuevos**:
      - scope='all': Subquery `MIN(date) FROM payments` para obtener primer pago
      - scope='attribution'|'campaigns': `WHERE purchases_count > 0 AND created_at BETWEEN...`

  - **Implementación**:
    - Backend: `dashboardController.js` - Función `getFunnelData()` completamente reescrita
    - Frontend: `ConversionFunnelChart.tsx` - Agregado TabList + props `scope` y `onScopeChange`
    - Frontend: `Dashboard.tsx` - Estado `funnelScope` + recarga al cambiar
    - Frontend: `dashboardService.ts` - Parámetro `scope` en `getFunnelData()`
  - **Respeta configuración**: Filtra por calendarios de atribución (igual que Reports)
  - **Archivos modificados**: 5 archivos (dashboardController.js, ConversionFunnelChart.tsx, Dashboard.tsx, dashboardService.ts, CLAUDE.md)

- **Fix CRÍTICO: Visitantes mostraban mismos valores en las 3 vistas (2025-10-19)**
  - **Bug detectado**: Los visitantes mostraban los mismos números en "Todos", "Último toque" y "Último toque desde anuncio"
  - **Causa**: Código usaba `clicks` de Meta Ads en vez de `visitor_id` de sessions
  - **Impacto**: Métricas incorrectas en Reports, Dashboard y modales de visitantes

  - **Lógica correcta implementada**:
    1. **Vista "Todos"** (`scope='all'`):
       - Todos los visitantes que entraron al sitio en el rango de fechas
       - Query: `COUNT(DISTINCT visitor_id) FROM sessions WHERE started_at BETWEEN...`
       - Filtra por fecha de la sesión (`started_at`)

    2. **Vista "Último toque"** (`scope='attribution'`):
       - Solo visitantes que SE CONVIRTIERON en contacto
       - Query: `COUNT(DISTINCT visitor_id) FROM sessions s INNER JOIN contacts c WHERE c.created_at BETWEEN...`
       - Filtra por fecha de creación del contacto (NO por fecha de sesión)
       - Si un visitor_id visitó el 1 de enero pero se registró el 15, se cuenta en el 15

    3. **Vista "Último toque desde anuncio"** (`scope='campaigns'`):
       - Solo visitantes que se convirtieron en contacto CON `ad_id`
       - Query adicional: `+ WHERE c.attribution_ad_id IS NOT NULL AND EXISTS (SELECT 1 FROM meta_ads...)`
       - Mismo criterio de atribución que Leads/Citas/Clientes

  - **Cambios aplicados**:
    - `analyticsService.js`: Agregado PASO 6 con query separado para visitantes según scope
    - `dashboardController.js`: Visitantes ahora cambian según scope (antes decía "no cambia")
    - `trackingController.js`: Modales de visitantes filtran correctamente por scope
  - **Antes**: `visitors = clicks` de Meta Ads (INCORRECTO)
  - **Ahora**: `visitors = visitor_id` únicos de sessions (CORRECTO)
  - **Archivos modificados**: 3 archivos (analyticsService.js, dashboardController.js, trackingController.js)

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
- [ ] Hacer build para confirmar que compila
- [ ] Hacer commit y push para deployar en Render

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
