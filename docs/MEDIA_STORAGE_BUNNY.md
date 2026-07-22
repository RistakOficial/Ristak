# Bunny.net multimedia storage

Ristak stores new user-uploaded media through `mediaStorageService`. The database stores metadata, URLs, ownership, processing state and quota usage. Heavy files go to Bunny Storage when configured; otherwise the service marks storage as `not_configured` and uses a temporary local fallback unless `MEDIA_STORAGE_REQUIRE_BUNNY=true`.

## Render variables

En una instalación gestionada o en un Blueprint standalone, la configuración central de Bunny
se obtiene por backend usando la identidad de licencia existente o el registro técnico automático
del tenant. No se deben copiar llaves Bunny a Render. Las variables siguientes describen el
contrato de una configuración explícita/local y conservan prioridad cuando existen.

Required for an explicit Bunny Storage configuration:

- `MEDIA_STORAGE_PROVIDER=bunny`
- `MEDIA_COMPRESSION_ENABLED=true`
- `DEFAULT_STORAGE_QUOTA_GB=5`
- `BUNNY_STORAGE_ZONE`
- `BUNNY_STORAGE_API_KEY`
- `BUNNY_CDN_BASE_URL`

Optional:

- `BUNNY_STORAGE_REGION`
- `BUNNY_STORAGE_ENDPOINT`
- `BUNNY_STREAM_LIBRARY_ID`
- `BUNNY_STREAM_API_KEY`
- `BUNNY_STREAM_COLLECTION_ID`
- `BUNNY_STREAM_COLLECTION_NAME` (default: `Ristak Sites & Forms`)
- `BUNNY_STREAM_ENABLED=true`
- `BUNNY_STREAM_TUS_ENDPOINT` (override solo para desarrollo/pruebas; producción
  usa `https://video.bunnycdn.com/tusupload`)
- `MEDIA_STORAGE_REQUIRE_BUNNY=true`
- `INTERNAL_INSTALLER_TOKEN`
- `MEDIA_UPLOAD_LEASE_MS` (tuning operativo; default mínimo 40 minutos)
- `MEDIA_UPLOAD_HEARTBEAT_MS` (tuning operativo; default 5 minutos y siempre
  menor que un tercio del lease)
- `OUTBOUND_MEDIA_NAT64_PREFIXES` (lista CIDR separada por comas únicamente si
  la red usa prefijos NAT64 privados; no es secret)

Los tres últimos son opcionales y tienen comportamiento seguro sin configuración
manual. Son parámetros de infraestructura del proceso, no ajustes por negocio.

Do not store Bunny API keys in committed files. En el modo central, la configuración técnica y la
identidad del broker sólo se conservan cifradas en `app_config`; jamás se devuelven al frontend.

## Endpoints

Authenticated app endpoints:

- `POST /api/media/upload`
- `POST /api/media/video-upload/prepare?module=sites`
- `POST /api/media/video-upload/:id/finalize?module=sites`
- `DELETE /api/media/video-upload/:id?module=sites`
- `GET /api/media/assets`
- `POST /api/media/folders`
- `GET /api/media/folders`
- `GET /api/media/storage/usage`
- `GET /api/media/assets/:id/url`
- `DELETE /api/media/assets/:id`
- `PUT /api/media/assets/:id/replace`
- `POST /api/media/assets/:id/retry`
- `POST /api/media/assets/:id/stream/sync`
- `GET /api/media/diagnostics`

Public file fallback:

- `GET /media/assets/:id/file`
- `GET /media/assets/:id/thumbnail`

Installer/admin panel endpoints (sólo instalaciones gestionadas con token interno explícito):

- `GET /internal/storage/usage`
- `GET /internal/storage/diagnostics`

The installer must send `Authorization: Bearer <INTERNAL_INSTALLER_TOKEN>` or `x-internal-installer-token`.

## Resumable Sites video uploads

Sites, Forms and landing-page videos use a direct Bunny Stream TUS flow instead
of sending the full file through the Render web process:

1. The authenticated frontend calls `video-upload/prepare`. The backend checks
   the Sites plan/access, MIME, configured video limit and available quota,
   creates the Bunny Stream video in the account collection and reserves a
   `media_assets` row with `status='uploading'`.
2. The backend returns a short-lived SHA-256 authorization for that video. It
   never returns `BUNNY_STREAM_API_KEY`.
3. `tus-js-client` uploads 10 MB chunks directly from the browser to Bunny,
   retries transient failures and can resume the same selected file from the
   last confirmed byte.
4. The frontend calls `video-upload/:id/finalize` with the TUS session URL.
   Backend validates that URL against the configured Bunny endpoint, checks by
   `HEAD` that `Upload-Length` matches the reserved file size and that
   `Upload-Offset` reached the final byte, then marks the asset `ready`, refreshes
   Stream metadata and returns the embed URL used by the Sites editor/player.

The `clientUploadId` is stable for the selected file, so repeating prepare does
not create another Bunny video. A distributed lock also serializes simultaneous
prepare requests for the same business, so quota validation and reservation
cannot race between two different videos. A deploy or restart after prepare no
longer interrupts the file transfer because Render is not carrying the video
body. Explicit cancellation deletes the pending Stream video and releases its
quota; abandoned sessions are cleaned on a later prepare after seven days. The
legacy multipart route remains as a compatibility fallback when Stream is not
configured.

Authorization is decided before multipart parsing. `module=sites`, `forms` or
`landing` maps to the `sites` write permission; other administrative uploads
continue to require `settings_media`. If query and body modules disagree, the
request is rejected instead of trusting the later multipart field. Employees
with Sites access always use the installation's tenant, authenticated user and
default account scope; only a local admin keeps the legacy multi-account routing.

## Direct chat uploads

The native iOS client uploads new chat files with multipart to
`POST /api/media/upload?module=chat&chatCompatibility=whatsapp&chatMediaKind=<kind>`.
This path is authorized with the Chat module, not the administrative Media
screen, and is limited to 25 MB before multipart parsing. Account and user
identity come from the authenticated installation/session; multipart fields
cannot select another business.

Every request sends a stable `clientUploadId`. `media_upload_requests` reserves
`(business_id, client_upload_id)` before compression, records a SHA-256 request
hash (including the selected administrative account when applicable) and replays
the completed asset for a matching retry. A v2 account-scoped hash is current;
rows created before deployment can only replay after validating that their
completed asset still belongs to the requested account. The lease is at least
40 minutes and an `owner_token` heartbeat renews it while Storage/Stream work is
alive. Concurrent requests
wait for the same result; reusing the key with different bytes or destination is
a conflict. Failed processing releases the lease for a controlled retry.

The upload response includes the asset id and public URL. Messaging endpoints
prefer `mediaAssetId`, resolve it server-side, require an active `module=chat`
asset owned by the current installation and replace any client URL with the
stored URL. Legacy raw URLs remain compatibility-only and must be public HTTPS;
loopback, link-local, private/reserved IPs, NAT64/reserved IPv6 ranges and unsafe
DNS resolutions are rejected before Meta, HighLevel or the local QR transport
can fetch them. Standard NAT64 ranges are denied automatically; an installation
behind a private network-specific translator declares its CIDR in
`OUTBOUND_MEDIA_NAT64_PREFIXES` and should also enforce the same egress policy at
the network boundary.

Images, audio and video still pass through the WhatsApp compatibility pipeline,
but conversions have bounded execution/concurrency. Temporary-file ownership is
explicit: buffer compatibility paths clean their input in the controller, while
file-stream paths leave cleanup to `mediaStorageService` after the final read.
The replace route classifies direct-chat multipart before Multer as well, so the
25 MB limit and temporary-file cleanup cannot be bypassed with `PUT`.

`storage_settings.account_slug` remains the stable root for the configured
installation account. Explicit administrative alternate accounts use their own
normalized account root, and idempotent lookup never reuses a modern asset from
another account.

## Processing

- Images are compressed through the shared media compression service and get a WebP thumbnail when possible.
- Buffer-based video compatibility paths may transcode through FFmpeg. Legacy
  multipart videos stream the original file from disk without FFmpeg, and Sites/
  Forms TUS videos go directly to Bunny Stream for transcoding.
- Audio is compressed through FFmpeg to a web/WhatsApp-friendly format when possible.
- Failed compression keeps the original so uploads do not die only because FFmpeg is missing.
- New videos selected from Sites, imported site assets and Forms
  (`module=sites`, `module=forms`, `module=landing`) are uploaded directly and
  resumably to Bunny Stream. Before the asset becomes `ready`, backend streams
  Bunny Stream's authenticated original into Bunny Storage without buffering
  the full file in RAM. This creates the separate editor/preview source while
  preserving the resumable browser-to-Stream upload. Legacy assets can still be
  copied from Bunny Storage to Stream through the compatibility/sync path.
  Other modules do not sync to Stream automatically.
- Ristak creates or reuses a Bunny Stream collection named `Ristak Sites & Forms` unless `BUNNY_STREAM_COLLECTION_ID` is configured.
- Bunny Stream video metadata is stored under `media_assets.metadata_json.stream` and can be refreshed with `POST /api/media/assets/:id/stream/sync` after transcoding finishes.
- Imported HTML Sites are code-first: pasting complete HTML or uploading an
  HTML/ZIP creates the site/pages and detects media slots before any Media asset
  is selected. `data-rstk-asset-id` and `data-rstk-background-asset-id` declare
  pending, associable slots for images, backgrounds, audio and downloadable
  files; physical Bunny/Storage URLs never become the editable contract.
  `public_site_content_assets` maps each stable, site-wide `asset_key` to the
  current `media_asset_id`. Replacing the selected file changes the binding
  without changing HTML. Reusing one key anywhere in the same site intentionally
  reuses the same asset; independent zones need different keys.
  Download slots declared on `<a>` can bind any Media type, including images,
  audio, video, PDFs and archives. Ristak only lists resolvable HTML targets as
  slots, silently saves a dirty code draft before opening Media, and suppresses
  stale bindings when the HTML changes a key to an incompatible media type.
  The picker loads the library in 250-asset pages and keeps loading available
  while a local search has no match, so large Media libraries do not block the
  modal or hide later results.
  Published download links use the stable same-origin content route with
  `?download=1`; backend sets `Content-Disposition: attachment` and streams local
  or Bunny Storage bytes, forwarding HTTP ranges for resumable large downloads.
  The route is `no-store` because a stable key can be rebound. A legacy
  Stream-only video creates its Storage mirror during the authenticated binding
  operation; anonymous download requests never trigger that work or proxy the
  Stream player HTML. The physical CDN URL is never written into the
  downloadable anchor.
- Premium imported-HTML video uses a native slot such as
  `<div data-rstk-native-element="video" data-rstk-native-id="video-01"></div>`.
  This preserves the complete Sites player configuration and the Storage preview
  and published-player contract. A code-owned `<video>` is kept only as
  HTML/legacy media and does not gain the native player's customization contract.
  The native slot itself must not own player geometry (`width`, fixed heights,
  `aspect-ratio`, percentage padding, clipped overflow, or forced orientation);
  layout belongs on an outer parent. Imported preview/live rendering neutralizes
  legacy slot geometry, detects the real media orientation, and mounts the same
  responsive stylesheet and player runtime used by the normal Sites editor.
  Portrait width has three explicit behaviors in the video panel: `auto` keeps
  the player contained on desktop and expands it to the full available width on
  mobile while preserving 9:16; `fill` uses the full width on every viewport;
  and `framed` respects the media-width value saved for each desktop/tablet/mobile
  view. The slot must not fake side bands or a black aspect-ratio frame.
  Pages that need separate desktop and mobile files declare two native slots with
  one semantic family plus a device suffix, for example
  `video-presentacion-escritorio` and `video-presentacion-movil`, and use their
  real media query to expose the active slot. The editor inspector follows the
  visible slot when the preview device changes. Until the pending variant gets
  its own block, preview and published rendering use the single configured sibling
  as a fallback; saving a file in the pending slot creates an independent exact
  binding, which then overrides the fallback.
- Editor, canvas, preview-session and published/live native video blocks use the
  Bunny Storage URL with the customizable Ristak player. Publishing never swaps
  a ready Storage-backed native video to the Bunny Stream iframe, so the saved
  button, colors, controls, preview behavior, video actions and form gate remain
  identical. Preview playback keeps tracking disabled; published playback emits
  Ristak first-party video events while preserving the Media asset and Stream ids.
- During a direct TUS upload the temporary asset has
  `storage_provider='bunny_stream'` and an iframe `public_url`. Finalization must
  validate the TUS byte count, confirm the original in Stream, copy that original
  to Storage, and only then change the row to `storage_provider='bunny'`, a real
  `bunny_path` and a direct Storage `public_url`. The Stream identity remains in
  `metadata_json.stream` for live rendering and analytics.
- A legacy Stream-only row must never be used as `<video src>` and must not fall
  back to its Stream iframe in editor/no-track mode. It shows a preparation state
  while the authenticated editor or preview-session creates the missing Storage
  mirror automatically. The same repair remains available through
  `POST /api/media/assets/:id/stream/sync`, preserves the original Stream video
  ID and is deduplicated with an advisory lock. The same rule applies to imported
  HTML previews. A public request never starts that heavy repair; the iframe is
  only a compatibility fallback for a legacy Stream-only asset until an
  authenticated editor/preview or sync operation creates its Storage mirror.

## App media explorer

- `Configuracion > Media` reconstructs folders from `media_assets.bunny_path`, but must hide technical storage roots such as `accounts/<slug>` and legacy `businesses/<id>`. Users should start at business categories like Media, Cuenta, Chats, Sitios or the first real folder, never at the bucket/account root.
- La biblioteca también conserva en `media_folders` las carpetas creadas por el
  usuario, incluso cuando todavía están vacías. El árbol físico de Bunny se crea
  automáticamente cuando llega el primer archivo a esa ruta; Ristak no fabrica
  archivos marcadores ni expone objetos técnicos al usuario.
- Una subida iniciada desde `Configuracion > Media` manda `folderPath` de forma
  explícita. Esa ruta es relativa a la unidad visible del negocio: el backend la
  normaliza y siempre antepone la raíz inmutable `accounts/<slug>`. Por eso una
  ruta con separadores, `..` o nombres parecidos a raíces técnicas nunca puede
  escribir fuera de la cuenta autenticada.
- Las subidas administrativas se guardan directamente en la carpeta abierta,
  sin agregar automáticamente categoría/año/mes/día. Los uploads internos de
  Chat, Sites, formularios, avatares, anuncios y demás módulos conservan su
  taxonomía automática porque esa estructura pertenece al sistema, no al
  explorador manual.
- El explorador acepta archivos externos arrastrados desde Finder, Escritorio,
  Descargas, volúmenes externos u otra ubicación expuesta por el sistema. Soltar
  sobre una carpeta la usa como destino; soltar en el resto del explorador usa la
  carpeta abierta. El `dropEffect` externo es copia y nunca mueve ni elimina el
  archivo original de la computadora.
- Al arrastrar una carpeta completa, el frontend recorre sus entradas y conserva
  la estructura relativa debajo del destino elegido. Este flujo reutiliza la
  misma cola, progreso, cancelación, `folderPath` y aislamiento
  `accounts/<slug>` que el selector **Subir aquí**. El MIME interno de Media sigue
  reservado para mover assets ya existentes y no se confunde con archivos del
  sistema operativo.
- Crear, mover o eliminar una carpeta actualiza tanto sus assets como su registro
  persistente. Borrar el último archivo no borra por accidente una carpeta creada
  por el usuario; una carpeta vacía puede moverse o eliminarse expresamente.
- Quick filters such as Fotos, Videos, Audio, Docs and Otros are global views from the root of Media. Selecting one resets the current folder and shows matching files directly, while normal folder browsing remains available when the user opens a folder.

## Quotas

Every business starts with 5 GB. Usage is recalculated from active `media_assets` rows and cached in `storage_quotas.used_bytes`.

A prepared TUS video reserves its original size immediately, including while it
is `uploading`, so later attempts see the reservation. Finalization is
idempotent and keeps the same reservation; canceling or expiring the pending
upload releases it.

If Bunny reports terminal processing status `5` or `6`, the backend deletes the
pending asset/video, releases the quota and returns a non-retryable `422` instead
of leaving a false success or a stuck reservation.

Quota fields:

- `quota_bytes`
- `used_bytes`
- `extra_quota_gb`
- `storage_enabled`

## Existing media migration

Dry run:

```bash
npm run media:migrate-to-bunny -- --limit=500
```

Apply automation assets:

```bash
npm run media:migrate-to-bunny -- --apply --limit=500
```

Include imported site binary assets:

```bash
npm run media:migrate-to-bunny -- --apply --include-site-import-assets --limit=500
```

The script creates `media_assets` rows and uploads copies. It does not delete legacy rows or rewrite module references automatically.

## Smoke tests

Upload image:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  -F "file=@./image.png" \
  -F "module=business_settings" \
  https://APP.onrender.com/api/media/upload
```

Prepare a real Sites video upload (the response contains temporary TUS headers,
not the Stream API key):

```bash
curl -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename":"video.mp4","mimeType":"video/mp4","size":10485760,"module":"sites","moduleEntityId":"site_smoke","clientUploadId":"tus_smoke_video_1"}' \
  'https://APP.onrender.com/api/media/video-upload/prepare?module=sites'
```

Complete the returned TUS session with a TUS client and then call
`POST /api/media/video-upload/:id/finalize?module=sites`. A valid result is a
`media_assets` row with `status=ready`, `storage_provider=bunny_stream` and
`metadata_json.stream.syncStatus=uploaded`.

Check usage:

```bash
curl -H "Authorization: Bearer $TOKEN" https://APP.onrender.com/api/media/storage/usage
```

Installer usage:

```bash
curl -H "Authorization: Bearer $INTERNAL_INSTALLER_TOKEN" https://APP.onrender.com/internal/storage/usage
```

Diagnostics:

```bash
curl -H "Authorization: Bearer $TOKEN" https://APP.onrender.com/api/media/diagnostics
curl -H "Authorization: Bearer $INTERNAL_INSTALLER_TOKEN" https://APP.onrender.com/internal/storage/diagnostics
```
