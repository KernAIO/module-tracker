import { defineConfig } from 'drizzle-kit'
// Generates SQL migrations for the tracker module's own schema. Run: pnpm db:generate
// After generating, append RLS policies for every tenant table (see migrations/0001_rls.sql / `rlsPolicySql`).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/schema.ts',
  out: './migrations',
  schemaFilter: ['mod_tracker'],
})
