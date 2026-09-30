import { describe, expect, it, vi } from 'vitest';
import { loadBusinessData, type BusinessDataConfig } from '../../src/config/business.config.js';
import {
  ConversationService,
  WhatsAppActions as A,
} from '../../src/modules/conversation/conversation.service.js';
import { CatalogService } from '../../src/modules/knowledge/catalog.service.js';
import type { ConversationResult } from '../../src/types/domain.js';

function session(businessPatch: Partial<BusinessDataConfig> = {}) {
  const catalog = new CatalogService({ productPrice: 20000 });
  const business = { ...loadBusinessData(), ...businessPatch };
  const answer = vi.fn(async () => ({ text: 'Ответ из каталога.' }));
  const service = new ConversationService({
    catalog,
    ai: { answer },
    business,
    productPrice: 20000,
    maxQuantity: 10,
    processFirstMessageAfterLanguage: true,
  });
  let value: ConversationResult = {
    customer: {
      id: 'customer',
      whatsappId: '77011234567',
      preferredLanguage: 'ru',
      conversationState: 'MAIN_MENU',
      firstUnhandledMessage: null,
      currentOrderId: null,
      selectedDiscId: null,
      editingField: null,
    },
    order: null,
    messages: [],
  };
  let sequence = 0;
  const send = async (text?: string, actionId?: string) =>
    (value = await service.handle({
      customer: value.customer,
      order: value.order,
      message: {
        id: String(++sequence),
        from: '77011234567',
        type: actionId ? 'interactive' : 'text',
        text,
        actionId,
      },
    }));
  const click = (actionId: string) => send(undefined, actionId);
  const input = (text: string) => send(text);
  const address = async () => {
    await click(A.MENU_ORDER);
    await input('Арман');
    await input('+77011234567');
    await input('Алматы');
    return input('Абая 10');
  };
  const summary = async () => {
    await address();
    if (business.packageMode === 'SELECTABLE_DISCS') {
      for (let i = 0; i < business.includedDiscCount; i++)
        await click(A.DISC_PREFIX + catalog.discs()[i]!.id);
      await click(A.DISC_DONE);
    }
    return input('2');
  };
  return {
    catalog,
    business,
    answer,
    click,
    input,
    address,
    summary,
    current: () => value,
    replace: (next: ConversationResult) => {
      value = next;
    },
  };
}

describe('v1.1 conversation navigation and consent', () => {
  it('shows privacy before collecting data and records separate notification opt-in and STOP', async () => {
    const f = session();
    const start = await f.click(A.MENU_ORDER);
    expect(start.customer.privacyNoticeVersion).toBe(f.business.privacyNoticeVersion);
    expect(start.customer.notificationConsent).not.toBe(true);
    expect(start.messages[0]?.type === 'text' && start.messages[0].text).toContain(
      'Для оформления понадобятся',
    );
    expect((await f.click(A.NOTIFICATIONS_OPT_IN)).customer).toMatchObject({
      notificationConsent: true,
      notificationConsentScope: 'ORDER_TRANSACTIONAL',
      notificationConsentSource: 'WHATSAPP_EXPLICIT_BUTTON',
    });
    const stopped = await f.input('стоп');
    expect(stopped.customer.notificationConsent).toBe(false);
    expect(stopped.customer.optedOutAt).toBeTruthy();
    expect(stopped.order?.orderStatus).toBe('DRAFT');
    expect((await f.input('Арман')).customer.conversationState).toBe('ORDER_PHONE');
  });
  it('requires explicit cancellation confirmation and supports keeping the draft', async () => {
    const f = session();
    const before = await f.summary();
    const requested = await f.input('отменить заказ');
    expect(requested.customer.conversationState).toBe('CANCEL_CONFIRMATION');
    expect(requested.order?.orderStatus).toBe('AWAITING_CONFIRMATION');
    expect((await f.input('может быть')).order?.orderStatus).toBe('AWAITING_CONFIRMATION');
    expect((await f.click(A.CANCEL_KEEP)).customer.conversationState).toBe('ORDER_CONFIRMATION');
    expect(f.current().order?.id).toBe(before.order?.id);
    await f.click(A.CANCEL_ORDER);
    expect((await f.click(A.CANCEL_CONFIRM)).order?.orderStatus).toBe('CANCELLED');
    await f.click(A.MENU_ORDER);
    expect((await f.click(A.CANCEL_CONFIRM)).order?.orderStatus).toBe('DRAFT');
  });
  it('BACK changes only the editable step and does not erase values or advance financial status', async () => {
    const f = session();
    await f.address();
    const before = structuredClone(f.current().order);
    expect((await f.input('назад')).customer.conversationState).toBe('ORDER_ADDRESS');
    expect(f.current().order).toEqual(before);
    await f.input('Абая 12');
    await f.click(A.DISC_PREFIX + f.catalog.discs()[0]!.id);
    await f.click(A.DISC_DONE);
    await f.input('1');
    const frozen = await f.click(A.ORDER_CONFIRM);
    expect((await f.input('артқа')).customer.conversationState).toBe('PAYMENT_PENDING');
    expect(f.current().order).toEqual(frozen.order);
  });
  it('MENU during handoff shows ticket status, explicit resume restores a valid step without AI', async () => {
    const f = session();
    await f.click(A.MENU_ORDER);
    await f.input('Арман');
    await f.click(A.MANAGER);
    const menu = await f.input('меню');
    expect(menu.customer.conversationState).toBe('HUMAN_HANDOFF');
    expect(JSON.stringify(menu.messages)).toContain(A.RESUME_BOT);
    expect((await f.input('ботқа оралу')).resumeBot).toBe(true);
    expect(f.current().customer.conversationState).toBe('ORDER_PHONE');
    expect(f.answer).not.toHaveBeenCalled();
  });
  it('switches language without changing frozen checkout snapshots and routes edits to manager', async () => {
    const f = session();
    await f.summary();
    const frozen = await f.click(A.ORDER_CONFIRM);
    expect(frozen.order?.checkoutFrozenAt).toBeTruthy();
    const original = structuredClone(frozen.order);
    await f.click(A.LANG_KK);
    expect(f.current().order).toEqual(original);
    f.replace({
      ...f.current(),
      customer: { ...f.current().customer, conversationState: 'ORDER_CONFIRMATION' },
      order: {
        ...f.current().order!,
        paymentStatus: 'FAILED',
        orderStatus: 'AWAITING_CONFIRMATION',
      },
    });
    const edit = await f.click(A.ORDER_EDIT);
    expect(edit.customer.conversationState).toBe('HUMAN_HANDOFF');
    expect(edit.order?.packageSnapshot).toEqual(original?.packageSnapshot);
    expect(edit.order?.totalAmount).toBe(original?.totalAmount);
  });
  it('separates content version changes from rendering and report status changes', async () => {
    const f = session();
    const started = await f.click(A.MENU_ORDER);
    const initial = started.order!.contentVersion!;
    expect((await f.input('Арман')).order?.contentVersion).toBe(initial + 1);
    const rendered = await f.click(A.LANG_KK);
    expect(rendered.order?.contentVersion).toBe(initial + 1);
    expect(rendered.order?.version).toBe(initial + 1);
  });
});

describe('v1.1 package wizard', () => {
  it('adds, removes and explicitly finishes exactly the configured number of discs', async () => {
    const f = session({ includedDiscCount: 2 });
    await f.address();
    const [first, second] = f.catalog.discs();
    await f.click(A.DISC_PREFIX + first!.id);
    expect((await f.click(A.DISC_DONE)).customer.conversationState).toBe('ORDER_DISC');
    await f.click(A.DISC_PREFIX + first!.id);
    expect(f.current().order?.selectedDiscIds).toEqual([first!.id]);
    await f.click(A.DISC_PREFIX + second!.id);
    await f.click(A.DISC_REMOVE_PREFIX + '0');
    expect(f.current().order?.selectedDiscIds).toEqual([second!.id]);
    await f.click(A.DISC_PREFIX + first!.id);
    expect((await f.click(A.DISC_DONE)).customer.conversationState).toBe('ORDER_QUANTITY');
    const result = await f.input('2');
    expect(result.order?.packageSnapshot?.discs).toHaveLength(2);
    expect(result.order?.totalAmount).toBe(40000);
    expect(JSON.stringify(result.messages)).toContain('одинаковый состав');
  });
  it('skips disc picking for a fixed set and includes approved prepaid delivery', async () => {
    const catalog = new CatalogService({ productPrice: 20000 });
    const ids = catalog
      .discs()
      .slice(0, 2)
      .map((d) => d.id);
    const f = session({
      packageMode: 'FIXED_SET',
      fixedDiscIds: ids,
      includedDiscCount: 2,
      deliveryMode: 'FIXED_PREPAID',
      deliveryTariffs: [{ cities: ['Алматы'], amount: 2500 }],
    });
    expect((await f.address()).customer.conversationState).toBe('ORDER_QUANTITY');
    expect((await f.input('2')).order).toMatchObject({
      selectedDiscIds: ids,
      subtotalAmount: 40000,
      deliveryAmount: 2500,
      totalAmount: 42500,
    });
  });
  it('unknown prepaid city tariff transfers to manager and never produces a zero-delivery link', async () => {
    const f = session({
      deliveryMode: 'FIXED_PREPAID',
      deliveryTariffs: [{ cities: ['Астана'], amount: 2500 }],
    });
    const result = await f.summary();
    expect(result.customer.conversationState).toBe('HUMAN_HANDOFF');
    expect(result.handoff?.reason).toBe('DELIVERY_TARIFF_UNKNOWN');
    expect((await f.click(A.ORDER_CONFIRM)).createPayment).toBeUndefined();
  });
});
