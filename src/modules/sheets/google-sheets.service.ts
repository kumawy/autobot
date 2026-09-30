import { google, type sheets_v4 } from 'googleapis';
import type { Order, Customer, PrismaClient } from '@prisma/client';
import { lock } from '../../db/prisma.js';
import { enqueue } from '../../jobs/outbox.js';

export const SHEET_HEADERS = [
  'Order ID',
  'Created At',
  'Paid At',
  'Customer Name',
  'WhatsApp',
  'Phone',
  'Language',
  'City',
  'Address',
  'Product',
  'Discs',
  'Quantity',
  'Unit Price',
  'Total Amount',
  'Currency',
  'Payment Provider',
  'Payment ID',
  'Payment Status',
  'Order Status',
  'Sheet Synced At',
  'Subtotal Amount',
  'Delivery Amount',
  'Delivery Mode',
  'Payment Incident',
  'Order Version',
];

type RequiredOrderFields =
  | 'id'
  | 'publicOrderId'
  | 'createdAt'
  | 'paidAt'
  | 'recipientName'
  | 'recipientPhone'
  | 'city'
  | 'address'
  | 'productName'
  | 'discTitle'
  | 'quantity'
  | 'unitPrice'
  | 'totalAmount'
  | 'currency'
  | 'paymentProvider'
  | 'externalPaymentId'
  | 'paymentStatus'
  | 'orderStatus';
export type SheetOrder = Pick<Order, RequiredOrderFields> &
  Partial<Order> & {
    customer: Pick<Customer, 'whatsappId' | 'preferredLanguage'> & Partial<Customer>;
    incidentSummary?: string;
    appliedPaymentId?: string | null;
  };

function discsText(order: SheetOrder): string {
  const snapshot = order.packageSnapshot;
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const discs = snapshot.discs;
    if (Array.isArray(discs))
      return discs
        .map((disc) => {
          if (!disc || typeof disc !== 'object' || Array.isArray(disc)) return '';
          const title =
            typeof disc.title === 'string'
              ? disc.title
              : typeof disc.name === 'string'
                ? disc.name
                : '';
          const quantity = typeof disc.quantity === 'number' ? disc.quantity : 1;
          return title ? `${title}${quantity > 1 ? ` × ${quantity}` : ''}` : '';
        })
        .filter(Boolean)
        .join('; ');
  }
  return order.discTitle ?? order.selectedDiscIds?.join('; ') ?? '';
}

export function mapOrderToRow(order: SheetOrder, syncedAt = new Date()): (string | number)[] {
  if (order.paymentStatus !== 'PAID' && !order.paidAt)
    throw new Error('Only paid orders can be exported');
  return [
    order.publicOrderId,
    order.createdAt.toISOString(),
    order.paidAt?.toISOString() ?? '',
    order.recipientName ?? '',
    `+${order.customer.whatsappId}`,
    order.recipientPhone ?? '',
    order.customer.preferredLanguage ?? '',
    order.city ?? '',
    order.address ?? '',
    order.productName,
    discsText(order),
    order.quantity,
    order.unitPrice,
    order.totalAmount,
    order.currency,
    order.paymentProvider ?? '',
    order.appliedPaymentId ?? order.externalPaymentId ?? '',
    order.paymentStatus,
    order.orderStatus,
    syncedAt.toISOString(),
    order.subtotalAmount ?? order.unitPrice * order.quantity,
    order.deliveryAmount ?? 0,
    order.deliveryMode ?? 'UNKNOWN',
    order.incidentSummary ?? '',
    order.version ?? 1,
  ];
}

export interface SheetLease {
  jobId: string;
  lockToken: string;
}
export interface SheetsService {
  sync(order: SheetOrder, lease?: SheetLease): Promise<string>;
}
export class SheetStructureError extends Error {
  readonly code: string;
  constructor(code = 'SHEET_STRUCTURE_CHANGED') {
    super(code);
    this.name = 'SheetStructureError';
    this.code = code;
  }
}
export interface GoogleSheetsOptions {
  db: PrismaClient;
  spreadsheetId: string;
  sheetId: number;
  range: string;
  serviceAccountEmail: string;
  privateKey: string;
}

/** Short DB transactions reserve/finalize a row; every Google request is outside them. */
export class GoogleSheetsService implements SheetsService {
  private readonly api: sheets_v4.Sheets;
  private readonly title: string;
  private readonly sheet: string;
  constructor(private readonly options: GoogleSheetsOptions) {
    const match = /^(?:'([^']+)'|([A-Za-z0-9_ -]+))!A(?:1)?:Y$/.exec(options.range);
    if (!match) throw new Error('Sheet range must be Orders!A:Y (order IDs in column A)');
    if (!Number.isInteger(options.sheetId) || options.sheetId < 0)
      throw new Error('Invalid configured sheet ID');
    this.title = match[1] ?? match[2]!;
    this.sheet = `'${this.title}'`;
    this.api = google.sheets({
      version: 'v4',
      auth: new google.auth.JWT({
        email: options.serviceAccountEmail,
        key: options.privateKey.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      }),
    });
  }

  private async properties(): Promise<sheets_v4.Schema$Sheet> {
    const response = await this.api.spreadsheets.get(
      { spreadsheetId: this.options.spreadsheetId, fields: 'sheets(properties,protectedRanges)' },
      { timeout: 12000, retry: false },
    );
    const sheet = response.data.sheets?.find(
      (value) => value.properties?.sheetId === this.options.sheetId,
    );
    if (!sheet || sheet.properties?.title !== this.title || sheet.properties.sheetType !== 'GRID')
      throw new SheetStructureError();
    const protectedSheet = sheet.protectedRanges?.some(
      (range) =>
        range.warningOnly !== true &&
        range.range?.sheetId === this.options.sheetId &&
        range.range.startRowIndex == null &&
        range.range.endRowIndex == null &&
        range.range.startColumnIndex == null &&
        range.range.endColumnIndex == null &&
        !range.unprotectedRanges?.length,
    );
    if (!protectedSheet) throw new SheetStructureError('SHEET_NOT_PROTECTED');
    return sheet;
  }

  async checkSetup(): Promise<{ ready: boolean; issues: string[] }> {
    try {
      await this.properties();
      await this.headers(false);
      return { ready: true, issues: [] };
    } catch (error) {
      return {
        ready: false,
        issues: [error instanceof SheetStructureError ? error.code : 'SHEET_ACCESS_FAILED'],
      };
    }
  }

  private async headers(initialize: boolean): Promise<void> {
    const existing = await this.api.spreadsheets.values.get(
      { spreadsheetId: this.options.spreadsheetId, range: `${this.sheet}!A1:Y1` },
      { timeout: 12000, retry: false },
    );
    const row = existing.data.values?.[0] ?? [];
    if (!row.some((value) => value !== '' && value != null) && initialize) {
      await this.api.spreadsheets.values.update(
        {
          spreadsheetId: this.options.spreadsheetId,
          range: `${this.sheet}!A1:Y1`,
          valueInputOption: 'RAW',
          requestBody: { values: [SHEET_HEADERS] },
        },
        { timeout: 12000, retry: false },
      );
    } else if (SHEET_HEADERS.some((value, index) => row[index] !== value))
      throw new SheetStructureError('SHEET_HEADER_MISMATCH');
  }

  async sync(input: SheetOrder, lease?: SheetLease): Promise<string> {
    // Root dispatcher serializes the sheet:<orderId> resource across worker leases.
    const { db, spreadsheetId, sheetId } = this.options;
    const snapshot = await db.$transaction(async (tx) => {
      await lock(tx, `order:${input.id}`);
      const order = await tx.order.findUniqueOrThrow({
        where: { id: input.id },
        include: { customer: true },
      });
      if (order.paymentStatus !== 'PAID' && !order.paidAt)
        throw new Error('Only paid orders can be exported');
      let binding = await tx.sheetBinding.findUnique({ where: { orderId: input.id } });
      // A later financial event may have replaced the legacy status marker with PENDING.
      // Historical export evidence still forbids allocating a second sale row.
      if (!binding && order.sheetRowReference !== null)
        throw new SheetStructureError('LEGACY_SHEET_RECONCILIATION_REQUIRED');
      if (binding && (binding.spreadsheetId !== spreadsheetId || binding.sheetId !== sheetId))
        throw new SheetStructureError('SHEET_TARGET_CHANGED');
      if (!binding) {
        await lock(tx, `sheet-cursor:${spreadsheetId}:${sheetId}`);
        const cursor = await tx.sheetCursor.upsert({
          where: { spreadsheetId_sheetId: { spreadsheetId, sheetId } },
          create: { spreadsheetId, sheetId, nextRowIndex: 2 },
          update: {},
        });
        binding = await tx.sheetBinding.create({
          data: { orderId: order.id, spreadsheetId, sheetId, rowIndex: cursor.nextRowIndex },
        });
        await tx.sheetCursor.update({
          where: { spreadsheetId_sheetId: { spreadsheetId, sheetId } },
          data: { nextRowIndex: { increment: 1 } },
        });
      }
      const incidents = await tx.paymentIncident.findMany({
        where: { orderId: order.id, status: 'OPEN' },
        orderBy: { createdAt: 'asc' },
        select: { reason: true },
      });
      const applied = order.appliedPaymentAttemptId
        ? await tx.paymentAttempt.findUnique({
            where: { id: order.appliedPaymentAttemptId },
            select: { externalPaymentId: true },
          })
        : null;
      return {
        order,
        binding,
        incidentSummary: incidents.map((value) => value.reason).join('; '),
        appliedPaymentId: applied?.externalPaymentId,
      };
    });
    const properties = await this.properties();
    const rowCount = properties.properties?.gridProperties?.rowCount ?? 0;
    const columnCount = properties.properties?.gridProperties?.columnCount ?? 0;
    if (rowCount < snapshot.binding.rowIndex || columnCount < 25) {
      // appendDimension never shrinks another concurrent order's freshly enlarged grid.
      const requests: sheets_v4.Schema$Request[] = [];
      if (rowCount < snapshot.binding.rowIndex)
        requests.push({
          appendDimension: {
            sheetId,
            dimension: 'ROWS',
            length: Math.max(100, snapshot.binding.rowIndex - rowCount),
          },
        });
      if (columnCount < 25)
        requests.push({
          appendDimension: { sheetId, dimension: 'COLUMNS', length: 25 - columnCount },
        });
      await this.api.spreadsheets.batchUpdate(
        { spreadsheetId, requestBody: { requests } },
        { timeout: 12000, retry: false },
      );
    }
    await this.headers(true);
    const range = `${this.sheet}!A${snapshot.binding.rowIndex}:Y${snapshot.binding.rowIndex}`;
    const existing = await this.api.spreadsheets.values.get(
      { spreadsheetId, range, valueRenderOption: 'UNFORMATTED_VALUE' },
      { timeout: 12000, retry: false },
    );
    const existingRow = existing.data.values?.[0] ?? [];
    if (existingRow[0] && existingRow[0] !== snapshot.order.publicOrderId)
      throw new SheetStructureError();
    if (
      !existingRow[0] &&
      (snapshot.binding.syncedOrderVersion > 0 ||
        existingRow.some((value) => value !== '' && value != null))
    )
      throw new SheetStructureError();
    if (Number(existingRow[24] ?? 0) > snapshot.order.version)
      throw new SheetStructureError('SHEET_VERSION_AHEAD');
    const syncedAt = new Date();
    const row = mapOrderToRow(
      {
        ...snapshot.order,
        incidentSummary: snapshot.incidentSummary,
        appliedPaymentId: snapshot.appliedPaymentId,
      },
      syncedAt,
    );
    await this.api.spreadsheets.values.update(
      { spreadsheetId, range, valueInputOption: 'RAW', requestBody: { values: [row] } },
      { timeout: 12000, retry: false },
    );
    await db.$transaction(async (tx) => {
      await lock(tx, `order:${input.id}`);
      if (lease) {
        const owned = await tx.outboxJob.findFirst({
          where: {
            id: lease.jobId,
            lockToken: lease.lockToken,
            status: 'PROCESSING',
            lockedUntil: { gt: new Date() },
          },
        });
        if (!owned) throw new SheetStructureError('SHEET_LEASE_LOST');
      }
      await tx.sheetBinding.update({
        where: { id: snapshot.binding.id },
        data: { syncedOrderVersion: snapshot.order.version, syncedAt },
      });
      const recorded = await tx.order.updateMany({
        where: { id: input.id, version: snapshot.order.version },
        data: { sheetSyncStatus: 'SYNCED', sheetSyncedAt: syncedAt, sheetRowReference: range },
      });
      if (!recorded.count) {
        await tx.order.update({
          where: { id: input.id },
          data: { sheetSyncStatus: 'PENDING', sheetSyncedAt: syncedAt, sheetRowReference: range },
        });
        const current = await tx.order.findUniqueOrThrow({ where: { id: input.id } });
        await enqueue(tx, {
          key: `sheet:${input.id}:${current.version}`,
          kind: 'SHEETS',
          orderId: input.id,
          payload: {},
        });
      }
    });
    return range;
  }
}

export class DemoSheetsService implements SheetsService {
  constructor(private readonly db?: PrismaClient) {}
  async sync(order: SheetOrder, lease?: SheetLease): Promise<string> {
    if (!this.db) {
      mapOrderToRow(order);
      return `demo:Orders:${order.publicOrderId}`;
    }
    return this.db.$transaction(async (tx) => {
      await lock(tx, `order:${order.id}`);
      if (
        lease &&
        !(await tx.outboxJob.findFirst({
          where: {
            id: lease.jobId,
            lockToken: lease.lockToken,
            status: 'PROCESSING',
            lockedUntil: { gt: new Date() },
          },
        }))
      )
        throw new SheetStructureError('SHEET_LEASE_LOST');
      const current = await tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { customer: true },
      });
      mapOrderToRow(current);
      const reference = `demo:Orders:${current.publicOrderId}`;
      await tx.order.update({
        where: { id: order.id },
        data: {
          sheetSyncStatus: 'SYNCED',
          sheetSyncedAt: new Date(),
          sheetRowReference: reference,
        },
      });
      return reference;
    });
  }
}
