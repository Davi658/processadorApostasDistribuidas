CREATE TABLE command_inbox (
  consumer_name varchar(128) NOT NULL,
  command_id uuid NOT NULL,
  fingerprint char(64) NOT NULL,
  transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
  message_id varchar(128) NOT NULL,
  correlation_id varchar(255),
  causation_id varchar(255),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, command_id)
);
GRANT SELECT, INSERT ON command_inbox TO app_user;
