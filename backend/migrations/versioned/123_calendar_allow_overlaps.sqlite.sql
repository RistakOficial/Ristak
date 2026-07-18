-- initTables agrega la columna de forma aditiva antes de las migraciones.
-- El empalme es opt-in: ningún cupo legacy o importado lo habilita implícitamente.
UPDATE calendars
SET allow_overlaps = 0
WHERE allow_overlaps IS NULL;
