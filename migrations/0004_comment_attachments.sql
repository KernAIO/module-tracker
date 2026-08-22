-- A file can arrive with a comment rather than on the issue as a whole. Recording which comment
-- introduced it lets the comment show its own attachments while the issue keeps listing all of
-- them: an attachment belongs to the issue, and optionally to a comment.
--
-- Nullable, so every file attached before this stays exactly what it was — an issue attachment.
ALTER TABLE "mod_tracker"."attachments" ADD COLUMN IF NOT EXISTS "comment_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_comment_idx" ON "mod_tracker"."attachments" USING btree ("comment_id");
