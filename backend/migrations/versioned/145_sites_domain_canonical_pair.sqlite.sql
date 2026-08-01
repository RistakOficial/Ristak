ALTER TABLE public_site_domains ADD COLUMN canonical_domain TEXT;
ALTER TABLE public_site_domains ADD COLUMN apex_domain_verified INTEGER;
ALTER TABLE public_site_domains ADD COLUMN www_domain_verified INTEGER;
ALTER TABLE public_site_domains ADD COLUMN apex_domain_error TEXT;
ALTER TABLE public_site_domains ADD COLUMN www_domain_error TEXT;
