-- Feedback reports record the game build they came from, as attempts do, in an
-- `attributes` extension column.
ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{}'::jsonb;
