-- Preserve existing UUID identities verbatim; external messageId is an opaque string.
ALTER TABLE command_inbox ALTER COLUMN command_id TYPE varchar(255) USING command_id::text;
