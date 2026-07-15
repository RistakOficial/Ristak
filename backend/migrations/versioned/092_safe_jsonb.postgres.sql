CREATE OR REPLACE FUNCTION ristak_safe_jsonb(value TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
BEGIN
  IF value IS NULL OR BTRIM(value) = '' THEN
    RETURN '{}'::jsonb;
  END IF;

  RETURN value::jsonb;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN '{}'::jsonb;
END;
$$;
