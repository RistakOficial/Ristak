-- PostgreSQL guarda REAL como float4 y puede redondear importes antes de que la
-- aplicacion los compare con el proveedor. La columna canonica usa unidades
-- mayores de la moneda y seis decimales para cubrir monedas y prorrateos sin
-- introducir aritmetica binaria en el ledger.
--
-- El guard hace segura la repeticion si el DDL se confirmo pero el proceso murio
-- antes de registrar schema_migrations. SQLite omite y registra este archivo en
-- runVersionedMigrations por su sufijo .postgres.sql.
DO $ristak$
BEGIN
  -- LOCAL a la transaccion implicita de este DO: si otra transaccion conserva
  -- un lock largo, el deploy falla y puede reintentarse sin dejar esta opcion
  -- pegada a la conexion que vuelve al pool.
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('payments') IS NULL THEN
    RAISE EXCEPTION 'No existe la tabla payments visible en el search_path';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('payments')
      AND attname = 'amount'
      AND attnum > 0
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'No existe payments.amount en la tabla visible en el search_path';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('payments')
      AND attname = 'amount'
      AND attnum > 0
      AND NOT attisdropped
      AND pg_catalog.format_type(atttypid, atttypmod) <> 'numeric(20,6)'
  ) THEN
    ALTER TABLE payments
      ALTER COLUMN amount TYPE NUMERIC(20, 6)
      USING amount::NUMERIC(20, 6);
  END IF;
END
$ristak$;
