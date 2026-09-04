-- Mark a panel as navigation-only. Navigation-only panels stay public, but
-- their HTTP GET and TCPing monitors are excluded from Cron execution.
ALTER TABLE panels
  ADD COLUMN nav_only INTEGER NOT NULL DEFAULT 0 CHECK (nav_only IN (0, 1));

-- The seeded navigation categories are navigation-only by design. Existing
-- custom panels retain the default value of 0 and can be switched in /admin.
UPDATE panels
SET nav_only = 1
WHERE id IN (
  'nav-development-tools',
  'nav-proxy-tools',
  'nav-artificial-intelligence',
  'nav-design-resources',
  'nav-cloud-services',
  'nav-18-plus'
);
