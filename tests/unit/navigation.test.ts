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
  const selection = async () => {
    await click(A.MENU_ORDER);
    if (business.packageMode === 'SELECTABLE_DISCS') {
      for (let i = 0; i < business.includedDiscCount; i++)
        await click(A.DISC_PREFIX + catalog.discs()[i]!.id);
      await click(A.DISC_DONE);
    }
    return value;
  };
  const consent = async () => {
    await selection();
    await input('2');
    return input('Алматы');
  };
  const nameStep = async () => {
    await consent();
    return click(A.NOTIFICATIONS_SKIP);
  };
  const address = async () => {
    await nameStep();
    await input('Арман');
    return input('+77011234567');
  };
  const summary = async () => {
    await address();
    return input('Абая 10');
  };
  return {
    catalog,
    business,
    answer,
    click,
    input,
    address,
    selection,
    consent,
    nameStep,
    summary,
    current: () => value,
    replace: (next: ConversationResult) => {
      value = next;
    },
  };
}

describe('v1.1 conversation navigation and consent', () => {
  it.each(['не сейчас', 'нет', 'кейін', 'жоқ'])(
    'allows declining notifications without blocking checkout: %s',
    async (answer) => {
      const f = session();
      await f.consent();
      const result = await f.input(answer);
      expect(result.customer.conversationState).toBe('ORDER_NAME');
      expect(result.customer.notificationConsent).not.toBe(true);
      expect(result.order?.recipientName).toBeNull();
      expect((await f.input('Арман')).customer.conversationState).toBe('ORDER_PHONE');
    },
  );
  it.each(['разрешить', 'рұқсат беру'])(
    'records explicit text opt-in only at the consent step: %s',
    async (answer) => {
      const f = session();
      await f.consent();
      const result = await f.input(answer);
      expect(result.customer.conversationState).toBe('ORDER_NAME');
      expect(result.customer.notificationConsent).toBe(true);
      expect(result.customer.notificationConsentAt).toBeInstanceOf(Date);
      expect(result.order?.recipientName).toBeNull();
    },
  );
  it('restores an unfinished quantity after leaving shopping for the menu', async () => {
    const f = session();
    await f.selection();
    const order = structuredClone(f.current().order);
    expect(order?.quantity).toBe(1);
    await f.click(A.MENU);
    const resumed = await f.click(A.MENU_ORDER);
    expect(resumed.customer.conversationState).toBe('ORDER_QUANTITY');
    expect(resumed.order).toEqual(order);
  });
  it.each(['menu', 'product'] as const)(
    'still requires explicit quantity after repeated %s detours and a manager handoff',
    async (detour) => {
      const f = session();
      await f.selection();
      const before = structuredClone(f.current().order);
      expect(before?.quantity).toBe(1);
      expect(before?.quantityConfirmed).toBe(false);
      await f.click(A.MENU);
      await f.click(A.MENU);
      if (detour === 'product') await f.click(A.MENU_PRODUCT);
      expect((await f.click(A.MANAGER)).customer.conversationState).toBe('HUMAN_HANDOFF');
      const resumed = await f.click(A.RESUME_BOT);
      expect(resumed.resumeBot).toBe(true);
      expect(resumed.customer.conversationState).toBe('ORDER_QUANTITY');
      expect(resumed.order).toEqual(before);
      const selected = await f.input('2 комплекта');
      expect(selected.customer.conversationState).toBe('ORDER_CITY');
      expect(selected.order?.quantity).toBe(2);
      expect(selected.order?.quantityConfirmed).toBe(true);
      await f.click(A.MENU);
      await f.click(A.MENU);
      await f.click(A.MENU_PRODUCT);
      const restored = await f.click(A.MENU_ORDER);
      expect(restored.customer.conversationState).toBe('ORDER_CITY');
      expect(restored.order?.id).toBe(before?.id);
      expect(restored.order?.quantity).toBe(2);
      expect(restored.order?.quantityConfirmed).toBe(true);
    },
  );
  it('moves back through recipient data, consent, city, quantity and selection without erasing values', async () => {
    const f = session();
    await f.summary();
    const order = structuredClone(f.current().order);
    for (const expected of [
      'ORDER_ADDRESS',
      'ORDER_PHONE',
      'ORDER_NAME',
      'ORDER_CONSENT',
      'ORDER_CITY',
      'ORDER_QUANTITY',
      'ORDER_DISC',
    ]) {
      expect((await f.input('назад')).customer.conversationState).toBe(expected);
      expect(f.current().order).toEqual(order);
    }
  });
  it('shows privacy before collecting data and records separate notification opt-in and STOP', async () => {
    const f = session();
    const shopping = await f.click(A.MENU_ORDER);
    expect(shopping.order?.recipientName).toBeNull();
    const start = await f.consent();
    expect(start.customer.conversationState).toBe('ORDER_CONSENT');
    expect(start.customer.privacyNoticeVersion).toBe(f.business.privacyNoticeVersion);
    expect(start.customer.notificationConsent).not.toBe(true);
    expect(
      start.messages.some(
        (message) => message.type === 'text' && message.text.includes('Для оформления понадобятся'),
      ),
    ).toBe(true);
    expect((await f.click(A.NOTIFICATIONS_OPT_IN)).customer).toMatchObject({
      notificationConsent: true,
      notificationConsentScope: 'ORDER_TRANSACTIONAL',
      notificationConsentSource: 'WHATSAPP_EXPLICIT_BUTTON',
      conversationState: 'ORDER_NAME',
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
    await f.summary();
    const before = structuredClone(f.current().order);
    expect((await f.input('назад')).customer.conversationState).toBe('ORDER_ADDRESS');
    expect(f.current().order).toEqual(before);
    await f.input('Абая 12');
    const frozen = await f.click(A.ORDER_CONFIRM);
    expect((await f.input('артқа')).customer.conversationState).toBe('PAYMENT_PENDING');
    expect(f.current().order).toEqual(frozen.order);
  });
  it('MENU during handoff shows ticket status, explicit resume restores a valid step without AI', async () => {
    const f = session();
    await f.nameStep();
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
    expect((await f.click(A.DISC_PREFIX + f.catalog.discs()[0]!.id)).order?.contentVersion).toBe(
      initial + 1,
    );
    const rendered = await f.click(A.LANG_KK);
    expect(rendered.order?.contentVersion).toBe(initial + 1);
    expect(rendered.order?.version).toBe(initial + 1);
  });
});

describe('v1.1 package wizard', () => {
  it('renders one numbered selection list with shared finish, remove and back controls', async () => {
    const f = session();
    await f.click(A.MENU_ORDER);
    const result = await f.click(A.DISC_PREFIX + f.catalog.discs()[0]!.id);
    const menus = result.messages.filter(
      (message) => message.type === 'list' || message.type === 'buttons',
    );
    expect(menus).toHaveLength(1);
    const list = menus[0];
    expect(list?.type).toBe('list');
    if (list?.type !== 'list') throw new Error('Expected one melody selection list');
    expect(list.rows.length).toBeLessThanOrEqual(10);
    expect(list.rows.map((row) => row.id)).toEqual(
      expect.arrayContaining([A.DISC_DONE, `${A.DISC_REMOVE_PREFIX}0`, A.BACK]),
    );
  });
  it('adds, removes and explicitly finishes exactly the configured number of discs', async () => {
    const f = session({ includedDiscCount: 2 });
    await f.click(A.MENU_ORDER);
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
    await f.input('2');
    await f.input('Алматы');
    await f.click(A.NOTIFICATIONS_SKIP);
    await f.input('Арман');
    await f.input('+77011234567');
    const result = await f.input('Абая 10');
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
    expect((await f.click(A.MENU_ORDER)).customer.conversationState).toBe('ORDER_QUANTITY');
    expect((await f.summary()).order).toMatchObject({
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
    const result = await f.consent();
    expect(result.customer.conversationState).toBe('HUMAN_HANDOFF');
    expect(result.handoff?.reason).toBe('DELIVERY_TARIFF_UNKNOWN');
    expect((await f.click(A.ORDER_CONFIRM)).createPayment).toBeUndefined();
  });
});
