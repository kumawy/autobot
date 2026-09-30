import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Env } from './env.js';
const localized = z.object({ ru: z.string().trim().min(1), kk: z.string().trim().min(1) }).strict();
export const businessDataSchema = z
  .object({
    configVersion: z.string().min(1),
    demo: z.boolean(),
    businessDataApproved: z.boolean(),
    packageMode: z.enum(['FIXED_SET', 'SELECTABLE_DISCS']),
    includedDiscCount: z.number().int().min(1).max(30),
    fixedDiscIds: z.array(z.string().min(1)),
    allowRepeatedDiscs: z.boolean(),
    deliveryMode: z.enum(['INCLUDED', 'FIXED_PREPAID', 'PAID_SEPARATELY']),
    deliveryTariffs: z.array(
      z
        .object({
          cities: z.array(z.string().min(1)).min(1),
          amount: z.number().int().min(0).max(1_000_000_000).safe(),
        })
        .strict(),
    ),
    deliveryTerms: localized,
    privacyNoticeVersion: z.string().min(1),
    privacyPolicyUrl: z.string().url().nullable(),
    businessContact: z.string().min(1).nullable(),
    privacyNotice: localized,
    notificationConsentVersion: z.string().min(1),
    notificationConsentText: localized,
  })
  .strict()
  .superRefine((data, context) => {
    const cities = data.deliveryTariffs.flatMap((tariff) =>
      tariff.cities.map((city) => city.trim().toLocaleLowerCase()),
    );
    if (new Set(cities).size !== cities.length)
      context.addIssue({
        code: 'custom',
        path: ['deliveryTariffs'],
        message: 'A city may have only one delivery tariff',
      });
    if (data.packageMode === 'FIXED_SET' && data.fixedDiscIds.length !== data.includedDiscCount)
      context.addIssue({
        code: 'custom',
        path: ['fixedDiscIds'],
        message: 'Fixed package must have exactly includedDiscCount discs',
      });
    if (data.packageMode === 'SELECTABLE_DISCS' && data.fixedDiscIds.length)
      context.addIssue({
        code: 'custom',
        path: ['fixedDiscIds'],
        message: 'Selectable package must not have fixed IDs',
      });
  });
export type BusinessDataConfig = z.infer<typeof businessDataSchema>;
export function loadBusinessData(
  options: { dataDir?: string; tolerant?: boolean } = {},
): BusinessDataConfig {
  try {
    return businessDataSchema.parse(
      JSON.parse(
        readFileSync(
          resolve(options.dataDir ?? resolve(process.cwd(), 'data'), 'business.json'),
          'utf8',
        ),
      ),
    );
  } catch (error) {
    if (!options.tolerant) throw error;
    return businessDataSchema.parse({
      configVersion: 'invalid-config',
      demo: true,
      businessDataApproved: false,
      packageMode: 'SELECTABLE_DISCS',
      includedDiscCount: 1,
      fixedDiscIds: [],
      allowRepeatedDiscs: false,
      deliveryMode: 'PAID_SEPARATELY',
      deliveryTariffs: [],
      deliveryTerms: {
        ru: 'Условия доставки не настроены. Нужен менеджер.',
        kk: 'Жеткізу шарттары берілмеген. Менеджер қажет.',
      },
      privacyNoticeVersion: 'invalid-config',
      privacyPolicyUrl: null,
      businessContact: null,
      privacyNotice: {
        ru: 'Данные бизнеса не настроены. Используйте только вымышленные данные; реальные платежи отключены.',
        kk: 'Бизнес деректері берілмеген. Тек ойдан алынған деректерді қолданыңыз; нақты төлемдер өшірілген.',
      },
      notificationConsentVersion: 'invalid-config',
      notificationConsentText: {
        ru: 'Разрешить сообщения по заказу? Рекламы нет. Отказ: стоп.',
        kk: 'Тапсырыс хабарламаларына рұқсат бересіз бе? Жарнама жоқ. Бас тарту: тоқтату.',
      },
    });
  }
}
export function businessGateReport(
  business: BusinessDataConfig,
  options: { mode?: 'demo' | 'live'; catalogReady?: boolean } = {},
) {
  const issues: string[] = [];
  if (business.configVersion === 'invalid-config')
    issues.push('Business configuration is missing or invalid');
  const parsed = businessDataSchema.safeParse(business);
  if (!parsed.success)
    issues.push(...parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  if (options.mode !== 'demo') {
    if (!business.businessDataApproved)
      issues.push('Business data has not been approved by the owner');
    if (business.demo)
      issues.push('Demonstration package/delivery rules cannot create real payments');
    if (!business.privacyPolicyUrl?.startsWith('https://'))
      issues.push('Published HTTPS privacy policy is required');
    if (!business.businessContact) issues.push('Business contact is required');
    for (const language of ['ru', 'kk'] as const) {
      if (
        /\bTODO\b|\bDEMO\b|демонстрац|үлгі|не настроен|берілмеген/iu.test(
          business.deliveryTerms[language],
        )
      )
        issues.push(`Delivery terms ${language} are still placeholders`);
      if (
        /\bTODO\b|\bDEMO\b|демонстрац|үлгі|не настроен|берілмеген/iu.test(
          business.privacyNotice[language],
        )
      )
        issues.push(`Privacy notice ${language} is still a placeholder`);
    }
    if (options.catalogReady === false)
      issues.push('Catalog contains unapproved or missing information');
  }
  if (business.deliveryMode === 'FIXED_PREPAID' && !business.deliveryTariffs.length)
    issues.push('Prepaid delivery tariffs are missing');
  return {
    ready: !issues.length,
    issues,
    configVersion: business.configVersion,
    businessDataApproved: business.businessDataApproved,
  };
}
export const businessConfig = (env: Env) => ({
  currency: 'KZT' as const,
  productPrice: env.PRODUCT_PRICE_KZT,
  maxQuantity: env.MAX_ORDER_QUANTITY,
  allowDiscounts: false,
  supportedLanguages: ['ru', 'kk'] as const,
  processFirstMessageAfterLanguage: env.PROCESS_FIRST_MESSAGE_AFTER_LANGUAGE,
  managerHandoffEnabled: true,
  googleSheetsOnlyPaidOrders: true,
  business: loadBusinessData(),
});
