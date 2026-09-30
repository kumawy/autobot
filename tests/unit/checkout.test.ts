import { describe, expect, it } from 'vitest';
import {
  businessDataSchema,
  businessGateReport,
  loadBusinessData,
} from '../../src/config/business.config.js';
import {
  assertCheckoutReady,
  deliverySnapshot,
  packageIssues,
  prepareCheckout,
} from '../../src/modules/orders/checkout.js';
import { CatalogService } from '../../src/modules/knowledge/catalog.service.js';
import type { OrderData } from '../../src/types/domain.js';
const catalog = new CatalogService({ productPrice: 20000 });
const demo = loadBusinessData();
const ids = catalog.discs().map((disc) => disc.id);
const order = (): OrderData => ({
  id: 'o',
  publicOrderId: 'MB-o',
  customerId: 'c',
  recipientName: 'Арман',
  recipientPhone: '+77011234567',
  city: 'Алматы',
  address: 'Абая 10',
  productId: 'music-box-set',
  discId: ids[0]!,
  selectedDiscIds: [ids[0]!],
  quantity: 2,
  unitPrice: 20000,
  totalAmount: 40000,
  currency: 'KZT',
  orderStatus: 'AWAITING_CONFIRMATION',
  paymentStatus: 'NOT_CREATED',
  paymentUrl: null,
});
describe('approved checkout composition and delivery snapshots', () => {
  it('permits explicit demo settings and blocks real checkout without owner approval', () => {
    expect(businessGateReport(demo, { mode: 'demo' }).ready).toBe(true);
    expect(businessGateReport(demo, { mode: 'live' }).ready).toBe(false);
    const prepared = order();
    prepareCheckout(prepared, demo, catalog, 10);
    expect(() => assertCheckoutReady(prepared, { business: demo, catalog, mode: 'live' })).toThrow(
      'BUSINESS_DATA_NOT_APPROVED',
    );
    expect(prepared.deliverySnapshot?.terms.ru).toContain('Точная сумма неизвестна');
    expect(prepared).toMatchObject({
      subtotalAmount: 40000,
      deliveryAmount: 0,
      totalAmount: 40000,
      deliveryMode: 'PAID_SEPARATELY',
    });
  });
  it('captures fixed package names and prepaid delivery without silently dropping the tariff', () => {
    const business = businessDataSchema.parse({
      ...demo,
      packageMode: 'FIXED_SET',
      includedDiscCount: 2,
      fixedDiscIds: ids.slice(0, 2),
      deliveryMode: 'FIXED_PREPAID',
      deliveryTariffs: [{ cities: ['Алматы', 'Almaty'], amount: 3500 }],
    });
    const prepared = order();
    prepareCheckout(prepared, business, catalog, 10);
    expect(prepared).toMatchObject({
      selectedDiscIds: ids.slice(0, 2),
      subtotalAmount: 40000,
      deliveryAmount: 3500,
      totalAmount: 43500,
    });
    expect(prepared.packageSnapshot?.discs).toHaveLength(2);
    expect(() => assertCheckoutReady(prepared, { business, catalog, mode: 'demo' })).not.toThrow();
    expect(() => deliverySnapshot('Астана', business)).toThrow('DELIVERY_TARIFF_UNKNOWN');
  });
  it('validates exact disc counts, unavailable positions and explicit repeated-disc permission', () => {
    const business = { ...demo, includedDiscCount: 2 };
    expect(packageIssues([ids[0]!], business, catalog)).toContain('DISC_COUNT');
    expect(packageIssues([ids[0]!, ids[0]!], business, catalog)).toContain('REPEATED_DISC');
    expect(
      packageIssues([ids[0]!, ids[0]!], { ...business, allowRepeatedDiscs: true }, catalog),
    ).toEqual([]);
    expect(packageIssues([ids[0]!, 'nonexistent'], business, catalog)).toContain(
      'DISC_UNAVAILABLE',
    );
    expect(() =>
      businessDataSchema.parse({ ...demo, packageMode: 'FIXED_SET', fixedDiscIds: [] }),
    ).toThrow();
  });
  it('preserves frozen snapshots and rejects changed configuration before payment creation', () => {
    const prepared = order();
    prepareCheckout(prepared, demo, catalog, 10);
    prepared.checkoutFrozenAt = new Date();
    const before = structuredClone(prepared);
    expect(() => prepareCheckout(prepared, demo, catalog, 10)).toThrow('CHECKOUT_FROZEN');
    expect(prepared).toEqual(before);
    expect(() =>
      assertCheckoutReady(prepared, {
        business: { ...demo, configVersion: 'updated' },
        catalog,
        mode: 'demo',
      }),
    ).toThrow('STALE');
  });
  it('keeps consultation/callback initialization available with missing config but closes the payment gate', () => {
    expect(() => loadBusinessData({ dataDir: '/definitely-missing-business-data' })).toThrow();
    const safe = loadBusinessData({ dataDir: '/definitely-missing-business-data', tolerant: true });
    expect(safe.configVersion).toBe('invalid-config');
    expect(businessGateReport(safe, { mode: 'demo' }).ready).toBe(false);
    expect(businessGateReport(safe, { mode: 'live' }).ready).toBe(false);
  });
});
