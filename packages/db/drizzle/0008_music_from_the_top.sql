ALTER TABLE "music_items" ALTER COLUMN "timeline_position" SET DEFAULT 0;--> statement-breakpoint
UPDATE "music_items" SET "timeline_position" = 0 WHERE "timeline_position" = 0.5;--> statement-breakpoint
UPDATE "timelines" SET "doc" = jsonb_set("doc", '{audio}', (
  SELECT jsonb_agg(
    CASE
      WHEN track->>'role' = 'bed'
       AND EXISTS (
         SELECT 1 FROM "music_items" m
         WHERE m."id" = (track->>'musicItemId')::uuid AND m."timeline_position" = 0
       )
      THEN jsonb_set(track, '{startAt}', '0'::jsonb)
      ELSE track
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements("doc"->'audio') WITH ORDINALITY AS a(track, ord)
))
WHERE jsonb_typeof("doc"->'audio') = 'array' AND jsonb_array_length("doc"->'audio') > 0;
