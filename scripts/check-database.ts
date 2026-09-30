import 'dotenv/config';
import { checkDatabaseConnection } from '../src/db/check-database.js';

const result = await checkDatabaseConnection(process.env.DATABASE_URL);
console.log(result.message);
process.exitCode = result.ok ? 0 : 1;
