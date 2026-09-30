import { google, type sheets_v4 } from 'googleapis';
import { SHEET_HEADERS } from './google-sheets.service.js';
import { isGoogleAccountEmail, type GoogleSheetsCredentials } from './credentials.js';

export class GoogleSheetsSetupError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'GoogleSheetsSetupError';
  }
}

/** Narrow injectable port: tests cannot accidentally authenticate or call Google. */
export interface SheetsSetupApi {
  getSpreadsheet(): Promise<sheets_v4.Schema$Spreadsheet>;
  getValues(range: string): Promise<unknown[][]>;
  batchUpdate(requests: sheets_v4.Schema$Request[]): Promise<void>;
}

export interface SetupOrdersSheetOptions {
  spreadsheetId: string;
  ownerEmail: string;
  credentials: GoogleSheetsCredentials;
}

export interface SetupOrdersSheetResult {
  status: 'created' | 'initialized' | 'ready';
  spreadsheetId: string;
  sheetId: number;
  range: 'Orders!A:Y';
  url: string;
}

function createApi(options: SetupOrdersSheetOptions): SheetsSetupApi {
  const api = google.sheets({
    version: 'v4',
    auth: new google.auth.JWT({
      email: options.credentials.serviceAccountEmail,
      key: options.credentials.privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    }),
  });
  const requestOptions = { timeout: 12000, retry: false };
  return {
    async getSpreadsheet() {
      const response = await api.spreadsheets.get(
        {
          spreadsheetId: options.spreadsheetId,
          fields: 'sheets(properties,protectedRanges,merges)',
        },
        requestOptions,
      );
      return response.data;
    },
    async getValues(range) {
      const response = await api.spreadsheets.values.get(
        { spreadsheetId: options.spreadsheetId, range, valueRenderOption: 'FORMULA' },
        requestOptions,
      );
      return response.data.values ?? [];
    },
    async batchUpdate(requests) {
      await api.spreadsheets.batchUpdate(
        { spreadsheetId: options.spreadsheetId, requestBody: { requests } },
        requestOptions,
      );
    },
  };
}

function expectedProtection(sheetId: number, editors: string[]): sheets_v4.Schema$ProtectedRange {
  return {
    description: 'Orders — application-managed rows; edit through the sales agent',
    range: { sheetId },
    warningOnly: false,
    editors: { users: editors, groups: [], domainUsersCanEdit: false },
  };
}

function matchesProtection(
  protection: sheets_v4.Schema$ProtectedRange,
  sheetId: number,
  editors: string[],
): boolean {
  const actualEditors = new Set(protection.editors?.users?.map((email) => email.toLowerCase()));
  return (
    protection.warningOnly !== true &&
    protection.range?.sheetId === sheetId &&
    protection.range.startRowIndex == null &&
    protection.range.endRowIndex == null &&
    protection.range.startColumnIndex == null &&
    protection.range.endColumnIndex == null &&
    !protection.namedRangeId &&
    !protection.tableId &&
    !protection.unprotectedRanges?.length &&
    protection.requestingUserCanEdit !== false &&
    !protection.editors?.groups?.length &&
    protection.editors?.domainUsersCanEdit !== true &&
    actualEditors.size === editors.length &&
    editors.every((email) => actualEditors.has(email.toLowerCase()))
  );
}

function headerRequest(sheetId: number): sheets_v4.Schema$Request {
  return {
    updateCells: {
      start: { sheetId, rowIndex: 0, columnIndex: 0 },
      rows: [
        { values: SHEET_HEADERS.map((header) => ({ userEnteredValue: { stringValue: header } })) },
      ],
      fields: 'userEnteredValue',
    },
  };
}

/**
 * Run with application/owner writes paused. Google has no conditional revision write here:
 * one atomic batch initializes an empty or exact-header-only tab, but cannot lock out edits.
 * Sheets containing order data are validation-only, including protection and frozen rows.
 */
export async function setupOrdersSheet(
  options: SetupOrdersSheetOptions,
  suppliedApi?: SheetsSetupApi,
): Promise<SetupOrdersSheetResult> {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(options.spreadsheetId))
    throw new GoogleSheetsSetupError('SHEETS_SPREADSHEET_ID_INVALID');
  const owner = options.ownerEmail.trim().toLowerCase();
  const serviceAccount = options.credentials.serviceAccountEmail.trim().toLowerCase();
  if (!isGoogleAccountEmail(owner) || !isGoogleAccountEmail(serviceAccount))
    throw new GoogleSheetsSetupError('SHEETS_EDITOR_EMAIL_INVALID');
  const editors = [...new Set([serviceAccount, owner])];
  const api = suppliedApi ?? createApi(options);
  try {
    const metadata = await api.getSpreadsheet();
    const sheets = metadata.sheets ?? [];
    const sheet = sheets.find((item) => item.properties?.title === 'Orders');
    let sheetId: number;
    let status: SetupOrdersSheetResult['status'];
    const requests: sheets_v4.Schema$Request[] = [];
    if (!sheet) {
      const usedIds = new Set(sheets.map((item) => item.properties?.sheetId));
      sheetId = 0;
      while (usedIds.has(sheetId)) sheetId++;
      requests.push({
        addSheet: {
          properties: {
            sheetId,
            title: 'Orders',
            sheetType: 'GRID',
            gridProperties: {
              rowCount: 1000,
              columnCount: SHEET_HEADERS.length,
              frozenRowCount: 1,
            },
          },
        },
      });
      requests.push(headerRequest(sheetId));
      requests.push({
        addProtectedRange: { protectedRange: expectedProtection(sheetId, editors) },
      });
      status = 'created';
    } else {
      const properties = sheet.properties;
      if (
        properties?.sheetType !== 'GRID' ||
        properties.sheetId == null ||
        !Number.isInteger(properties.sheetId) ||
        properties.sheetId < 0 ||
        sheet.merges?.length
      )
        throw new GoogleSheetsSetupError('SHEET_STRUCTURE_CHANGED');
      sheetId = properties.sheetId;
      const protections = sheet.protectedRanges ?? [];
      if (protections.some((protection) => !matchesProtection(protection, sheetId, editors)))
        throw new GoogleSheetsSetupError('SHEET_PROTECTION_MISMATCH');
      // Entire tab, not just A1:Y1: a blank header is not proof that the sheet is empty.
      // FORMULA keeps even formulas returning an empty string visible to this guard.
      const values = await api.getValues("'Orders'");
      const empty = !values.some((row) => row.some((cell) => cell !== '' && cell != null));
      if (!empty) {
        const headers = values[0] ?? [];
        if (
          !SHEET_HEADERS.every((header, index) => headers[index] === header) ||
          headers.slice(SHEET_HEADERS.length).some((cell) => cell !== '' && cell != null)
        )
          throw new GoogleSheetsSetupError('SHEET_HEADERS_MISMATCH');
      }
      const hasDataRows = values
        .slice(1)
        .some((row) => row.some((cell) => cell !== '' && cell != null));
      const needsGridSetup =
        (properties.gridProperties?.columnCount ?? 0) < SHEET_HEADERS.length ||
        (properties.gridProperties?.frozenRowCount ?? 0) < 1;
      if (hasDataRows) {
        if (!protections.length) throw new GoogleSheetsSetupError('SHEET_NOT_PROTECTED');
        if (needsGridSetup) throw new GoogleSheetsSetupError('SHEET_STRUCTURE_CHANGED');
        status = 'ready';
      } else {
        // Imported templates may contain the exact header row but no protection. Add only
        // missing structure: never rewrite even correct existing headers or cell contents.
        if (needsGridSetup || (properties.gridProperties?.rowCount ?? 0) < 1000)
          requests.push({
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: {
                  rowCount: Math.max(properties.gridProperties?.rowCount ?? 0, 1000),
                  columnCount: Math.max(
                    properties.gridProperties?.columnCount ?? 0,
                    SHEET_HEADERS.length,
                  ),
                  frozenRowCount: Math.max(properties.gridProperties?.frozenRowCount ?? 0, 1),
                },
              },
              fields:
                'gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount',
            },
          });
        if (empty) requests.push(headerRequest(sheetId));
        if (!protections.length)
          requests.push({
            addProtectedRange: { protectedRange: expectedProtection(sheetId, editors) },
          });
        status = requests.length ? 'initialized' : 'ready';
      }
    }
    if (requests.length) await api.batchUpdate(requests);
    return {
      status,
      spreadsheetId: options.spreadsheetId,
      sheetId,
      range: 'Orders!A:Y',
      url: `https://docs.google.com/spreadsheets/d/${options.spreadsheetId}/edit#gid=${sheetId}`,
    };
  } catch (error) {
    if (error instanceof GoogleSheetsSetupError) throw error;
    // Google errors may include request config, OAuth assertions or sheet contents.
    throw new GoogleSheetsSetupError('SHEETS_SETUP_API_FAILED');
  }
}
