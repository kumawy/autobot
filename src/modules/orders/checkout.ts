import type { BusinessDataConfig } from '../../config/business.config.js';
import { businessGateReport } from '../../config/business.config.js';
import type { DeliverySnapshot, OrderData, PackageSnapshot } from '../../types/domain.js';
import type { CatalogService } from '../knowledge/catalog.service.js';
import { calculateTotal } from './order.validator.js';
type Catalog = Pick<CatalogService, 'disc' | 'product'>;

function catalogUnitPrice(catalog: Catalog): number {
  const ru = catalog.product('ru');
  const kk = catalog.product('kk');
  if (ru.price !== kk.price) throw new Error('CATALOG_PRICE_MISMATCH');
  return calculateTotal(1, ru.price);
}

export function selectedDiscs(order: OrderData): string[] {
  return order.selectedDiscIds ?? (order.discId ? [order.discId] : []);
}
export function packageIssues(
  ids: string[],
  business: BusinessDataConfig,
  catalog: Catalog,
): string[] {
  const issues: string[] = [];
  if (ids.length !== business.includedDiscCount) issues.push('DISC_COUNT');
  if (
    business.packageMode === 'SELECTABLE_DISCS' &&
    !business.allowRepeatedDiscs &&
    new Set(ids).size !== ids.length
  )
    issues.push('REPEATED_DISC');
  if (ids.some((id) => !catalog.disc(id)?.available)) issues.push('DISC_UNAVAILABLE');
  if (
    business.packageMode === 'FIXED_SET' &&
    JSON.stringify(ids) !== JSON.stringify(business.fixedDiscIds)
  )
    issues.push('FIXED_PACKAGE_MISMATCH');
  return issues;
}
export function deliverySnapshot(city: string, business: BusinessDataConfig): DeliverySnapshot {
  const normalized = city.trim().toLocaleLowerCase();
  const tariff = business.deliveryTariffs.find((item) =>
    item.cities.some((name) => name.trim().toLocaleLowerCase() === normalized),
  );
  if (business.deliveryMode === 'FIXED_PREPAID' && !tariff)
    throw new Error('DELIVERY_TARIFF_UNKNOWN');
  return {
    mode: business.deliveryMode,
    amount: business.deliveryMode === 'FIXED_PREPAID' ? tariff!.amount : 0,
    city,
    terms: { ...business.deliveryTerms },
    configVersion: business.configVersion,
  };
}
export function prepareCheckout(
  order: OrderData,
  business: BusinessDataConfig,
  catalog: Catalog,
  maxQuantity: number,
): void {
  if (order.checkoutFrozenAt) throw new Error('CHECKOUT_FROZEN');
  const ids =
    business.packageMode === 'FIXED_SET' ? [...business.fixedDiscIds] : selectedDiscs(order);
  const issues = packageIssues(ids, business, catalog);
  if (issues.length) throw new Error(issues.join(','));
  const unitPrice = catalogUnitPrice(catalog);
  const packageSnapshot: PackageSnapshot = {
    packageMode: business.packageMode,
    includedDiscCount: business.includedDiscCount,
    allowRepeatedDiscs: business.allowRepeatedDiscs,
    discs: ids.map((id) => ({ id, title: catalog.disc(id)!.title })),
    productNames: { ru: catalog.product('ru').name, kk: catalog.product('kk').name },
    configVersion: business.configVersion,
    demo: business.demo,
  };
  const delivery = deliverySnapshot(order.city ?? '', business);
  const subtotal = calculateTotal(order.quantity, unitPrice, maxQuantity);
  if (!Number.isSafeInteger(subtotal + delivery.amount)) throw new Error('INVALID_TOTAL');
  Object.assign(order, {
    selectedDiscIds: ids,
    discId: ids[0] ?? null,
    packageSnapshot,
    deliverySnapshot: delivery,
    subtotalAmount: subtotal,
    deliveryAmount: delivery.amount,
    deliveryMode: delivery.mode,
    unitPrice,
    totalAmount: subtotal + delivery.amount,
    currency: 'KZT',
    configVersion: business.configVersion,
  });
}
/** Invoke again immediately before the first provider HTTP create call, not only at startup. */
export function assertCheckoutReady(
  order: OrderData,
  context: { business: BusinessDataConfig; catalog: Catalog; mode: 'demo' | 'live' },
): void {
  const gate = businessGateReport(context.business, { mode: context.mode });
  if (!gate.ready) throw new Error(`BUSINESS_DATA_NOT_APPROVED: ${gate.issues.join('; ')}`);
  if (
    !order.packageSnapshot ||
    !order.deliverySnapshot ||
    order.configVersion !== context.business.configVersion
  )
    throw new Error('CHECKOUT_SNAPSHOT_MISSING_OR_STALE');
  if (packageIssues(selectedDiscs(order), context.business, context.catalog).length)
    throw new Error('PACKAGE_UNAVAILABLE');
  const delivery = deliverySnapshot(order.city ?? '', context.business);
  const unitPrice = catalogUnitPrice(context.catalog);
  const subtotal = calculateTotal(order.quantity, unitPrice, Number.MAX_SAFE_INTEGER);
  if (
    order.unitPrice !== unitPrice ||
    order.subtotalAmount !== subtotal ||
    order.deliveryAmount !== delivery.amount ||
    order.totalAmount !== order.subtotalAmount + order.deliveryAmount ||
    order.currency !== 'KZT'
  )
    throw new Error('CHECKOUT_AMOUNT_MISMATCH');
}
