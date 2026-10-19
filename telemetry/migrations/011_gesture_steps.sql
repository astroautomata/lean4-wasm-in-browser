-- Visual gestures that leave the proof unchanged: `rejected` (a gesture the
-- canvas or Lean refused; its reason and Lean's error go in the action's
-- attributes) and `view` (a switch into or out of Transformation or
-- Construction Mode). Replays skip both.
ALTER TYPE telemetry_step_type ADD VALUE IF NOT EXISTS 'rejected';
ALTER TYPE telemetry_step_type ADD VALUE IF NOT EXISTS 'view';
