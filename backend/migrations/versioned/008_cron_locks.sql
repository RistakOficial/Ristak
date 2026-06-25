-- (CRON-009) Lock de crons entre instancias. Hoy los crons solo tienen un guard en memoria
-- (protege dentro de un proceso, no entre réplicas). Esta tabla permite un lock distribuido
-- por nombre para que un cron sensible (cobros) no corra en dos instancias a la vez.
-- Defensivo: con 1 instancia es inofensivo; protege si se escala. Aditiva e idempotente.
CREATE TABLE IF NOT EXISTS cron_locks (
  name TEXT PRIMARY KEY,
  locked_until DATETIME NOT NULL
);
