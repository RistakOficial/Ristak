ALTER TABLE public_sites
  ADD COLUMN IF NOT EXISTS public_domain TEXT;

CREATE INDEX IF NOT EXISTS idx_public_sites_public_domain_lower
  ON public_sites(LOWER(public_domain))
  WHERE public_domain IS NOT NULL AND public_domain != '';
