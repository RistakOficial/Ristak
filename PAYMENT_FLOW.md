# 📱 Flujo de Pagos en Ristak - Text2Pay y Envío de Enlaces

## ✅ El Flujo es CORRECTO y funciona así:

### 1️⃣ **PRIMERO se crea el Invoice**
Cuando eliges cualquier opción de pago (Generar enlace, Enviar enlace, Cobrar tarjeta, Pago manual), el sistema:
- Verifica si ya existe un `invoiceId`
- Si NO existe, crea el invoice con `POST /api/highlevel/invoices`
- Obtiene el `invoiceId` del invoice creado

### 2️⃣ **DESPUÉS se ejecuta la acción**
Una vez que tenemos el `invoiceId`:
- **Generar enlace**: Llama a `sendInvoice(invoiceId, 'none')` - NO envía, solo genera el link
- **Enviar enlace**: Llama a `sendInvoice(invoiceId, sendMethod)` - Envía por email/sms/both
- **Cobrar tarjeta**: Procesa el cargo con Stripe
- **Pago manual**: Registra el pago como pagado manualmente

## 🔵 Logs de Debug Agregados

Para ver exactamente qué está pasando, abre la consola del navegador (F12) y verás:

1. **Al crear invoice**:
   ```
   🟡 No hay invoice ID, creando invoice...
   🟡 Payload del invoice: {datos del invoice}
   ✅ Invoice creado exitosamente: {response}
   ✅ Invoice ID obtenido: inv_xxxxx
   ```

2. **Al enviar**:
   ```
   🔵 Invoice ID obtenido: inv_xxxxx
   🔵 Payment option seleccionada: send
   🔵 Send method: sms
   📧 Preparando envío de invoice...
   📧 Contacto: {email: "...", phone: "..."}
   📧 Enviando invoice inv_xxxxx por método: sms
   ✅ Invoice enviado exitosamente
   ```

## ❌ Posibles Errores y Soluciones

### Error: "No se puede enviar en borrador"
**Esto NO debería pasar** porque siempre creamos el invoice antes de enviarlo. Si ves este error:
1. Revisa los logs de la consola
2. Verifica que el invoice se creó exitosamente (debe aparecer "✅ Invoice creado")
3. Verifica que tienes configurado el nombre y email del negocio en HighLevel

### Error: "No phone number found for invoice"
- El contacto NO tiene teléfono registrado
- Solución: Usa email en lugar de WhatsApp, o agrega el teléfono al contacto

### Error: "No email found for invoice"
- El contacto NO tiene email registrado
- Solución: Usa WhatsApp en lugar de email, o agrega el email al contacto

## 🔧 Configuración Requerida en HighLevel

Para que el envío funcione, necesitas en tu configuración de HighLevel:
1. **Business Name** (nombre del negocio)
2. **Business Email** (email del negocio)
3. **Domain** (opcional, para links personalizados)

## 📊 Diferencia entre Text2Pay y Send Invoice

- **Text2Pay**: Crea y envía un link de pago rápido SIN crear invoice formal (no implementado en Ristak)
- **Send Invoice**: Crea un invoice formal PRIMERO, luego lo envía (esto es lo que usamos)

## ✨ El flujo es idéntico a High Level - Payments

Confirmado después de revisar ambos códigos:
- Ambos crean el invoice primero
- Ambos usan `/invoices/{id}/send` para enviar
- Ambos validan datos del contacto antes de enviar
- Ambos soportan email, sms (WhatsApp), both, none

---

**IMPORTANTE**: Si sigues teniendo problemas, revisa los logs de la consola y compártelos para poder ayudarte mejor.