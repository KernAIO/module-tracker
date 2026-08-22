-- A custom field's key is the key it writes into `issues.custom`, so two field definitions that
-- share a key share a value — whatever their project scope. Until now two partial unique indexes
-- allowed exactly that: a workspace-level `severity` and a project-scoped `severity` could coexist
-- and then silently overwrite each other on every issue in that project.
--
-- The fix is one unique constraint over (workspace_id, key). Project scope still decides where a
-- field is *visible*; it no longer decides what it is *called*.
--
-- Refuse to run if the data already contains a collision. Merging two fields means choosing which
-- definition wins and what happens to the values under the loser, and that is not a decision a
-- migration may take on an operator's behalf.
do $$
declare
  conflict text;
begin
  select string_agg(format('%s (%s definitions)', key, n), ', ' order by key)
    into conflict
    from (
      select key, count(*) as n
        from "mod_tracker"."field_defs"
       group by workspace_id, key
      having count(*) > 1
    ) dupes;

  if conflict is not null then
    raise exception
      'tracker: cannot apply 0002_field_keys_unique — duplicate field keys exist: %', conflict
      using hint =
        'Rename or delete the duplicates so each key appears once per workspace, then migrate again.';
  end if;
end $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "mod_tracker"."field_defs_ws_project_key_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "mod_tracker"."field_defs_ws_key_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "field_defs_ws_key_uq" ON "mod_tracker"."field_defs" USING btree ("workspace_id","key");
