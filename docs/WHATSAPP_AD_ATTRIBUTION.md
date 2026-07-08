# WhatsApp Ad Attribution

> Documento historico especializado. La entrada canonica actual de
> documentacion es [`docs/README.md`](docs/README.md); el mapa general vive en
> [`docs/RISTAK_MASTER_MANUAL.md`](docs/RISTAK_MASTER_MANUAL.md).

Esta documentación describe el comportamiento real de `backend/src/controllers/webhooksController.js` al 2026-05-28.

## Endpoint

```http
POST /webhook/whatsapp/attribution
```

También existe el alias base `/webhooks`, porque `server.js` monta el mismo router en `/webhook` y `/webhooks`.

## Qué Hace Actualmente

El webhook guarda datos de atribución WhatsApp en `whatsapp_attribution` y, si puede resolver un ad id, actualiza `contacts.attribution_ad_id`.

La fuente real del ad id hoy es:

```javascript
customData.source_id
  || data.referral_source_id
  || data.sourceId
  || data.source_id
  || null
```

Eso significa que el código actual NO extrae ad ids desde mensajes con formato `<<ad_id>>`.

## Body Soportado

Ejemplo:

```json
{
  "contact_id": "contact_123",
  "phone": "+5216561234567",
  "referral_source_id": "2393204235278523053",
  "referral_source_url": "https://facebook.com/...",
  "referral_source_type": "whatsapp",
  "referral_headline": "Promocion",
  "referral_body": "Mensaje del anuncio",
  "referral_image_url": "https://...",
  "referral_video_url": null,
  "referral_thumbnail_url": "https://...",
  "referral_ctwa_clid": "clid_123"
}
```

También acepta varios aliases:

- `contact_id` o `contactId`
- `phone` o `contactPhone`
- `customData.source_id`, `referral_source_id`, `sourceId` o `source_id`
- `customData.source_url`, `referral_source_url`, `sourceUrl` o `source_url`
- `customData.source_type`, `referral_source_type`, `sourceType` o `source_type`
- `customData.ctwa_clid`, `referral_ctwa_clid`, `ctwa_clid` o `ctwaCLID`

Si no viene `phone`, el webhook responde 200 e ignora el evento para evitar reintentos de HighLevel.

## Tabla `whatsapp_attribution`

La tabla base:

```sql
CREATE TABLE IF NOT EXISTS whatsapp_attribution (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id TEXT,
  phone TEXT,
  referral_source_url TEXT,
  referral_source_type TEXT,
  referral_source_id TEXT,
  referral_headline TEXT,
  referral_body TEXT,
  referral_image_url TEXT,
  referral_video_url TEXT,
  referral_thumbnail_url TEXT,
  referral_ctwa_clid TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
```

Migraciones adicionales intentan agregar:

```sql
message_content TEXT;
ad_id_thru_message TEXT;
```

Pero el handler actual no escribe esos dos campos.

Índices:

```sql
CREATE INDEX IF NOT EXISTS idx_whatsapp_contact ON whatsapp_attribution(contact_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_ad_id ON whatsapp_attribution(ad_id_thru_message);
```

## Actualización De Contactos

Si `finalAdId` y `contactId` existen:

```sql
UPDATE contacts
SET attribution_ad_id = ?
WHERE id = ?;
```

`finalAdId` es `referralSourceId`.

## Respuesta

Exitosa:

```json
{
  "success": true,
  "message": "Atribución procesada",
  "final_ad_id": "2393204235278523053"
}
```

Con error interno, el endpoint responde 200:

```json
{
  "success": true,
  "message": "Webhook recibido"
}
```

Esto es intencional para que HighLevel no reintente indefinidamente.

## Validación

Enviar prueba:

```bash
curl -X POST http://localhost:3001/webhook/whatsapp/attribution \
  -H "Content-Type: application/json" \
  -d '{
    "contact_id": "contact_123",
    "phone": "+5216561234567",
    "referral_source_id": "2393204235278523053",
    "referral_source_type": "whatsapp"
  }'
```

Consultar:

```sql
SELECT contact_id, phone, referral_source_id, created_at
FROM whatsapp_attribution
ORDER BY created_at DESC
LIMIT 20;
```

Y:

```sql
SELECT id, phone, attribution_ad_id
FROM contacts
WHERE id = 'contact_123';
```

## Nota Importante

Versiones anteriores de esta documentación prometían extracción de ad id desde mensajes tipo:

```txt
Hola, me interesa <<2393204235278523053>>
```

Eso no está implementado en el handler actual. Para hacerlo real, habría que agregar parsing explícito del primer mensaje y persistir `message_content` + `ad_id_thru_message`.
