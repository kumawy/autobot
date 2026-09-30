import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { migrationDatabaseUrl } from './src/db/database-url.js';
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: migrationDatabaseUrl(process.env),
  },
});
