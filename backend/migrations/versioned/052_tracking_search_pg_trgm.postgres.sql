-- PostgreSQL/Neon: habilita búsqueda por fragmentos en el documento combinado
-- de tracking. Se separa del índice concurrente porque PostgreSQL no permite
-- CREATE INDEX CONCURRENTLY dentro de la misma transacción implícita.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
