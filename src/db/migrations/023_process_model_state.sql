-- Whether a process has its embedding model loaded, and what that cost. Only a host that
-- pre-warms sets these; NULL means "this role does not hold a model", which is the honest
-- answer for the stdio server and the CLI.
ALTER TABLE processes ADD COLUMN model_state TEXT;
ALTER TABLE processes ADD COLUMN model_ms INTEGER;
ALTER TABLE processes ADD COLUMN model_error TEXT;
