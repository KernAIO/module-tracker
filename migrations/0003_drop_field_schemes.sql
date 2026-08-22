-- Field schemes are gone. A project used to gate its custom fields twice: once through a field
-- scheme, and once through the per-work-item-type field layout that this release makes real. With
-- both in place a field disappears when *either* gate says so, and nobody can predict which one did
-- it. The layout is the more useful of the two — it also orders fields and marks them required — so
-- the scheme goes.
--
-- Type schemes and workflow schemes stay: they answer different questions.
ALTER TABLE "mod_tracker"."projects" DROP COLUMN IF EXISTS "field_scheme_id";--> statement-breakpoint
DROP TABLE IF EXISTS "mod_tracker"."field_schemes";
