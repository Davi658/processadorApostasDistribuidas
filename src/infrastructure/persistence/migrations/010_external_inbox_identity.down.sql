-- Intentionally fails atomically if non-UUID external identities exist. Export/migrate
-- those records before rollback; never discard accepted financial commands.
ALTER TABLE command_inbox ALTER COLUMN command_id TYPE uuid USING command_id::uuid;
