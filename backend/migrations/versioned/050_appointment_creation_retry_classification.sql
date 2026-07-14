ALTER TABLE appointment_creation_requests
  ADD COLUMN error_retryable INTEGER NOT NULL DEFAULT 0;
