-- El UPDATE monolítico original retenía locks sobre toda media_assets durante el
-- deploy. La rama 065 todavía no fue publicada; el backfill real vive en 067*
-- como procedimiento por lotes con COMMIT entre lotes.
SELECT 1;
