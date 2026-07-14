WITH RECURSIVE split(id, rest, part, idx) AS (
  SELECT id, COALESCE(bunny_path, '') || '/', '', 0
  FROM media_assets
  WHERE COALESCE(folder_path, '') = ''

  UNION ALL

  SELECT
    id,
    substr(rest, instr(rest, '/') + 1),
    substr(rest, 1, instr(rest, '/') - 1),
    idx + 1
  FROM split
  WHERE rest <> ''
),
bounds AS (
  SELECT
    id,
    MAX(idx) AS max_idx,
    MAX(CASE WHEN idx = 1 THEN part END) AS root_part
  FROM split
  GROUP BY id
),
computed AS (
  SELECT
    media_assets.id,
    COALESCE(
      NULLIF((
        SELECT group_concat(part, '/')
        FROM (
          SELECT split.part
          FROM split
          WHERE split.id = media_assets.id
            AND split.idx >= CASE
              WHEN bounds.root_part IN ('accounts', 'businesses') THEN 3
              ELSE 1
            END
            AND split.idx < bounds.max_idx
            AND split.part <> ''
          ORDER BY split.idx
        )
      ), ''),
      COALESCE(NULLIF(media_assets.module, ''), NULLIF(media_assets.media_type, ''), 'other')
    ) AS folder_path
  FROM media_assets
  JOIN bounds ON bounds.id = media_assets.id
  WHERE COALESCE(media_assets.folder_path, '') = ''
)
UPDATE media_assets
SET folder_path = (
  SELECT computed.folder_path
  FROM computed
  WHERE computed.id = media_assets.id
)
WHERE COALESCE(folder_path, '') = '';
