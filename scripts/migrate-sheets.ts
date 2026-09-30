import 'dotenv/config';
import { writeFile, mkdir, chmod } from 'node:fs/promises';
import { google } from 'googleapis';
import { readEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/prisma.js';
import { migrateLegacySheetRows } from '../src/modules/sheets/legacy-migration.js';
import {
  GoogleSheetsCredentialsError,
  loadGoogleSheetsCredentials,
} from '../src/modules/sheets/credentials.js';

const env = readEnv();
const db = createDatabase(env.DATABASE_URL);
try {
  if (!env.GOOGLE_SHEETS_SPREADSHEET_ID.trim()) throw new Error('Configure Sheets first');
  const credentials = loadGoogleSheetsCredentials(env);
  const api = google.sheets({
    version: 'v4',
    auth: new google.auth.JWT({
      email: credentials.serviceAccountEmail,
      key: credentials.privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    }),
  });
  // Migration requires writes paused; Google cannot share the DB transaction or cursor lock.
  const metadata = await api.spreadsheets.get(
    { spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID, fields: 'sheets.properties' },
    { timeout: 12000, retry: false },
  );
  const sheet = metadata.data.sheets?.find(
    (value) => value.properties?.sheetId === env.GOOGLE_SHEETS_SHEET_ID,
  );
  if (
    sheet?.properties?.title !== 'Orders' ||
    sheet.properties.sheetType !== 'GRID' ||
    !/^(?:Orders|'Orders')!A(?:1)?:Y$/.test(env.GOOGLE_SHEETS_RANGE)
  )
    throw new Error('SHEET_STRUCTURE_CHANGED');
  const response = await api.spreadsheets.values.get(
    {
      spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
      range: "'Orders'!A2:Y",
      valueRenderOption: 'UNFORMATTED_VALUE',
    },
    { timeout: 12000, retry: false },
  );
  const report = await migrateLegacySheetRows({
    db,
    target: {
      spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
      sheetId: env.GOOGLE_SHEETS_SHEET_ID,
    },
    rows: response.data.values ?? [],
    apply: process.argv.includes('--apply'),
  });
  await mkdir('.local', { recursive: true });
  const path = '.local/sheet-migration-report.json';
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
  console.log(
    JSON.stringify({
      applied: report.applied,
      matches: report.matches.length,
      conflicts: report.conflicts.length,
      nextRowIndex: report.nextRowIndex,
      report: path,
    }),
  );
  if (report.conflicts.length) process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify({
      error: error instanceof GoogleSheetsCredentialsError ? error.code : 'SHEET_MIGRATION_FAILED',
    }),
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
