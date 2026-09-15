-- Passes are verdicts now, not deletions.
--
-- `reactions.score` gains 0 ("seen it, not for me") with no schema change — the
-- column was already a plain smallint. What does need fixing is every saved cut
-- line, because `rankScore` moved its prior mean onto that scale (1.6 -> 0.8)
-- and now multiplies by supporters rather than by everyone who looked.
--
-- On data written before passes existed, where those two counts are equal by
-- construction, the old score exceeds the new one by 0.51 to 0.64 across every
-- plausible vote profile — near enough a constant to subtract. Without this,
-- every vlog's line would sit higher than the crew put it and quietly drop
-- footage on deploy.
UPDATE "vlogs" SET "score_threshold" = GREATEST(0, "score_threshold" - 0.58)
WHERE "score_threshold" > 0;
