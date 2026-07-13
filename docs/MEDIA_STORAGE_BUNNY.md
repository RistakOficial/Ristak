# Bunny.net multimedia storage

Ristak stores new user-uploaded media through `mediaStorageService`. The database stores metadata, URLs, ownership, processing state and quota usage. Heavy files go to Bunny Storage when configured; otherwise the service marks storage as `not_configured` and uses a temporary local fallback unless `MEDIA_STORAGE_REQUIRE_BUNNY=true`.

## Render variables

Required for Bunny Storage:

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

Do not store Bunny API keys in the database or committed files.

## Endpoints

Authenticated app endpoints:

- `POST /api/media/upload`
- `POST /api/media/video-upload/prepare?module=sites`
- `POST /api/media/video-upload/:id/finalize?module=sites`
- `DELETE /api/media/video-upload/:id?module=sites`
- `GET /api/media/assets`
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

Installer/admin panel endpoints:

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
  resumably to Bunny Stream. Legacy assets can still be copied from Bunny
  Storage to Stream through the compatibility/sync path. Other modules do not
  sync to Stream automatically.
- Ristak creates or reuses a Bunny Stream collection named `Ristak Sites & Forms` unless `BUNNY_STREAM_COLLECTION_ID` is configured.
- Bunny Stream video metadata is stored under `media_assets.metadata_json.stream` and can be refreshed with `POST /api/media/assets/:id/stream/sync` after transcoding finishes.
- Imported HTML Sites do not persist Bunny/Storage URLs as their editable content contract. `public_site_content_assets` maps a stable per-site `asset_key` to the current `media_asset_id`; HTML uses `data-rstk-asset-id` or `data-rstk-background-asset-id`, and the public renderer resolves the current ready/public asset. Replacing an image or file changes the binding without changing the HTML key.
- New configurable Site videos use the Bunny Stream embed in the editor, preview
  and published pages after finalization. The editor paints that iframe
  immediately; if a ready Storage mirror is available it may use the mirror for
  the native player controls and switch to the Stream iframe for live rendering.
  If the mirror lookup is delayed or unavailable, the Stream iframe remains the
  preview fallback instead of leaving a blank/placeholder block. Legacy
  Storage-backed videos keep their existing Storage preview and switch to Stream
  when metadata is ready. Video actions are bridged through Player.js in the
  live iframe.

## App media explorer

- `Configuracion > Media` reconstructs folders from `media_assets.bunny_path`, but must hide technical storage roots such as `accounts/<slug>` and legacy `businesses/<id>`. Users should start at business categories like Media, Cuenta, Chats, Sitios or the first real folder, never at the bucket/account root.
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
