import { Prisma, type PrismaClient } from '@prisma/client';
import { lock } from '../../db/prisma.js';
import { enqueue } from '../../jobs/outbox.js';

interface Target {
  spreadsheetId: string;
  sheetId: number;
}
interface Conflict {
  orderId: string | null;
  reason: string;
  rows: number[];
}
interface Match {
  orderId: string;
  rowIndex: number;
  version: number;
  bindingAction: 'CREATE' | 'REUSE';
}
export interface SheetMigrationReport extends Target {
  applied: boolean;
  nextRowIndex: number;
  matches: Match[];
  conflicts: Conflict[];
}

class ConcurrentMigrationChange extends Error {
  constructor(
    readonly report: SheetMigrationReport,
    orderId: string,
  ) {
    super('Order changed while applying sheet migration');
    report.conflicts.push({ orderId, reason: 'ORDER_CHANGED_DURING_MIGRATION', rows: [] });
  }
}

function matchesAmount(value: unknown, expected: number): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value === expected;
  if (typeof value !== 'string' || !/^\d+(?:\.0+)?$/.test(value.trim())) return false;
  return BigInt(value.trim().split('.')[0]!) === BigInt(expected);
}

/** The caller reads Google before this function. No external request runs inside its transaction. */
export async function migrateLegacySheetRows(input: {
  db: PrismaClient;
  target: Target;
  rows: unknown[][];
  apply: boolean;
}): Promise<SheetMigrationReport> {
  const { db, target, rows } = input;
  let lastReport: SheetMigrationReport | undefined;
  try {
    return await db.$transaction(
      async (tx) => {
        await lock(tx, `sheet-cursor:${target.spreadsheetId}:${target.sheetId}`);
        const seen = new Map<string, number[]>();
        const conflicts: Conflict[] = [];
        rows.forEach((row, index) => {
          const id = String(row[0] ?? '');
          if (id) seen.set(id, [...(seen.get(id) ?? []), index + 2]);
          else if (row.some((value) => value !== '' && value != null))
            conflicts.push({ orderId: null, reason: 'ROW_WITHOUT_ORDER_ID', rows: [index + 2] });
        });
        // SheetBinding deliberately has no relation field: use IDs to fetch its orders explicitly.
        const allBindings = await tx.sheetBinding.findMany();
        const targetBindings = allBindings.filter(
          (binding) =>
            binding.spreadsheetId === target.spreadsheetId && binding.sheetId === target.sheetId,
        );
        const orders = await tx.order.findMany({
          where: {
            OR: [
              { sheetSyncStatus: 'LEGACY_RECONCILIATION_REQUIRED' },
              { sheetRowReference: { not: null } },
              { publicOrderId: { in: [...seen.keys()] } },
              { id: { in: targetBindings.map((binding) => binding.orderId) } },
            ],
          },
          select: {
            id: true,
            publicOrderId: true,
            version: true,
            totalAmount: true,
            currency: true,
            paymentStatus: true,
            paidAt: true,
            sheetSyncStatus: true,
            sheetRowReference: true,
          },
        });
        const ordersByPublicId = new Map(orders.map((order) => [order.publicOrderId, order]));
        const ordersById = new Map(orders.map((order) => [order.id, order]));
        const byOrder = new Map(allBindings.map((binding) => [binding.orderId, binding]));
        const byRow = new Map(targetBindings.map((binding) => [binding.rowIndex, binding]));
        const needsMigration = (order: (typeof orders)[number]) =>
          order.sheetSyncStatus === 'LEGACY_RECONCILIATION_REQUIRED' ||
          (order.sheetRowReference !== null && !byOrder.has(order.id));
        for (const [publicId, found] of seen) {
          const order = ordersByPublicId.get(publicId);
          if (found.length !== 1) {
            conflicts.push({
              orderId: order?.id ?? publicId,
              reason: 'DUPLICATE_ORDER_ID',
              rows: found,
            });
            continue;
          }
          const rowIndex = found[0]!;
          if (!order) {
            conflicts.push({ orderId: publicId, reason: 'UNKNOWN_ORDER_ID', rows: found });
            continue;
          }
          const row = rows[rowIndex - 2]!;
          if (!matchesAmount(row[13], order.totalAmount) || row[14] !== order.currency)
            conflicts.push({
              orderId: order.id,
              reason: 'AMOUNT_OR_CURRENCY_MISMATCH',
              rows: found,
            });
          if (order.paymentStatus !== 'PAID' && !order.paidAt)
            conflicts.push({ orderId: order.id, reason: 'ORDER_NOT_PAID', rows: found });
          const rowVersion = row[24];
          if (rowVersion !== undefined && rowVersion !== null && rowVersion !== '') {
            const version = Number(rowVersion);
            if (!Number.isSafeInteger(version) || version < 1 || version > order.version)
              conflicts.push({ orderId: order.id, reason: 'ORDER_VERSION_MISMATCH', rows: found });
          }
          const binding = byOrder.get(order.id);
          if (
            binding &&
            (binding.spreadsheetId !== target.spreadsheetId || binding.sheetId !== target.sheetId)
          )
            conflicts.push({ orderId: order.id, reason: 'BINDING_TARGET_MISMATCH', rows: found });
          else if (binding && binding.rowIndex !== rowIndex)
            conflicts.push({
              orderId: order.id,
              reason: 'BINDING_ROW_MISMATCH',
              rows: [binding.rowIndex, rowIndex],
            });
          if (!binding && !needsMigration(order))
            conflicts.push({
              orderId: order.id,
              reason: 'NONLEGACY_ORDER_WITHOUT_BINDING',
              rows: found,
            });
          const occupant = byRow.get(rowIndex);
          if (occupant && occupant.orderId !== order.id)
            conflicts.push({ orderId: order.id, reason: 'ROW_ALREADY_BOUND', rows: found });
        }
        for (const binding of targetBindings) {
          const order = ordersById.get(binding.orderId);
          const row = rows[binding.rowIndex - 2] ?? [];
          const id = String(row[0] ?? '');
          if (order && binding.syncedOrderVersion > order.version)
            conflicts.push({
              orderId: order.id,
              reason: 'BINDING_VERSION_MISMATCH',
              rows: [binding.rowIndex],
            });
          if (
            !order ||
            (id && id !== order.publicOrderId) ||
            (!id && binding.syncedOrderVersion > 0)
          )
            conflicts.push({
              orderId: binding.orderId,
              reason: 'BOUND_ROW_MISMATCH',
              rows: [binding.rowIndex],
            });
        }
        const matches: Match[] = [];
        for (const order of orders.filter(needsMigration)) {
          const found = seen.get(order.publicOrderId) ?? [];
          if (!found.length) {
            conflicts.push({ orderId: order.id, reason: 'MISSING_ORDER_ID', rows: [] });
            continue;
          }
          if (found.length === 1 && !conflicts.some((conflict) => conflict.orderId === order.id))
            matches.push({
              orderId: order.id,
              rowIndex: found[0]!,
              version: order.version,
              bindingAction: byOrder.has(order.id) ? 'REUSE' : 'CREATE',
            });
        }
        const cursor = await tx.sheetCursor.findUnique({
          where: { spreadsheetId_sheetId: target },
        });
        const highestBindingNext = targetBindings.reduce(
          (next, binding) => Math.max(next, binding.rowIndex + 1),
          2,
        );
        const nextRowIndex = Math.max(
          2,
          rows.length + 2,
          cursor?.nextRowIndex ?? 2,
          highestBindingNext,
        );
        const report: SheetMigrationReport = {
          ...target,
          applied: false,
          nextRowIndex,
          matches,
          conflicts,
        };
        lastReport = report;
        if (!input.apply || conflicts.length) return report;
        // Validate the entire report before the first write. Any late conflict aborts all writes.
        for (const match of matches) {
          if (match.bindingAction === 'CREATE')
            await tx.sheetBinding.create({
              data: { ...target, orderId: match.orderId, rowIndex: match.rowIndex },
            });
          const updated = await tx.order.updateMany({
            where: {
              id: match.orderId,
              version: match.version,
              OR: [
                { sheetSyncStatus: 'LEGACY_RECONCILIATION_REQUIRED' },
                { sheetRowReference: { not: null } },
              ],
            },
            data: { sheetSyncStatus: 'PENDING' },
          });
          if (!updated.count) throw new ConcurrentMigrationChange(report, match.orderId);
          await enqueue(tx, {
            key: `sheet:${match.orderId}:v${match.version}:legacy`,
            kind: 'SHEETS',
            orderId: match.orderId,
            payload: {},
          });
        }
        await tx.sheetCursor.upsert({
          where: { spreadsheetId_sheetId: target },
          create: { ...target, nextRowIndex },
          update: { nextRowIndex },
        });
        await tx.auditLog.create({
          data: {
            event: 'legacy_sheet_bindings_migrated',
            details: { ...target, count: matches.length, nextRowIndex },
          },
        });
        return { ...report, applied: true };
      },
      { timeout: 30000 },
    );
  } catch (error) {
    if (error instanceof ConcurrentMigrationChange) return error.report;
    if (
      lastReport &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      ['P2002', 'P2034'].includes(error.code)
    ) {
      lastReport.conflicts.push({
        orderId: null,
        reason: 'BINDINGS_CHANGED_DURING_MIGRATION',
        rows: [],
      });
      return lastReport;
    }
    throw error;
  }
}
