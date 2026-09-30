import 'dotenv/config';
import {
  GoogleSheetsCredentialsError,
  loadGoogleSheetsCredentials,
} from '../src/modules/sheets/credentials.js';
import { GoogleSheetsSetupError, setupOrdersSheet } from '../src/modules/sheets/setup.js';

try {
  const credentials = loadGoogleSheetsCredentials(process.env);
  const result = await setupOrdersSheet({
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim() ?? '',
    ownerEmail: process.env.GOOGLE_SHEETS_OWNER_EMAIL?.trim() ?? '',
    credentials,
  });
  console.log(`Google Sheets setup: ${result.status.toUpperCase()}`);
  console.log(`GOOGLE_SHEETS_SPREADSHEET_ID=${result.spreadsheetId}`);
  console.log(`GOOGLE_SHEETS_SHEET_ID=${result.sheetId}`);
  console.log(`GOOGLE_SHEETS_RANGE=${result.range}`);
  console.log(result.url);
} catch (error) {
  const code =
    error instanceof GoogleSheetsCredentialsError || error instanceof GoogleSheetsSetupError
      ? error.code
      : 'SHEETS_SETUP_FAILED';
  console.error(`Google Sheets setup: FAILED (${code})`);
  process.exitCode = 1;
}
