-- Visual "reset proof" returns to the opening position in one action. It was
-- previously logged as `undo`, which is indistinguishable from removing one step.
ALTER TYPE telemetry_step_type ADD VALUE IF NOT EXISTS 'reset';
