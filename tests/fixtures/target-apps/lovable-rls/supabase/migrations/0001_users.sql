-- Lovable CVE-2025-48757 reproduction fixture.
-- The defect: a Supabase table holding user PII shipped without
-- ENABLE ROW LEVEL SECURITY. Anyone with the project's anon key
-- (which is always public) could read every row.

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  full_name text,
  password_hash text NOT NULL
);

-- Note: deliberately missing
--   ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- This is the bug the rls-missing detector should flag.
