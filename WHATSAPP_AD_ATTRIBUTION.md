# 📱 WhatsApp Ad Attribution via Message

## 📋 Resumen

Sistema para rastrar el `ad_id` de Facebook cuando un usuario hace clic en un anuncio de Click-to-WhatsApp y envía su primer mensaje. El ad_id viene incrustado en el mensaje con una nomenclatura especial `<<ad_id>>`.

---

## 🔄 Flujo Completo

```
1. Usuario ve anuncio en Facebook
   ↓
2. Hace clic en botón "Click-to-WhatsApp"
   ↓
3. Se abre WhatsApp con mensaje pre-llenado:
   "Hola buenas tardes me interesa info del servicio <<2393204235278523053>>"
   ↓
4. Usuario envía el mensaje (completo o parcialmente editado)
   ↓
5. HighLevel recibe el mensaje en WhatsApp
   ↓
6. HighLevel captura el primer mensaje y lo envía en webhook a Ristak
   ↓
7. Ristak extrae el ad_id del patrón <<número>>
   ↓
8. Ristak guarda:
   - En tabla "whatsapp_attribution": el mensaje original + ad_id extraído
   - En tabla "contacts": attribution_ad_id = el ad_id extraído
   ↓
9. El contacto está relacionado con el anuncio correcto ✅
```

---

## 🛠️ Configuración en HighLevel

### Paso 1: Crear Custom Field (Optional but Recommended)

En HighLevel, crea un custom field llamado `first_message` o `ad_id_thru_message` que capture el **primer mensaje** del cliente cuando entra por WhatsApp.

### Paso 2: Configurar Click-to-WhatsApp en Facebook

En tu campaña de Facebook Ads, cuando configures el botón Click-to-WhatsApp, el mensaje pre-llenado debe incluir el `ad_id` en la nomenclatura especial:

**Ejemplo 1:**
```
Hola! Me interesa tu servicio de {{campaign_name}}
Referencia: <<{{ad_id}}>>
```

**Ejemplo 2:**
```
Hola buenas tardes me interesa info del servicio <<{{ad_id}}>>
```

**Ejemplo 3:**
```
<<{{ad_id}}>> Me interesa saber mas sobre lo que ofrecen
```

**Importante:** 
- Facebook debe permitir usar `{{ad_id}}` como variable dinámica
- El `ad_id` SIEMPRE debe estar entre `<<` y `>>`
- El resto del mensaje puede editarse libremente

### Paso 3: Configurar el Webhook en HighLevel

El webhook debe enviar el primer mensaje en el campo `ad_id_thru_message`:

```json
{
  "contact_id": "contacto123",
  "phone": "+1234567890",
  "ad_id_thru_message": "Hola buenas tardes me interesa info del servicio <<2393204235278523053>>",
  "referral_source_url": "https://...",
  "referral_source_type": "whatsapp",
  "customData": {
    "first_message": "Hola buenas tardes me interesa info del servicio <<2393204235278523053>>"
  }
}
```

---

## 🔍 Cómo Funciona el Parsing

Ristak busca el patrón `<<número>>` en el mensaje y extrae el número:

```javascript
// Mensaje recibido:
"Hola buenas tardes me interesa info del servicio <<2393204235278523053>>"

// Patrón regex:
/<<(\d+)>>/

// Resultado extraído:
"2393204235278523053"

// Se guarda como:
attribution_ad_id = "2393204235278523053"
```

---

## 💾 Dónde se Guarda el Ad ID

### En tabla `whatsapp_attribution`

```sql
id              -- ID único del registro
contact_id      -- ID del contacto
phone           -- Teléfono del contacto
ad_id_thru_message -- Mensaje original completo con <<ad_id>>
extracted_ad_id -- El ad_id extraído (sin <<>>)
created_at      -- Fecha de creación
```

### En tabla `contacts`

```sql
id              -- ID del contacto
attribution_ad_id -- El ad_id (se actualiza desde webhook)
attribution_ad_name -- Nombre del anuncio (si se tiene)
```

---

## 📊 Dónde se Usa el Ad ID

Una vez guardado, el `attribution_ad_id` se usa automáticamente en:

1. **Dashboard**: Relacionar contactos con campañas en los gráficos de conversión
2. **Campaigns**: Mostrar el ad_id en la columna de "Anuncio" y "ID del anuncio"
3. **Reports**: Filtrar y agrupar por ad_id en métricas
4. **Analytics**: Atribución de conversiones a anuncios específicos
5. **ContactDetailsModal**: Mostrar "De dónde llegó: Facebook - [Nombre del anuncio]"

---

## ✅ Validación

Para verificar que funciona:

1. Crea un anuncio en Facebook con Click-to-WhatsApp
2. En el mensaje pre-llenado, agrega: `<<TEST_AD_ID_123>>`
3. Envía un mensaje de prueba desde WhatsApp
4. En tu DB local, verifica:
   ```sql
   SELECT * FROM whatsapp_attribution WHERE extracted_ad_id = 'TEST_AD_ID_123';
   SELECT * FROM contacts WHERE attribution_ad_id = 'TEST_AD_ID_123';
   ```
5. Debe haber registros con el ad_id extraído

---

## 🔧 Campos Disponibles en el Webhook

Ristak busca el primer mensaje en este orden:

1. `data.ad_id_thru_message` ← **Principal (recomendado)**
2. `data.first_message`
3. `data.customData.first_message`

Si no encuentra en ninguno de estos, no extrae el ad_id.

---

## 🚨 Casos Edge

### ¿Qué pasa si el usuario edita el mensaje?

Si la nomenclatura `<<ad_id>>` sigue visible, Ristak lo extrae correctamente:

✅ "Hola, <<2393204235278523053>>" → Extrae: 2393204235278523053
✅ "Me interesa <<2393204235278523053>> servicios" → Extrae: 2393204235278523053
❌ "Hola, 2393204235278523053" → No extrae (sin <<>>)

### ¿Qué pasa si hay múltiples `<<números>>`?

Ristak extrae el **primero** que encuentre:

```javascript
"<<111>> y <<222>>" → Extrae: 111
```

### ¿Qué pasa si no hay ad_id en el mensaje?

No se rellena `attribution_ad_id`, pero el webhook se procesa normalmente. El contacto se crea sin atribución de ad_id.

---

## 📝 Logs para Debugging

En los logs del backend verás mensajes como:

```
📥 Webhook de atribución WhatsApp recibido para: +1234567890
🔍 Ad ID extraído del mensaje: 2393204235278523053
✅ Ad ID guardado en contacts para contacto abc123: 2393204235278523053
✅ Atribución WhatsApp procesada para +1234567890 - Ad ID: 2393204235278523053
```

---

## 📌 Resumen de Cambios

- ✅ Nueva función `extractAdIdFromMessage()` en webhooksController.js
- ✅ Campos nuevos en tabla `whatsapp_attribution`: `ad_id_thru_message`, `extracted_ad_id`
- ✅ Actualización automática de `contacts.attribution_ad_id`
- ✅ Índices de DB creados para búsquedas rápidas
- ✅ Backward compatible (función migración agrega columnas si no existen)

---

## 🎯 Ventajas de Este Enfoque

✅ **No depende de parámetros de URL** - Más confiable que URLs largas  
✅ **El mensaje es proof** - Ves exactamente qué ad_id vino  
✅ **Funciona aunque el usuario edite el mensaje** - Si mantiene `<<ad_id>>`  
✅ **Fácil de debuggear** - Ves el mensaje completo en la DB  
✅ **Sin dependencias externas** - Solo regex y parsing simple  
✅ **Limpio y organizado** - El ad_id viene en su propio campo

---

## 📅 Versión

Implementado: 2025-10-27
Versión de Ristak: 1.24.0
