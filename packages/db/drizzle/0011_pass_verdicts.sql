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

-- One-shot data fixes, recorded so that they stay one-shot.
--
-- The UPDATE below is the first of them and it is not idempotent: run it twice
-- and every cut line falls 1.16 instead of 0.58, silently dropping footage from
-- every vlog. The migrator only promises to run a file once against one
-- database, which is a weaker promise than it sounds — a restored dump, a
-- hand-run file, a rebuilt `__drizzle_migrations` and a re-pointed
-- DATABASE_URL all replay it, and the damage is invisible until somebody
-- notices their film is shorter.
--
-- So the fix claims a row before it touches anything, and the claim is what
-- authorises it. Any future correction that can't be run twice belongs here
-- too, under its own id.
CREATE TABLE IF NOT EXISTS "data_fixes" (
	"id" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The claim and the correction are one statement on purpose: a data-modifying
-- CTE runs exactly once whatever the outer query does with it, so there is no
-- window — not even an interrupted hand-run outside a transaction — in which
-- the thresholds have moved and nothing records that they have.
WITH claim AS (
	INSERT INTO "data_fixes" ("id") VALUES ('0011_pass_verdicts')
	ON CONFLICT ("id") DO NOTHING
	RETURNING "id"
)
UPDATE "vlogs" SET "score_threshold" = GREATEST(0, "score_threshold" - 0.58)
WHERE "score_threshold" > 0 AND EXISTS (SELECT 1 FROM claim);
