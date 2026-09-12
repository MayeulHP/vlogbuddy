-- `curate` and `edit` were phases the creator had to open before anyone could
-- vote or cut. Nothing gates anything now, so both collapse into `open` and the
-- enum shrinks to the three states that are actually distinct.
UPDATE "vlogs" SET "state" = 'open' WHERE "state" IN ('curate', 'edit');--> statement-breakpoint
ALTER TABLE "vlogs" ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "vlog_state" RENAME TO "vlog_state_legacy";--> statement-breakpoint
CREATE TYPE "vlog_state" AS ENUM('open', 'export', 'published');--> statement-breakpoint
ALTER TABLE "vlogs" ALTER COLUMN "state" TYPE "vlog_state" USING "state"::text::"vlog_state";--> statement-breakpoint
ALTER TABLE "vlogs" ALTER COLUMN "state" SET DEFAULT 'open';--> statement-breakpoint
DROP TYPE "vlog_state_legacy";
