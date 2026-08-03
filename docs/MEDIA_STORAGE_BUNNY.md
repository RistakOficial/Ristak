# Bunny.net multimedia storage

Ristak stores new user-uploaded media through `mediaStorageService`. The database stores metadata, URLs, ownership, processing state and quota usage. Heavy files go to Bunny Storage when configured; otherwise the service marks storage as `not_configured` and uses a temporary local fallback unless `MEDIA_STORAGE_REQUIRE_BUNNY=true`.

## Cuenta Bunny.net propiedad del negocio

Un administrador puede abrir `Configuración > Plataformas conectadas > Bunny.net`
y pegar una sola **Account API Key**. El backend valida que la llave sea de cuenta,
crea o reutiliza una Storage Zone, una Pull Zone/CDN y una biblioteca de Bunny
Stream, y guarda la llave global junto con las llaves limitadas resultantes dentro
de `app_config.bunny_account_integration_encrypted`. Todo el documento se cifra con
el helper de cifrado de Ristak; las respuestas al frontend sólo incluyen el último
fragmento enmascarado de la llave.

Cuando esta conexión está activa, su configuración tiene prioridad sobre el storage
administrado por Installer y las cargas nuevas van directamente a la cuenta del
negocio. Ristak reporta cuota interna ilimitada porque deja de consumir la cuota
administrada, pero esto no elimina los límites, costos, retención ni políticas de
Bunny.net.

Los assets existentes se migran en segundo plano y por lotes, sin un cron
permanente. Cada archivo se transmite sin materializarlo completo en RAM, se
verifica por tamaño en el destino, se actualiza la fila canónica y sólo entonces se
intenta limpiar el origen. Si esa limpieza falla, la copia verificada permanece
activa y el origen queda marcado para un reintento independiente. Un advisory lock
distribuido impide que varias instancias del backend ejecuten la misma migración.
El estado y los errores resumibles viven cifrados junto con la conexión; abrir el
panel reanuda una migración `pending`/`running`, y el administrador puede reintentar
sólo los pendientes. Desconectar ejecuta la misma garantía en sentido inverso y se
bloquea si la cuota administrada ya no alcanza.

Si la API key pertenece a la misma cuenta que ya usa Installer —por ejemplo la
cuenta principal de Ristak— el backend reconoce la Storage Zone y la biblioteca
actuales, las reutiliza y marca la migración como completada sin duplicar ni mover
archivos. Una rotación de llave sólo se acepta si la nueva llave todavía puede ver
la misma Storage Zone; cambiar a otro propietario exige desconectar primero.

## Render variables

En una instalación gestionada o en un Blueprint standalone, la configuración central de Bunny
se obtiene por backend usando la identidad de licencia existente o el registro técnico automático
del tenant. No se deben copiar llaves Bunny a Render. Las variables siguientes describen el
contrato de una configuración explícita/local y conservan prioridad cuando existen.

Required for an explicit Bunny Storage configuration:

- `MEDIA_STORAGE_PROVIDER=bunny`
- `MEDIA_COMPRESSION_ENABLED=true`
- `DEFAULT_STORAGE_QUOTA_GB=1` (compatibilidad de despliegue; el modo
  administrado nunca entrega más de 1 GB)
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

- `GET /api/integrations/bunny` (admin con `settings_integrations`)
- `POST /api/integrations/bunny/connect` (admin con `settings_integrations`)
- `POST /api/integrations/bunny/migration/retry` (admin con `settings_integrations`)
- `DELETE /api/integrations/bunny` (admin con `settings_integrations`)

- `POST /api/media/upload`
- `POST /api/media/upload-preflight`
- `POST /api/media/video-upload/prepare?module=sites`
- `POST /api/media/video-upload/:id/finalize?module=sites`
- `DELETE /api/media/video-upload/:id?module=sites`
- `GET /api/media/assets`
- `POST /api/media/folders`
- `PATCH /api/media/folders/rename`
- `GET /api/media/folders`
- `POST /api/media/folders/sync`
- `GET /api/media/storage/usage`
- `GET /api/media/assets/:id/url`
- `PATCH /api/media/assets/:id/rename`
- `DELETE /api/media/assets/:id`
- `PUT /api/media/assets/:id/replace`
- `POST /api/media/assets/:id/retry`
- `POST /api/media/assets/:id/stream/queue`
- `POST /api/media/assets/:id/stream/sync`
- `GET /api/media/diagnostics`

MCP capability endpoint (temporary signed upload ticket, not a session or Bunny
credential):

- `POST /api/media/mcp-upload`

Public file fallback:

- `GET /media/assets/:id/file`
- `GET /media/assets/:id/thumbnail`

Installer/admin panel endpoints (sólo instalaciones gestionadas con token interno explícito):

- `GET /internal/storage/usage`
- `GET /internal/storage/diagnostics`

The installer must send `Authorization: Bearer <INTERNAL_INSTALLER_TOKEN>` or `x-internal-installer-token`.

## MCP local-file uploads, replacements and archives

The `media_prepare_bunny_upload` tool prepares a short-lived capability for a
specific local file. Its arguments are `filename`, `mimeType`, `sizeBytes`,
`sha256`, optional `folderPath`, optional `isPublic`, `confirm=true` and an
`idempotencyKey`. The tool refuses preparation unless Bunny Storage is active
and fully configured; it never returns storage, account or Stream keys.

The MCP JSON contains metadata only. The client streams the local file as
multipart to the returned `/api/media/mcp-upload` URL with the returned
`X-Ristak-Media-Upload-Ticket` header and `file` field. The ticket is valid for
10 minutes and is authorized before Multer writes anything to disk. Ristak loads
the current active user, checks that the issuing OAuth grant/client is still
active and unchanged, and re-applies Developers, `settings_media` and license
gates. Revoking the MCP connection therefore invalidates a pending ticket.

After parsing, backend ignores the multipart filename and destination, restores
those values from the signed ticket and requires exact byte count, compatible
MIME and SHA-256. The canonical `uploadMediaHandler` then applies quota, actual
MIME detection, account-root/folder normalization, compression policy,
`media_upload_requests` idempotency and Bunny upload. The normal configured
limit applies (600 MB by default); large files and every video are streamed from
temporary disk to Bunny instead of being materialized as Base64 or one giant
memory buffer.

The tool result is intentionally non-replayable: the MCP idempotency table keeps
only an ephemeral marker and never persists the temporary ticket. The upload
itself remains replay-safe through its stable `clientUploadId`; retrying the same
ticket and bytes returns the existing asset, while different bytes or metadata
conflict. Temporary files are removed on validation, provider or database
failure and after successful handoff.

Assets enter the normal Media library under `module=media`, so Sites, Forms,
automations and other product surfaces can select them through their existing
Media bindings. This flow is for uploading a new computer file, not for importing
ZIP files as Sites and not for bypassing the dedicated resumable Sites video
editor flow.

`media_prepare_bunny_replace` prepares the same multipart contract for one
existing asset. Its signed pass additionally contains `operation=replace` and
the exact `assetId`; the public upload route restores those values from the pass
and calls the normal replacement controller after validating user, active OAuth
grant, plan, size, MIME and SHA-256. The caller cannot turn a replacement pass
into a new upload or switch the target asset.

`media_prepare_archive_download` prepares a signed temporary GET URL for at most
50 selected asset IDs. `/api/media/mcp-archive/:ticket` re-checks the issuing
user, OAuth grant/client, Developers access, Media access and license before the
canonical ZIP service streams the archive. The URL expires after 10 minutes,
uses `no-store` and must be treated as a temporary bearer link. Bunny credentials
and original asset URLs are never returned as provider secrets.

## Resumable Sites video uploads

Sites, Forms and landing-page videos use a direct Bunny Stream TUS flow instead
of sending the full file through the Render web process:

1. The authenticated frontend calls `video-upload/prepare`. The backend checks
   the Sites plan/access, MIME, applicable account policy, configured video
   limit and available quota,
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
configured for a standard account. A premium media policy never degrades a Sites
video to multipart or to the shared Stream library: prepare fails with
`bunny_stream_premium_profile_unavailable` until its dedicated library is ready.

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
  Forms TUS videos go directly to Bunny Stream for transcoding. Premium media
  accounts always preserve the submitted video source in Ristak.
- Audio is compressed through FFmpeg to a web/WhatsApp-friendly format when possible.
- Failed compression keeps the original so uploads do not die only because FFmpeg is missing.
- New videos selected from Sites, imported site assets and Forms
  (`module=sites`, `module=forms`, `module=landing`) are uploaded directly and
  resumably to Bunny Stream. Standard accounts then stream Bunny Stream's
  authenticated original into Bunny Storage without buffering the full file in
  RAM, which creates their MP4 recovery source. Premium media accounts
  do not relay that large original through Render or duplicate it in Storage:
  the Stream master is retained by Bunny and its adaptive HLS feeds normal
  published playback directly; no-track render stays unavailable because there
  is intentionally no Storage copy. When Sites selects an existing video from Bunny
  Storage, the association completes immediately and
  `POST /api/media/assets/:id/stream/queue` asks Bunny Stream to fetch the CDN URL
  asynchronously. Bunny transfers that source directly; Render never downloads
  or buffers the complete video. The request is deduplicated by asset identity
  and a pending import remains retryable after a process restart. The original
  Storage URL stays usable while Stream imports and transcodes it. Other modules
  do not sync to Stream automatically.
- Ristak creates or reuses a Bunny Stream collection named `Ristak Sites & Forms` unless `BUNNY_STREAM_COLLECTION_ID` is configured.
- Bunny Stream video metadata is stored under `media_assets.metadata_json.stream`.
  `POST /api/media/assets/:id/stream/sync` remains the explicit repair/refresh
  path after transcoding, including the legacy Stream-only mirror case; it is not
  the selection path for an existing Storage video.
- When Bunny exposes playback data, Ristak stores the validated adaptive HLS URL
  under `metadata_json.stream.delivery.playlistUrl` and its poster under
  `metadata_json.stream.delivery.posterUrl`. Published Sites prefer that HLS
  source inside the native Ristak player for audiencia real. The poster is
  visible before the first segment arrives, so a slow connection does not look
  like an empty video. Standard accounts attach the Storage MP4 only as an
  automatic recovery source: after two bounded network retries or two media-error
  recoveries, a fatal HLS failure changes the same `<video>` to MP4 instead of
  leaving it unusable. Editor, preview and every request `no_track` use only the
  Storage MP4 and never request Stream, so provider statistics are not polluted
  even when the public URL includes `?no_track=1`. Premium Stream-only assets
  deliberately have no Storage duplicate: they use validated HLS for audiencia
  pública normal and stay unavailable in `no_track` until a Storage source exists.
- Imported HTML Sites are code-first: pasting complete HTML or uploading an
  HTML/ZIP creates the site/pages and detects media slots before any Media asset
  is selected. `data-rstk-asset-id` and `data-rstk-background-asset-id` declare
  pending, associable slots for images, backgrounds, audio and downloadable
  files; physical Bunny/Storage URLs never become the editable contract.
  `public_site_content_assets` maps each stable, site-wide `asset_key` to the
  current `media_asset_id`. Replacing the selected file changes the binding
  without changing HTML. Reusing one key anywhere in the same site intentionally
  reuses the same asset; independent zones need different keys.
  Reuploading HTML/ZIP from the open imported-site editor updates that same
  `site_id`, so these bindings survive code revisions. A key omitted by the new
  HTML becomes inactive because nothing renders it, but its binding remains as a
  recoverable backup and is reused if the same stable key returns. Ambiguous or
  changed keys never inherit another binding by filename or visual position.
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
- Premium imported-HTML video supports two explicit native-slot render modes.
  `data-rstk-native-render="ristak"` uses an empty slot such as
  `<div data-rstk-native-element="video" data-rstk-native-id="video-01" data-rstk-native-render="ristak"></div>`
  and preserves the complete Sites player configuration and adaptive
  preview/published-player contract. That native slot itself must not own player
  geometry (`width`, fixed heights,
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
  `data-rstk-native-render="custom"` instead keeps the author's complete HTML/CSS
  player and requires exactly one descendant `<video data-rstk-video-media>`.
  Ristak removes author-supplied `src`/`<source>`, injects the selected Storage
  MP4 or validated Stream HLS playlist, includes the Storage recovery source
  whenever published playback chooses HLS, initializes playback according to
  `videoAdaptiveQuality` and keeps
  first-party tracking, actions and gates on that same element. Buttons, native
  controls, overlays, progress, counters, fullscreen affordances and animations
  are declarative HTML owned by the page; neither the Bunny iframe nor Ristak's
  visual player chrome is mounted. Inline scripts, `on*` handlers and Bunny API
  credentials remain prohibited and sanitized. A standalone code-owned
  `<video>` outside this custom native-slot contract remains legacy/opaque media.
- The native `data-rstk-native-render="ristak"` slot also exposes the complete
  lower-control surface through `data-rstk-video-settings`: `floating` keeps a
  detached panel, `docked` attaches an edge-to-edge lower panel, and `minimal`
  removes the panel while preserving its controls. HTML may set the panel and
  control colors independently from the central play button, plus width, inset,
  height, gap, horizontal/vertical padding, border width, radius, blur and
  shadow. These values are rendered by the same contract in the editor canvas,
  authenticated preview URL and published site; Bunny supplies the media/HLS,
  not the visual chrome.
- Native video blocks use validated HLS inside the same customizable Ristak
  player whenever Bunny has finished preparing it for normal live audience.
  Editor, preview and public URLs marked `no_track` select Storage directly;
  Storage is also the recovery source for normal published HLS playback.
  The right-side video setting **Resolución inteligente** defaults to enabled.
  Its editor copy explains the playback behavior without exposing the storage
  provider: HLS adapts bitrate and resolution to the connection. When disabled,
  Ristak prefers hls.js even in browsers with native HLS support, pauses automatic
  fragment loading until the manifest is known and then fixes the highest available
  rendition before playback starts. If hls.js is unavailable, native HLS remains
  the final compatibility fallback and retains control over its playback pipeline.
  Every hls.js playback starts from the lightest rendition and caps automatic
  selection to the rendered player size and device pixel ratio. After the first
  frame is visible, Ristak restores ABR when `videoAdaptiveQuality` is enabled;
  when it is disabled, it pins the highest rendition requested by the user.
  Preview loops remain on the light rendition until real playback starts. Video
  sources more than 600 px outside the viewport are not activated yet, while
  autoplay videos start immediately only when their player has a real rendered
  box. Responsive desktop/mobile sibling players, including custom HTML players,
  do not receive an MP4 `src` or attach HLS while CSS keeps them at zero size or
  hidden. If a breakpoint hides
  an already active sibling, Ristak pauses it, destroys/releases its current
  HLS/MP4 source and activates only the visible sibling; a real user playback
  keeps its position for a later return, while an automatic teaser does not keep
  consuming bandwidth in the background. Intersection and resize observers
  enforce the same rule in the editor canvas, authenticated preview and live
  site. This never changes the saved quality preference. The Sites
  inspector persists the selected asset duration with the media URL, so its
  full timeline is available immediately. Legacy URLs are metadata-probed and
  remain in an explicit loading state instead of using a temporary 40-second
  fake duration. Timeline decoration captures at most one deferred frame rather
  than seeking across the full file, keeping bandwidth available for the teaser.
  This choice does not surrender the saved button, colors, controls, video
  actions or form gate to a provider iframe. Preview playback loads the real
  Storage media but keeps Ristak tracking and Stream delivery disabled;
  published audience playback emits first-party video events while preserving
  the Media asset and Stream ids. Published Sites
  self-host the pinned `hls.js` runtime at
  `/api/sites/public/video-engine/hls-1.6.16.min.js` with an immutable cache,
  instead of depending on a third-party JavaScript CDN. Esa ruta publica debe
  pasar directamente al router de Sites tanto en el dominio Render como en cada
  dominio personalizado conectado; el resolver de paginas publicas no debe
  interceptarla, porque sin ese motor el navegador deja el teaser HLS detenido
  sobre el poster. A published HLS failure
  recovers on the associated Storage MP4 without replacing the custom player or
  creating another tracking session.
- During a direct TUS upload the temporary asset has
  `storage_provider='bunny_stream'` and an iframe `public_url`. Finalization
  validates the TUS byte count and confirms the original in Stream. Standard
  accounts then copy the original to Storage and change the row to
  `storage_provider='bunny'`; the premium profile deliberately remains
  `bunny_stream`, stores validated HLS delivery metadata and never proxies the
  original through Render. The Stream identity remains in
  `metadata_json.stream` for rendering and analytics.
- A legacy Stream-only row must never be used as `<video src>` and must not fall
  back to its Stream iframe in editor/no-track mode. It shows a preparation state
  until the authenticated editor explicitly requests the missing Storage mirror
  when no validated HLS delivery exists. Generating an authenticated preview no
  longer waits for a complete Stream-to-Storage transfer. The same repair remains
  available through
  `POST /api/media/assets/:id/stream/sync`, preserves the original Stream video
  ID and is deduplicated with an advisory lock. The same rule applies to imported
  HTML previews. A public request never starts that heavy repair; the iframe is
  only a compatibility fallback for a legacy Stream-only asset until an explicit
  authenticated sync operation creates its Storage mirror.

## Fast-start playback and Bunny controls

Ristak controls the browser side: poster-first rendering, lazy activation,
low-rendition startup, adaptive bitrate, player-size caps, bounded recovery,
Storage fallback and first-party QoE telemetry. It cannot make a weak connection
download bytes that never arrive, so “never buffers” is not a valid guarantee.
The measurable target is low startup time and fewer rebuffer events.

The premium library `Ristak Sites Premium Adaptive` is created and reconciled
with Premium Encoding and JIT encoding enabled. Bunny documents JIT as a Premium
feature; Ristak must not send `JitEncodingEnabled` to the standard shared
library. New standard libraries use Player v2 and keep Early Play disabled so the
full original is not exposed as the normal playback path.

The following controls remain in Bunny and are operational/cost decisions, not
safe defaults for Ristak to change silently:

- On the Storage Pull Zone that serves MP4 recovery files, enable
  **Optimize for Video Delivery** (`EnableCacheSlice`) and verify Smart Cache
  covers MP4. This improves byte-range caching of the fallback; it does not
  replace HLS.
- Request coalescing can be enabled on a Pull Zone dedicated to public static
  Media so simultaneous misses for the same video share one origin request.
  Never enable it by reflex on authenticated, personalized or dynamic responses:
  Bunny warns that coalesced requests receive the same content.
- Choose Stream CDN pricing regions/tier for the real viewer geography. High
  Volume is intended for large files/video, while Standard offers the broader
  low-latency network; the correct choice depends on audience and spend.
- Add Bunny Storage/Stream geo-replication near the audience when cold-cache
  latency and resilience justify the additional storage charge. Replication
  regions may be difficult or impossible to remove later, so this requires an
  explicit account decision.
- For an existing premium library that Ristak did not create or cannot reconcile
  through the Core API, verify Premium Encoding and JIT manually in Bunny.

Live QoE emits `video_playing`, `video_buffer_start` and `video_buffer_end`.
Analytics derives `averageStartupSeconds`, `bufferingEvents`,
`playbacksWithBuffering` and `bufferingEventsPerPlayback`, using
`qoePlaybackSamples` as the denominator so historical playbacks without the new
telemetry do not fabricate a zero; editor and preview continue to emit none of
these events.

Sites Analytics builds its video inventory from current usage, not only from the
upload's original `module_entity_id`: it includes HTML content bindings, explicit
block asset IDs and canonical Storage URLs in video blocks. Shared assets expose
all published origin Sites. Storage-only assets remain measurable first-party;
new renders attach their Media ID, and legacy events without IDs can be resolved
from the current block only when they occurred after that block's latest binding
update. Sites Analytics does not query Bunny when a user opens a video detail.
Its plays, unique visitors, watched time and 20-segment retention curve come from
Ristak's first-party event ledger, so Storage fallback remains measurable and a
provider-side zero cannot hide real audience activity. Bunny statistics remain
available only through the explicit provider endpoint for operational diagnosis;
they are not part of the primary product dashboard.

## App media explorer

- `Configuracion > Media` reconstructs folders from `media_assets.bunny_path`, but must hide technical storage roots such as `accounts/<slug>` and legacy `businesses/<id>`. Users should start at business categories like Media, Cuenta, Chats, Sitios or the first real folder, never at the bucket/account root.
- La biblioteca también conserva en `media_folders` las carpetas creadas por el
  usuario, incluso cuando todavía están vacías. El árbol físico de Bunny se crea
  automáticamente cuando llega el primer archivo a esa ruta; Ristak no fabrica
  archivos marcadores ni expone objetos técnicos al usuario.
- Al abrir o refrescar una carpeta, el frontend solicita explícitamente
  `POST /api/media/folders/sync`. El backend lista únicamente ese nivel de Bunny
  Storage bajo la raíz autorizada `accounts/<slug>`, registra las subcarpetas
  encontradas e importa o actualiza los archivos directos en `media_assets`. La
  sincronización es idempotente por ruta física, deduplica refreshes simultáneos,
  clasifica imagen, video, audio y documento por extensión y nunca recorre la
  raíz de otra cuenta.
- La lectura del proveedor es progresiva, no un escaneo recursivo: abrir `Mi
  unidad` descubre su primer nivel y entrar en una carpeta sincroniza su contenido
  directo. Se omiten `_LEEME.txt`, nombres inválidos y derivados técnicos ya
  asociados a un asset, como thumbnails. Una falla temporal de Bunny no bloquea
  la biblioteca que Ristak ya tenía indexada; el siguiente refresh reintenta.
  La sincronización tampoco borra automáticamente registros si un objeto
  desaparece del proveedor, para evitar pérdidas por una lectura parcial.
- Esta importación corresponde al explorador de **Bunny Storage**. Las
  colecciones de Bunny Stream son otra jerarquía del proveedor y no se presentan
  como carpetas de archivos de Storage.
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
- El selector de Media dentro del editor de Sites también navega la unidad
  completa del negocio desde `Mi unidad`, con breadcrumbs, carpeta anterior y
  paginación independiente de archivos y carpetas. El tipo del campo filtra sólo
  los archivos visibles —video, imagen, audio o documento—, no las carpetas:
  todas siguen disponibles para navegar. Cada carpeta se sincroniza con Bunny
  Storage antes de leer su primera página, por lo que una carpeta o archivo
  creado manualmente en la cuenta aparece al abrirla o refrescarla. La búsqueda
  recorre el inventario ya indexado de toda la unidad y una subida manual desde
  el selector se guarda explícitamente en la carpeta abierta; los uploads internos
  que no pasan por ese explorador conservan su taxonomía automática.
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
- Crear, renombrar, mover o eliminar una carpeta actualiza tanto sus assets como su registro
  persistente. Borrar el último archivo no borra por accidente una carpeta creada
  por el usuario; una carpeta vacía puede moverse o eliminarse expresamente.
- **Cambiar nombre** está disponible en el menú de cada archivo y carpeta. En un
  archivo sólo modifica `original_filename`, que es el nombre visible y de
  descarga: no reescribe el binario, `bunny_path`, `public_url` ni bindings por
  asset ID. La extensión real se conserva y el backend rechaza otro nombre igual
  dentro de la misma carpeta. En una carpeta cambia la ruta completa, mueve sus
  assets y subcarpetas con el mismo aislamiento y límites síncronos del flujo de
  mover, conserva carpetas vacías en `media_folders` y rechaza colisiones con una
  carpeta hermana existente.
- Quick filters such as Fotos, Videos, Audio, Docs and Otros are global views from the root of Media. Selecting one resets the current folder and shows matching files directly, while normal folder browsing remains available when the user opens a folder.

## Quotas

Cada negocio estándar recibe exactamente **1 GB** en el Bunny administrado por
Installer. No existen ampliaciones silenciosas ni `extra_quota_gb`: al alcanzar
el byte 1,073,741,824, una carga nueva se rechaza aunque lleguen varios archivos
al mismo tiempo. `media_quota_reservations` aparta los bytes antes de transmitir
una carga tradicional; los videos TUS reservan su tamaño en `media_assets`. Ambos
caminos comparten un candado por negocio, cuentan reservas en curso y liberan las
abandonadas por vencimiento, así que dos cargas concurrentes no pueden rebasar el
techo.

Antes de transmitir contenido, el frontend llama
`POST /api/media/upload-preflight`. El guard está en `apiClient`, por lo que cubre
data URLs y formularios usados por Chat, Automatizaciones, Sites y Configuración;
`mediaService.uploadFile` lo llama además de forma explícita para el flujo TUS y
el XHR con progreso. Si el uso actual más las reservas y el archivo solicitado
entra al último 10% (90% o más), el modal canónico aparece **en cada intento**:
no guarda una preferencia de “no volver a mostrar”. Mientras todavía quepa, el
usuario puede continuar; si no cabe, la subida no empieza. Un administrador puede
ir directo a `/settings/bunny`; otro usuario recibe la instrucción de pedirle al
administrador que conecte la cuenta.

Usage is recalculated from active `media_assets` rows and cached in
`storage_quotas.used_bytes`. La respuesta de uso también declara
`warning_threshold_percent=90`, `warning_required` y `connect_path`.

Una cuenta Bunny.net conectada por el negocio también declara
`quota_mode='unlimited'` y `quota_unlimited=true` dentro de Ristak. Esto significa
que Ristak no aplica su techo administrado a las cargas que paga y conserva el
propio negocio; nunca debe presentarse como almacenamiento gratuito o físicamente
infinito porque Bunny.net conserva sus límites y facturación.

An installation whose normalized owner email matches the internal premium media
policy in `backend/src/services/mediaAccountPolicyService.js` has unlimited
Ristak media quota. This policy belongs to the installation owner, not to the
employee making the request. The usage response declares
`quota_mode='unlimited'` and `quota_unlimited=true`; `quota_bytes`,
`available_bytes` and `usage_percent` are `null` instead of inventing a numeric
ceiling. Physical Bunny account/provider limits still apply.

For that policy, Sites/Forms/landing video also bypasses Ristak's configured
per-video size ceiling because bytes travel browser-to-Bunny through TUS. The
600 MB multipart/Render safety limit remains in place for traditional endpoints;
“unlimited” must never route a giant video through Render memory or disk.

In managed premium mode, the same policy consumes an isolated library named
`Ristak Sites Premium Adaptive`. Installer keeps the global Bunny account key
ciphered in its own database, creates or updates that library, and gives the
installed app only the scoped library ID/API key through `/api/license/storage-config`.
In that managed mode Ristak never receives the global account key; the explicit
customer-owned integration above is the exception requested by the account owner
and stores it encrypted inside the installed app. The profile enforces premium
encoding, Player v2, x264 plus AV1, 240p through 2160p renditions, official
high-quality bitrate defaults, original-file retention, no early direct-original
playback and pre-encoded adaptive HLS. The TUS upload and all playback bytes stay
provider-direct; Ristak stores metadata and never downloads the premium master
merely to upload a duplicate copy. No new Render variable or tenant-managed
secret is introduced. The standard Stream credentials already present in Render
remain available only as the legacy configuration for old videos; new premium
uploads use the dedicated library delivered by Installer.

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
- `warning_threshold_percent`
- `warning_required`
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
`media_assets` row with `status=ready`, `storage_provider=bunny`,
`metadata_json.stream.syncStatus=uploaded` and, once Bunny publishes playback
data, `metadata_json.stream.delivery.playlistUrl`.

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
