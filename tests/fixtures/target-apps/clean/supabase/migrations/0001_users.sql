-- Negative-control fixture: same PII columns as the Lovable repro, but
-- RLS is enabled and a per-row owner policy is in place. The
-- rls-missing detector should produce ZERO findings against this file.

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  full_name text,
  password_hash text NOT NULL
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_own_rows ON users
  FOR SELECT USING (auth.uid() = id);
