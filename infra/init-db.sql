-- Local credentials only. Runs only when the PostgreSQL volume is empty.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'local_runtime_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END $$;
REVOKE ALL ON DATABASE betting_db FROM PUBLIC;
GRANT CONNECT ON DATABASE betting_db TO app_user;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- Existing migrations grant table-specific runtime permissions.
