CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL,
  created_at integer NOT NULL,
  display_name text
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  expires_at integer NOT NULL
);
