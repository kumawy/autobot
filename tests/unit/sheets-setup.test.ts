import type { sheets_v4 } from 'googleapis';
import { describe, expect, it, vi } from 'vitest';
import { SHEET_HEADERS } from '../../src/modules/sheets/google-sheets.service.js';
import {
  setupOrdersSheet,
  type SheetsSetupApi,
  type SetupOrdersSheetOptions,
} from '../../src/modules/sheets/setup.js';

const options: SetupOrdersSheetOptions = {
  spreadsheetId: 'owner-created-spreadsheet',
  ownerEmail: 'owner@example.test',
  credentials: {
    serviceAccountEmail: 'sheets@test.iam.gserviceaccount.com',
    privateKey: 'not-used-with-mock-api',
  },
};
function protection(): sheets_v4.Schema$ProtectedRange {
  return {
    protectedRangeId: 10,
    range: { sheetId: 7 },
    warningOnly: false,
    requestingUserCanEdit: true,
    editors: {
      users: [options.credentials.serviceAccountEmail, options.ownerEmail],
      groups: [],
      domainUsersCanEdit: false,
    },
  };
}
function ordersSheet(): sheets_v4.Schema$Sheet {
  return {
    properties: {
      title: 'Orders',
      sheetId: 7,
      sheetType: 'GRID',
      gridProperties: { columnCount: 25, rowCount: 1000, frozenRowCount: 1 },
    },
    protectedRanges: [protection()],
  };
}
function api(
  sheets: sheets_v4.Schema$Sheet[] = [ordersSheet()],
  values: unknown[][] = [SHEET_HEADERS],
): SheetsSetupApi & {
  getSpreadsheet: ReturnType<typeof vi.fn>;
  getValues: ReturnType<typeof vi.fn>;
  batchUpdate: ReturnType<typeof vi.fn>;
} {
  return {
    getSpreadsheet: vi.fn(async () => ({ sheets })),
    getValues: vi.fn(async () => values),
    batchUpdate: vi.fn(async () => {}),
  };
}

describe('safe Orders tab setup', () => {
  it('creates Orders in one batch without touching other sheets', async () => {
    const mock = api([{ properties: { title: 'Personal', sheetId: 0 } }]);
    const result = await setupOrdersSheet(options, mock);
    expect(result).toMatchObject({ status: 'created', sheetId: 1, range: 'Orders!A:Y' });
    expect(mock.getValues).not.toHaveBeenCalled();
    expect(mock.batchUpdate).toHaveBeenCalledTimes(1);
    const requests = mock.batchUpdate.mock.calls[0]![0] as sheets_v4.Schema$Request[];
    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual({
      addSheet: {
        properties: {
          sheetId: 1,
          title: 'Orders',
          sheetType: 'GRID',
          gridProperties: { rowCount: 1000, columnCount: 25, frozenRowCount: 1 },
        },
      },
    });
    expect(
      requests[1]?.updateCells?.rows?.[0]?.values?.map(
        (cell) => cell.userEnteredValue?.stringValue,
      ),
    ).toEqual(SHEET_HEADERS);
    expect(requests[1]?.updateCells?.fields).toBe('userEnteredValue');
    expect(requests[2]?.addProtectedRange?.protectedRange).toMatchObject({
      range: { sheetId: 1 },
      warningOnly: false,
      editors: {
        users: [options.credentials.serviceAccountEmail, options.ownerEmail],
        groups: [],
        domainUsersCanEdit: false,
      },
    });
  });

  it('validates a populated ready sheet without any mutation', async () => {
    const mock = api(undefined, [SHEET_HEADERS, ['MB-paid-order', 'existing values']]);
    expect(await setupOrdersSheet(options, mock)).toMatchObject({ status: 'ready', sheetId: 7 });
    expect(mock.getValues).toHaveBeenCalledWith("'Orders'");
    expect(mock.batchUpdate).not.toHaveBeenCalled();
  });

  it('is idempotent after a successful creation with a lost caller response', async () => {
    const mock = api([]);
    await setupOrdersSheet(options, mock);
    mock.getSpreadsheet.mockResolvedValue({ sheets: [ordersSheet()] });
    expect((await setupOrdersSheet(options, mock)).status).toBe('ready');
    expect(mock.batchUpdate).toHaveBeenCalledTimes(1);
  });

  it('initializes a completely empty existing tab without shrinking columns', async () => {
    const sheet = ordersSheet();
    sheet.protectedRanges = [];
    sheet.properties!.gridProperties = { rowCount: 100, columnCount: 26 };
    const mock = api([sheet], [[], ['', null]]);
    expect((await setupOrdersSheet(options, mock)).status).toBe('initialized');
    const requests = mock.batchUpdate.mock.calls[0]![0] as sheets_v4.Schema$Request[];
    expect(requests[0]?.updateSheetProperties?.properties?.gridProperties).toEqual({
      rowCount: 1000,
      columnCount: 26,
      frozenRowCount: 1,
    });
    expect(requests).toHaveLength(3);
  });

  it('preserves an existing correct protection while initializing an empty tab', async () => {
    const mock = api(undefined, []);
    await setupOrdersSheet(options, mock);
    const requests = mock.batchUpdate.mock.calls[0]![0] as sheets_v4.Schema$Request[];
    expect(
      requests.every(
        (request) =>
          !request.addProtectedRange &&
          !request.updateProtectedRange &&
          !request.deleteProtectedRange,
      ),
    ).toBe(true);
  });

  it.each([
    [[], ['existing order in row 2']],
    [[], ['', '', '=IF(TRUE,"","")']],
    [['not expected headers']],
    [[...SHEET_HEADERS, 'user-owned extra header']],
    [[...SHEET_HEADERS.slice(0, 24), 'Old Version']],
  ])('does not overwrite nonempty or mismatched contents', async (...rows) => {
    const mock = api(undefined, rows);
    await expect(setupOrdersSheet(options, mock)).rejects.toThrow('SHEET_HEADERS_MISMATCH');
    expect(mock.batchUpdate).not.toHaveBeenCalled();
  });

  it.each([
    { warningOnly: true },
    { range: { sheetId: 7, endRowIndex: 1000 } },
    { range: { sheetId: 7, startRowIndex: 0 } },
    { unprotectedRanges: [{ sheetId: 7, startRowIndex: 1 }] },
    {
      editors: {
        users: [
          options.credentials.serviceAccountEmail,
          options.ownerEmail,
          'stranger@example.test',
        ],
      },
    },
    { editors: { users: [options.ownerEmail] } },
    {
      editors: {
        users: [options.credentials.serviceAccountEmail, options.ownerEmail],
        groups: ['everyone@example.test'],
      },
    },
    {
      editors: {
        users: [options.credentials.serviceAccountEmail, options.ownerEmail],
        domainUsersCanEdit: true,
      },
    },
    { editors: undefined },
    { requestingUserCanEdit: false },
  ])('never replaces mismatched protection, including on an empty tab', async (patch) => {
    const sheet = ordersSheet();
    sheet.protectedRanges = [{ ...protection(), ...patch }];
    const mock = api([sheet], []);
    await expect(setupOrdersSheet(options, mock)).rejects.toThrow('SHEET_PROTECTION_MISMATCH');
    expect(mock.batchUpdate).not.toHaveBeenCalled();
  });

  it('refuses to repair missing protection on a populated sheet', async () => {
    const sheet = ordersSheet();
    sheet.protectedRanges = [];
    const mock = api([sheet], [SHEET_HEADERS, ['MB-existing-order']]);
    await expect(setupOrdersSheet(options, mock)).rejects.toThrow('SHEET_NOT_PROTECTED');
    expect(mock.batchUpdate).not.toHaveBeenCalled();
  });

  it('refuses merged cells before writing headers', async () => {
    const sheet = ordersSheet();
    sheet.merges = [
      { sheetId: 7, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 },
    ];
    const mock = api([sheet], []);
    await expect(setupOrdersSheet(options, mock)).rejects.toThrow('SHEET_STRUCTURE_CHANGED');
    expect(mock.batchUpdate).not.toHaveBeenCalled();
  });

  it('does not alter freeze settings on a populated sheet', async () => {
    const sheet = ordersSheet();
    sheet.properties!.gridProperties!.frozenRowCount = 0;
    const mock = api([sheet], [SHEET_HEADERS, ['MB-existing-order']]);
    await expect(setupOrdersSheet(options, mock)).rejects.toThrow('SHEET_STRUCTURE_CHANGED');
    expect(mock.batchUpdate).not.toHaveBeenCalled();
  });

  it('protects a header-only imported template without writing any cells', async () => {
    const sheet = ordersSheet();
    sheet.protectedRanges = [];
    sheet.properties!.gridProperties!.frozenRowCount = 0;
    const mock = api([sheet], [SHEET_HEADERS, [], ['', null]]);
    expect((await setupOrdersSheet(options, mock)).status).toBe('initialized');
    const requests = mock.batchUpdate.mock.calls[0]![0] as sheets_v4.Schema$Request[];
    expect(requests).toHaveLength(2);
    expect(requests[0]?.updateSheetProperties?.properties?.gridProperties?.frozenRowCount).toBe(1);
    expect(requests[1]?.addProtectedRange?.protectedRange?.range).toEqual({ sheetId: 7 });
    expect(requests.every((request) => !request.updateCells && !request.repeatCell)).toBe(true);
  });

  it('adds only protection when an imported header-only template is already frozen', async () => {
    const sheet = ordersSheet();
    sheet.protectedRanges = [];
    const mock = api([sheet]);
    await setupOrdersSheet(options, mock);
    const requests = mock.batchUpdate.mock.calls[0]![0] as sheets_v4.Schema$Request[];
    expect(requests).toHaveLength(1);
    expect(requests[0]?.addProtectedRange).toBeDefined();
  });

  it('grows a one-row imported header template before freezing without rewriting its cells', async () => {
    const sheet = ordersSheet();
    sheet.properties!.gridProperties = { rowCount: 1, columnCount: 25, frozenRowCount: 0 };
    sheet.protectedRanges = [];
    const mock = api([sheet]);
    await setupOrdersSheet(options, mock);
    const requests = mock.batchUpdate.mock.calls[0]![0] as sheets_v4.Schema$Request[];
    expect(requests[0]?.updateSheetProperties?.properties?.gridProperties).toEqual({
      rowCount: 1000,
      columnCount: 25,
      frozenRowCount: 1,
    });
    expect(requests.every((request) => !request.updateCells && !request.repeatCell)).toBe(true);
  });

  it('does not treat a formula below imported headers as an empty template', async () => {
    const sheet = ordersSheet();
    sheet.protectedRanges = [];
    const mock = api([sheet], [SHEET_HEADERS, ['=""']]);
    await expect(setupOrdersSheet(options, mock)).rejects.toThrow('SHEET_NOT_PROTECTED');
    expect(mock.batchUpdate).not.toHaveBeenCalled();
  });

  it('preserves invalid protection on a header-only template and fails closed', async () => {
    const sheet = ordersSheet();
    sheet.protectedRanges![0]!.warningOnly = true;
    const mock = api([sheet]);
    await expect(setupOrdersSheet(options, mock)).rejects.toThrow('SHEET_PROTECTION_MISMATCH');
    expect(mock.batchUpdate).not.toHaveBeenCalled();
  });

  it.each(['', 'https://docs.google.com/spreadsheets/d/example/edit', '../path'])(
    'validates the explicit spreadsheet ID before network access',
    async (spreadsheetId) => {
      const mock = api();
      await expect(setupOrdersSheet({ ...options, spreadsheetId }, mock)).rejects.toThrow(
        'SHEETS_SPREADSHEET_ID_INVALID',
      );
      expect(mock.getSpreadsheet).not.toHaveBeenCalled();
    },
  );

  it('requires the owner email before network access', async () => {
    const mock = api();
    await expect(setupOrdersSheet({ ...options, ownerEmail: '' }, mock)).rejects.toThrow(
      'SHEETS_EDITOR_EMAIL_INVALID',
    );
    expect(mock.getSpreadsheet).not.toHaveBeenCalled();
  });

  it.each(['getSpreadsheet', 'getValues', 'batchUpdate'] as const)(
    'sanitizes %s errors including request config',
    async (method) => {
      const mock = api(undefined, []);
      mock[method].mockRejectedValue(
        new Error('Authorization: private-assertion; customer content'),
      );
      await expect(setupOrdersSheet(options, mock)).rejects.toThrow(/^SHEETS_SETUP_API_FAILED$/);
      if (method !== 'batchUpdate') expect(mock.batchUpdate).not.toHaveBeenCalled();
    },
  );
});
