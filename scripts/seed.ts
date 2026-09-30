import { readEnv } from '../src/config/env.js';
import { createDatabase, json } from '../src/db/prisma.js';
import { CatalogService } from '../src/modules/knowledge/catalog.service.js';
const env = readEnv();
const db = createDatabase(env.DATABASE_URL);
const catalog = new CatalogService({ productPrice: env.PRODUCT_PRICE_KZT });
try {
  for (const [key, value] of Object.entries({
    business: { name: env.BUSINESS_NAME, currency: 'KZT', productPrice: env.PRODUCT_PRICE_KZT },
    'product.ru': catalog.product('ru'),
    'product.kk': catalog.product('kk'),
    discs: catalog.discs(false),
  }))
    await db.businessSetting.upsert({
      where: { key },
      create: { key, value: json(value) },
      update: { value: json(value) },
    });
  console.log('Каталог проверен, настройки сохранены. Платежи не создавались.');
} finally {
  await db.$disconnect();
}
