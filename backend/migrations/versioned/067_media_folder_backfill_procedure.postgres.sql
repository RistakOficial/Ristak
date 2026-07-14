CREATE OR REPLACE FUNCTION ristak_media_folder_path_from_legacy(
  object_path TEXT,
  asset_module TEXT,
  asset_media_type TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  fallback_path TEXT := COALESCE(NULLIF(asset_module, ''), NULLIF(asset_media_type, ''), 'other');
  relative_path TEXT;
BEGIN
  relative_path := CASE
    WHEN object_path ~ '^(accounts|businesses)/[^/]+/'
      THEN regexp_replace(object_path, '^(accounts|businesses)/[^/]+/', '')
    ELSE object_path
  END;

  IF COALESCE(relative_path, '') = '' OR POSITION('/' IN relative_path) = 0 THEN
    RETURN fallback_path;
  END IF;

  RETURN COALESCE(NULLIF(regexp_replace(relative_path, '/[^/]+$', ''), ''), fallback_path);
END;
$$;

-- Durante un deploy overlap una instancia vieja todavia puede insertar el
-- default folder_path=''. El guard permanece despues del backfill porque el
-- overlap termina hasta el cutover healthy, no cuando acaba esta migracion.
CREATE OR REPLACE FUNCTION ristak_fill_media_folder_path_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- INSERT blank viene de una instancia vieja. No interceptamos UPDATE: '' es
  -- una raiz legitima cuando el usuario mueve un archivo a "Mi unidad".
  IF COALESCE(NEW.folder_path, '') = '' THEN
    NEW.folder_path := ristak_media_folder_path_from_legacy(
      NEW.bunny_path,
      NEW.module,
      NEW.media_type
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_media_folder_path_backfill_guard ON media_assets;
DROP TRIGGER IF EXISTS trg_media_folder_path_guard ON media_assets;
CREATE TRIGGER trg_media_folder_path_guard
BEFORE INSERT ON media_assets
FOR EACH ROW EXECUTE FUNCTION ristak_fill_media_folder_path_guard();

-- Congelamos el conjunto legacy antes de empezar los COMMIT por lote. Asi un
-- move legitimo nonblank -> root ('') durante el overlap no entra por accidente
-- al backfill solo porque ocurrio antes del siguiente batch.
CREATE TABLE IF NOT EXISTS media_folder_path_backfill_queue (
  asset_id TEXT PRIMARY KEY
);

INSERT INTO media_folder_path_backfill_queue (asset_id)
SELECT id
FROM media_assets
WHERE COALESCE(folder_path, '') = ''
ON CONFLICT (asset_id) DO NOTHING;

CREATE OR REPLACE PROCEDURE ristak_backfill_media_folder_paths(batch_size INTEGER DEFAULT 2000)
LANGUAGE plpgsql
AS $$
DECLARE
  cursor_id TEXT := '';
  batch_last_id TEXT := '';
  updated_rows INTEGER := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT media.id, media.bunny_path, media.module, media.media_type
      FROM media_assets AS media
      INNER JOIN media_folder_path_backfill_queue AS queue ON queue.asset_id = media.id
      WHERE media.id > cursor_id
        AND COALESCE(media.folder_path, '') = ''
      ORDER BY media.id
      LIMIT GREATEST(1, LEAST(batch_size, 10000))
      -- Este backfill corre una sola vez antes de abrir trafico. Esperar un lock
      -- puntual es preferible a saltar una fila y marcar la migracion completa.
      FOR UPDATE
    ), updated AS (
      UPDATE media_assets AS target
      SET folder_path = ristak_media_folder_path_from_legacy(
        batch.bunny_path,
        batch.module,
        batch.media_type
      )
      FROM batch
      WHERE target.id = batch.id
      RETURNING target.id
    ), cleared AS (
      DELETE FROM media_folder_path_backfill_queue AS queue
      USING updated
      WHERE queue.asset_id = updated.id
      RETURNING queue.asset_id
    )
    SELECT COALESCE(MAX(batch.id), cursor_id), COUNT(*)
    INTO batch_last_id, updated_rows
    FROM batch;

    COMMIT;
    EXIT WHEN updated_rows = 0;
    cursor_id := batch_last_id;
    PERFORM pg_sleep(0.01);
  END LOOP;
END;
$$;
