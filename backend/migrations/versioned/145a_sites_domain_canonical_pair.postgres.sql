ALTER TABLE public_site_domains ADD COLUMN IF NOT EXISTS canonical_domain TEXT;
ALTER TABLE public_site_domains ADD COLUMN IF NOT EXISTS apex_domain_verified INTEGER;
ALTER TABLE public_site_domains ADD COLUMN IF NOT EXISTS www_domain_verified INTEGER;
ALTER TABLE public_site_domains ADD COLUMN IF NOT EXISTS apex_domain_error TEXT;
ALTER TABLE public_site_domains ADD COLUMN IF NOT EXISTS www_domain_error TEXT;
