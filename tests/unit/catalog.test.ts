import { mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogService } from '../../src/modules/knowledge/catalog.service.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyData(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'music-box-catalog-'));
  tempDirs.push(dir);
  cpSync(resolve('data'), dir, { recursive: true });
  return dir;
}

describe('CatalogService', () => {
  it('uses configured price consistently instead of editable JSON amounts', () => {
    const catalog = new CatalogService({ productPrice: 21000 });
    expect(catalog.product('ru').price).toBe(21000);
    expect(catalog.product('kk').price).toBe(21000);
    expect(
      catalog
        .faq('ru')
        .find((item) => item.id === 'price')
        ?.answer?.replace(/\s/g, ''),
    ).toContain('21000');
  });

  it('loads 13 localized FAQs and keeps unprovided conditions unknown', () => {
    const catalog = new CatalogService({ productPrice: 20000 });
    for (const language of ['ru', 'kk'] as const) {
      expect(catalog.faq(language)).toHaveLength(13);
      expect(catalog.product(language).deliveryInfo).toBeNull();
      expect(catalog.product(language).warranty).toBeNull();
      expect(catalog.faq(language).find((item) => item.id === 'gift_packaging')?.answer).toBeNull();
    }
  });

  it('only lists available melodies by default, retaining stable IDs', () => {
    const catalog = new CatalogService({ productPrice: 20000 });
    expect(catalog.discs().every((item) => item.available)).toBe(true);
    expect(catalog.discs(false)).toHaveLength(3);
    expect(catalog.disc('disc_003')?.available).toBe(false);
    expect(catalog.disc('invented')).toBeUndefined();
  });

  it('returns copies so callers cannot change trusted facts or stock', () => {
    const catalog = new CatalogService({ productPrice: 20000 });
    catalog.product('ru').price = 1;
    catalog.discs()[0]!.available = false;
    expect(catalog.product('ru').price).toBe(20000);
    expect(catalog.disc('disc_001')?.available).toBe(true);
  });

  it('does not consider demonstration data production ready', () => {
    const result = new CatalogService({ productPrice: 20000 }).productionReadiness();
    expect(result.ready).toBe(false);
    expect(result.issues).toContain('product.ru.deliveryInfo: missing verified information');
    expect(result.issues.some((issue) => issue.includes('demo=true'))).toBe(true);
  });

  it('accepts complete verified data for production readiness', () => {
    const dataDir = copyData();
    for (const language of ['ru', 'kk']) {
      const path = resolve(dataDir, `product.${language}.json`);
      const product = JSON.parse(readFileSync(path, 'utf8'));
      for (const field of [
        'name',
        'description',
        'material',
        'dimensions',
        'warranty',
        'returnPolicy',
        'deliveryInfo',
      ])
        product[field] = 'Verified business value';
      product.demo = false;
      product.packageIncludes = ['Verified contents'];
      product.images = ['https://shop.test/product.jpg'];
      writeFileSync(path, JSON.stringify(product));
      const faqPath = resolve(dataDir, `faq.${language}.json`);
      const faq = JSON.parse(readFileSync(faqPath, 'utf8')) as { answer: string | null }[];
      for (const entry of faq) entry.answer = 'Verified answer';
      writeFileSync(faqPath, JSON.stringify(faq));
    }
    const discsPath = resolve(dataDir, 'discs.json');
    const discs = JSON.parse(readFileSync(discsPath, 'utf8')) as { demo: boolean }[];
    for (const disc of discs) disc.demo = false;
    writeFileSync(discsPath, JSON.stringify(discs));
    expect(new CatalogService({ productPrice: 20000, dataDir }).productionReadiness()).toEqual({
      ready: true,
      issues: [],
    });
  });

  it('rejects duplicate disc IDs and invalid configured prices at startup', () => {
    const dataDir = copyData();
    const path = resolve(dataDir, 'discs.json');
    const discs = JSON.parse(readFileSync(path, 'utf8'));
    discs.push(discs[0]);
    writeFileSync(path, JSON.stringify(discs));
    expect(() => new CatalogService({ productPrice: 20000, dataDir })).toThrow('unique');
    expect(() => new CatalogService({ productPrice: 0 })).toThrow('positive safe integer');
  });
});

it('keeps callback service bootable with a fail-closed unavailable catalog', () => {
  const catalog = new CatalogService({
    productPrice: 20000,
    dataDir: '/nonexistent-catalog-fixture',
    tolerant: true,
  });
  expect(catalog.productionReadiness().ready).toBe(false);
  expect(catalog.discs()).toEqual([]);
  expect(catalog.product('ru').demo).toBe(true);
});
