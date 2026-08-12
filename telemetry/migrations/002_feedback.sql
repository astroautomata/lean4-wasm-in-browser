CREATE TABLE IF NOT EXISTS feedback_reports (
  report_id uuid PRIMARY KEY,
  user_id uuid REFERENCES anonymous_users(user_id) ON DELETE SET NULL,
  game_id text NOT NULL,
  world_id text NOT NULL,
  level_id integer NOT NULL,
  mode telemetry_mode NOT NULL,
  message varchar(1000) NOT NULL CHECK (length(btrim(message)) > 0),
  proof_state jsonb NOT NULL,
  client_ts timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_reports_level_idx
  ON feedback_reports (game_id, world_id, level_id, mode, received_at);
CREATE INDEX IF NOT EXISTS feedback_reports_user_idx
  ON feedback_reports (user_id, received_at)
  WHERE user_id IS NOT NULL;
