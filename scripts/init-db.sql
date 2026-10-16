-- Initialize non-superuser application user
DO
$do$
BEGIN
   IF NOT EXISTS (
      SELECT FROM pg_catalog.pg_roles
      WHERE rolname = 'app_user') THEN
      CREATE ROLE app_user WITH LOGIN PASSWORD 'app_user_secret' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
   END IF;
END
$do$;

GRANT CONNECT ON DATABASE betting_db TO app_user;
