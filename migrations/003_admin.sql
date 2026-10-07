-- Phase 5e: the admin view. An account with the flag sees everything on
-- the web view's /admin pages (src/game/admin.ts). It is set only from the
-- command line (`npm run key -- admin <name>`), and only a web login
-- carries it: an API key never does.
ALTER TABLE mind.accounts ADD COLUMN admin BOOLEAN NOT NULL DEFAULT FALSE;
