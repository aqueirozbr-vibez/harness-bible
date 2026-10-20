-- The decision-aid walk (feature-specs/18 § 6, D4): the reader's inputs on the USER row, the script's run and values on
-- the ASSISTANT row, so a reload renders the walk. Forward-only; both nullable, so every row before this is a turn of
-- another mode.
ALTER TABLE "Message" ADD COLUMN "aidInputs" JSONB;
ALTER TABLE "Message" ADD COLUMN "modeResult" JSONB;
