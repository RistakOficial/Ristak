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
- `MEDIA_STORAGE_REQUIRE_BUNNY=true`
- `INTERNAL_INSTALLER_TOKEN`

Do not store Bunny API keys in the database or committed files.

## Endpoints

Authenticated app endpoints:

- `POST /api/media/upload`
- `GET /api/media/assets`
- `GET /api/media/storage/usage`
- `GET /api/media/assets/:id/url`
- `DELETE /api/media/assets/:id`
- `PUT /api/media/assets/:id/replace`
- `POST /api/media/assets/:id/retry`
- `GET /api/media/diagnostics`

Public file fallback:

- `GET /media/assets/:id/file`
- `GET /media/assets/:id/thumbnail`

Installer/admin panel endpoints:

- `GET /internal/storage/usage`
- `GET /internal/storage/diagnostics`

The installer must send `Authorization: Bearer <INTERNAL_INSTALLER_TOKEN>` or `x-internal-installer-token`.

## Processing

- Images are compressed through the shared media compression service and get a WebP thumbnail when possible.
- Videos are compressed/transcoded through FFmpeg to web-friendly MP4 when FFmpeg is available.
- Audio is compressed through FFmpeg to a web/WhatsApp-friendly format when possible.
- Failed compression keeps the original so uploads do not die only because FFmpeg is missing.

## Quotas

Every business starts with 5 GB. Usage is recalculated from active `media_assets` rows and cached in `storage_quotas.used_bytes`.

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

Upload video:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  -F "file=@./video.mp4" \
  -F "module=courses" \
  https://APP.onrender.com/api/media/upload
```

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

