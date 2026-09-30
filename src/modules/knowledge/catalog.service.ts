import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export type Language = 'ru' | 'kk';

const nullableText = z.string().min(1).nullable();
const publicImage = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), 'Images must use HTTPS');
const productSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: nullableText,
    price: z.number().int().positive(),
    currency: z.literal('KZT'),
    packageIncludes: z.array(z.string().min(1)),
    material: nullableText,
    dimensions: nullableText,
    warranty: nullableText,
    returnPolicy: nullableText,
    deliveryInfo: nullableText,
    images: z.array(publicImage),
    demo: z.boolean(),
  })
  .strict();
const discSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    title: z.string().min(1),
    artist: nullableText,
    available: z.boolean(),
    imageUrl: publicImage.nullable(),
    demo: z.boolean(),
  })
  .strict();
const faqSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    answer: nullableText,
  })
  .strict();

export type Product = z.infer<typeof productSchema>;
export type Disc = z.infer<typeof discSchema>;
export type FaqEntry = z.infer<typeof faqSchema>;
export interface CatalogOptions {
  productPrice: number;
  dataDir?: string;
  tolerant?: boolean;
}
export interface CatalogReadiness {
  ready: boolean;
  issues: string[];
}

/** Static, validated business knowledge. Amounts always come from application configuration. */
export class CatalogService {
  private readonly products: Record<Language, Product>;
  private readonly discItems: Disc[];
  private readonly faqs: Record<Language, FaqEntry[]>;

  constructor(options: CatalogOptions) {
    if (!Number.isSafeInteger(options.productPrice) || options.productPrice <= 0) {
      throw new Error('productPrice must be a positive safe integer in KZT');
    }
    try {
      const dataDir = options.dataDir ?? resolve(process.cwd(), 'data');
      const read = (file: string): unknown =>
        JSON.parse(readFileSync(resolve(dataDir, file), 'utf8'));
      this.products = {
        ru: { ...productSchema.parse(read('product.ru.json')), price: options.productPrice },
        kk: { ...productSchema.parse(read('product.kk.json')), price: options.productPrice },
      };
      if (this.products.ru.id !== this.products.kk.id)
        throw new Error('Product IDs must match between languages');
      this.discItems = z.array(discSchema).min(1).parse(read('discs.json'));
      if (new Set(this.discItems.map((disc) => disc.id)).size !== this.discItems.length) {
        throw new Error('Disc IDs must be unique');
      }
      this.faqs = {
        ru: z.array(faqSchema).min(13).parse(read('faq.ru.json')),
        kk: z.array(faqSchema).min(13).parse(read('faq.kk.json')),
      };
      for (const language of ['ru', 'kk'] as const) {
        const ids = this.faqs[language].map((faq) => faq.id);
        if (new Set(ids).size !== ids.length)
          throw new Error(`FAQ IDs must be unique: ${language}`);
      }
    } catch (error) {
      if (!options.tolerant) throw error;
      const fallback = {
        id: 'unavailable-catalog',
        description: null,
        price: options.productPrice,
        currency: 'KZT' as const,
        packageIncludes: [],
        material: null,
        dimensions: null,
        warranty: null,
        returnPolicy: null,
        deliveryInfo: null,
        images: [],
        demo: true,
      };
      this.products = {
        ru: { ...fallback, name: 'Каталог временно недоступен' },
        kk: { ...fallback, name: 'Каталог уақытша қолжетімсіз' },
      };
      this.discItems = [];
      this.faqs = { ru: [], kk: [] };
    }
  }

  product(language: Language): Product {
    return structuredClone(this.products[language]);
  }
  discs(availableOnly = true): Disc[] {
    return structuredClone(this.discItems.filter((disc) => !availableOnly || disc.available));
  }
  disc(id: string): Disc | undefined {
    const found = this.discItems.find((disc) => disc.id === id);
    return found ? structuredClone(found) : undefined;
  }
  faq(language: Language): FaqEntry[] {
    return this.faqs[language].map((entry) => {
      if (entry.id === 'price') {
        const price = this.products[language].price.toLocaleString('ru-RU');
        return {
          ...entry,
          answer:
            language === 'ru'
              ? `Комплект стоит ${price} ₸. Скидки не предусмотрены.`
              : `Жиынтық бағасы — ${price} ₸. Жеңілдіктер қарастырылмаған.`,
        };
      }
      if (entry.id === 'discs' || entry.id === 'choose_song') {
        const titles = this.discs()
          .map((disc) => disc.title)
          .join(', ');
        return {
          ...entry,
          answer:
            language === 'ru'
              ? `Можно выбрать мелодию из каталога: ${titles}.`
              : `Каталогтан әуен таңдауға болады: ${titles}.`,
        };
      }
      if (entry.id === 'package') {
        const items = this.products[language].packageIncludes;
        return { ...entry, answer: items.length > 0 ? items.join(', ') + '.' : null };
      }
      const productField: Partial<Record<string, keyof Product>> = {
        warranty: 'warranty',
        returns: 'returnPolicy',
        delivery: 'deliveryInfo',
        delivery_time: 'deliveryInfo',
      };
      const field = productField[entry.id];
      if (field) {
        const value = this.products[language][field];
        return {
          ...entry,
          answer: typeof value === 'string' && !isPlaceholder(value) ? value : entry.answer,
        };
      }
      return structuredClone(entry);
    });
  }

  productionReadiness(): CatalogReadiness {
    const issues: string[] = [];
    for (const language of ['ru', 'kk'] as const) {
      const product = this.products[language];
      if (product.demo) issues.push(`product.${language}: demo=true; replace demonstration data`);
      for (const field of [
        'name',
        'description',
        'material',
        'dimensions',
        'warranty',
        'returnPolicy',
        'deliveryInfo',
      ] as const) {
        if (!product[field] || isPlaceholder(product[field]))
          issues.push(`product.${language}.${field}: missing verified information`);
      }
      if (!product.images.length)
        issues.push(`product.${language}.images: add real public HTTPS photographs`);
      if (!product.packageIncludes.length || product.packageIncludes.some(isPlaceholder))
        issues.push(`product.${language}.packageIncludes: missing verified contents`);
      for (const faq of this.faq(language)) {
        if (!faq.answer || isPlaceholder(faq.answer))
          issues.push(`faq.${language}.${faq.id}: missing verified answer`);
      }
    }
    if (!this.discs().length) issues.push('discs: no available melodies');
    for (const disc of this.discItems) {
      if (disc.demo || isPlaceholder(disc.title))
        issues.push(`disc.${disc.id}: replace demonstration data`);
    }
    return { ready: issues.length === 0, issues };
  }
}

export function isPlaceholder(value: string): boolean {
  return /\bTODO\b|демонстрац|демо[- ]|үлгі|тестов|example\.com/i.test(value);
}
