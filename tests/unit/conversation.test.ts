import { describe, expect, it, vi } from 'vitest';
import {
  ConversationService,
  WhatsAppActions as A,
} from '../../src/modules/conversation/conversation.service.js';
import { CatalogService, type Disc } from '../../src/modules/knowledge/catalog.service.js';
import type { AiAnswer, AiInput } from '../../src/modules/ai/ai.types.js';
import type {
  ConversationResult,
  CustomerData,
  InboundMessage,
  Language,
  OrderData,
} from '../../src/types/domain.js';

function customer(language: Language | null = 'ru'): CustomerData {
  return {
    id: 'c1',
    whatsappId: '77011234567',
    preferredLanguage: language,
    conversationState: language ? 'MAIN_MENU' : 'AWAITING_LANGUAGE',
    firstUnhandledMessage: null,
    currentOrderId: null,
    selectedDiscId: null,
    editingField: null,
  };
}
function fixture(language: Language | null = 'ru', replay = true, managerHandoffEnabled = true) {
  const catalog = new CatalogService({ productPrice: 20000 });
  const answer = vi.fn(async (_input: AiInput): Promise<AiAnswer> => ({ text: 'Цена 20 000 ₸.' }));
  const service = new ConversationService({
    catalog,
    ai: { answer },
    productPrice: 20000,
    maxQuantity: 10,
    processFirstMessageAfterLanguage: replay,
    managerHandoffEnabled,
  });
  let result: ConversationResult = { customer: customer(language), order: null, messages: [] };
  let sequence = 0;
  const send = async (message: Partial<InboundMessage>) => {
    result = await service.handle({
      customer: result.customer,
      order: result.order,
      message: { id: `msg-${++sequence}`, from: '77011234567', type: 'text', ...message },
    });
    return result;
  };
  const click = (actionId: string) => send({ type: 'interactive', actionId });
  const text = (value: string) => send({ type: 'text', text: value });
  const complete = async () => {
    await click(A.MENU_ORDER);
    await text('Арман');
    await text('8 701 123 45 67');
    await text('Алматы');
    await text('Абая 10, квартира 12');
    await click(`${A.DISC_PREFIX}${catalog.discs()[0]!.id}`);
    await click(A.DISC_DONE);
    return text('2');
  };
  return { service, catalog, answer, send, click, text, complete, current: () => result };
}

describe('language and safe routing', () => {
  it.each(['ru', 'kk'] as const)(
    'resumes a legacy handoff in %s without consuming the triggering text as a field',
    async (language) => {
      const f = fixture(language, true, false);
      await f.click(A.MENU_ORDER);
      await f.text('Арман');
      Object.assign(f.current().customer, {
        conversationState: 'HUMAN_HANDOFF',
        previousState: 'ORDER_PHONE',
      });
      const before = structuredClone(f.current().order);
      const resumed = await f.text('+77011234567');
      expect(resumed.resumeBot).toBe(true);
      expect(resumed.handoff).toBeUndefined();
      expect(resumed.customer).toMatchObject({
        conversationState: 'ORDER_PHONE',
        previousState: null,
      });
      expect(resumed.order).toEqual(before);
      expect(JSON.stringify(resumed.messages)).toContain(
        language === 'ru' ? 'не подключён' : 'қосылмаған',
      );
      expect(JSON.stringify(resumed.messages)).toContain(
        language === 'ru' ? 'номер телефона' : 'телефон нөмірін',
      );
      expect((await f.text('+77011234567')).customer.conversationState).toBe('ORDER_CITY');
      expect(f.answer).not.toHaveBeenCalled();
    },
  );
  it('honors STOP before recovering a legacy disabled handoff on the next message', async () => {
    const f = fixture('ru', true, false);
    await f.click(A.MENU_ORDER);
    Object.assign(f.current().customer, {
      conversationState: 'HUMAN_HANDOFF',
      previousState: 'ORDER_NAME',
      notificationConsent: true,
    });
    const before = structuredClone(f.current().order);
    const stopped = await f.text('стоп');
    expect(stopped.customer.notificationConsent).toBe(false);
    expect(stopped.customer.optedOutAt).toBeInstanceOf(Date);
    expect(stopped.resumeBot).toBeUndefined();
    expect(stopped.customer.conversationState).toBe('HUMAN_HANDOFF');
    expect(stopped.order).toEqual(before);
    const resumed = await f.text('Арман');
    expect(resumed.resumeBot).toBe(true);
    expect(resumed.customer).toMatchObject({
      conversationState: 'ORDER_NAME',
      notificationConsent: false,
    });
    expect(resumed.order).toEqual(before);
  });
  it.each(['ru', 'kk'] as const)(
    'keeps an editable draft at its current step with manager disabled in %s',
    async (language) => {
      const f = fixture(language, true, false);
      await f.click(A.MENU_ORDER);
      await f.text('Арман');
      const before = structuredClone(f.current());
      const after = await f.click(A.MANAGER);
      expect(after.handoff).toBeUndefined();
      expect(after.customer).toEqual(before.customer);
      expect(after.order).toEqual(before.order);
      expect(JSON.stringify(after.messages)).toContain(
        language === 'ru' ? 'не подключён' : 'қосылмаған',
      );
      expect((await f.text('+77011234567')).customer.conversationState).toBe('ORDER_CITY');
      expect(f.answer).not.toHaveBeenCalled();
    },
  );
  it('keeps disabled AI fallbacks reversible without accepting an AI handoff promise', async () => {
    const f = fixture('ru', true, false);
    for (const answer of [
      { action: 'request_human_handoff' as const, text: 'Менеджер скоро ответит' },
      { text: 'Менеджер свяжется с вами через час.' },
      {},
    ]) {
      f.answer.mockResolvedValueOnce(answer);
      const result = await f.text('Уточните гарантию');
      expect(result.customer.conversationState).toBe('MAIN_MENU');
      expect(result.handoff).toBeUndefined();
      expect(JSON.stringify(result.messages)).not.toContain('скоро ответит');
      expect(JSON.stringify(result.messages)).toContain('не подключён');
    }
    f.answer.mockRejectedValueOnce(new Error('private transport details'));
    const failed = await f.text('Вопрос');
    expect(failed.customer.conversationState).toBe('MAIN_MENU');
    expect(failed.handoff).toBeUndefined();
    expect(JSON.stringify(failed.messages)).not.toContain('private transport');
    expect((await f.click(A.MENU_ORDER)).customer.conversationState).toBe('ORDER_NAME');
  });
  it('does not cancel or unfreeze a pending checkout when manager is disabled', async () => {
    const f = fixture('ru', true, false);
    await f.complete();
    const pending = structuredClone(await f.click(A.ORDER_CONFIRM));
    const result = await f.click(A.ORDER_CANCEL);
    expect(result.handoff).toBeUndefined();
    expect(result.createPayment).toBeUndefined();
    expect(result.order).toEqual(pending.order);
    expect(result.customer).toEqual(pending.customer);
    expect(JSON.stringify(result.messages)).toContain('не подключён');
  });
  it.each(['ru', 'kk'] as const)(
    'keeps the original question and replays it once in %s',
    async (language) => {
      const f = fixture(null);
      const first = await f.text('Сколько стоит?');
      expect(first.customer.firstUnhandledMessage).toBe('Сколько стоит?');
      expect(f.answer).not.toHaveBeenCalled();
      expect(first.messages[0]?.type).toBe('buttons');
      await f.text('алло');
      const selected = await f.click(language === 'ru' ? A.LANG_RU : A.LANG_KK);
      expect(selected.customer.preferredLanguage).toBe(language);
      expect(selected.customer.firstUnhandledMessage).toBeNull();
      expect(f.answer).toHaveBeenCalledWith(
        expect.objectContaining({
          language,
          text: 'Сколько стоит?',
          history: undefined,
        }),
      );
      await f.click(A.LANG_RU);
      expect(f.answer).toHaveBeenCalledTimes(1);
    },
  );
  it('skips a standalone greeting and respects the disabled replay flag', async () => {
    const greeting = fixture(null);
    await greeting.text('Здравствуйте!');
    expect((await greeting.click(A.LANG_RU)).customer.conversationState).toBe('MAIN_MENU');
    expect(greeting.answer).not.toHaveBeenCalled();
    const disabled = fixture(null, false);
    await disabled.text('Сколько стоит?');
    await disabled.click(A.LANG_RU);
    expect(disabled.answer).not.toHaveBeenCalled();
  });
  it('shows truthful demo product information without a fictitious photo', async () => {
    const f = fixture();
    const result = await f.click(A.MENU_PRODUCT);
    expect(result.customer.conversationState).toBe('PRODUCT_VIEW');
    expect(result.messages.some((message) => message.type === 'image')).toBe(false);
    expect(JSON.stringify(result.messages)).toContain('Демонстрационный каталог');
    expect(JSON.stringify(result.messages)).toContain('20 000');
  });
  it('freezes every automated response after human handoff', async () => {
    const f = fixture();
    expect((await f.text('Позовите менеджера')).handoff?.reason).toBe('MANAGER_REQUESTED');
    for (const message of [
      { type: 'text' as const, text: 'Привет' },
      { type: 'interactive' as const, actionId: A.MENU_ORDER },
      { type: 'interactive' as const, actionId: A.LANG_KK },
    ]) {
      const result = await f.send(message);
      expect(result.customer.conversationState).toBe('HUMAN_HANDOFF');
      expect(result.messages).toEqual([]);
      expect(result.order).toBeNull();
    }
    expect(f.answer).not.toHaveBeenCalled();
  });
  it('passes a missing business fact to a human and freezes AI on subsequent input', async () => {
    const f = fixture();
    f.answer.mockResolvedValue({ action: 'request_human_handoff', reason: 'UNKNOWN_INFORMATION' });
    expect((await f.text('Срок гарантии?')).customer.conversationState).toBe('HUMAN_HANDOFF');
    await f.text('А доставка?');
    expect(f.answer).toHaveBeenCalledTimes(1);
  });
  it('falls back to a human if the AI transport throws', async () => {
    const f = fixture();
    f.answer.mockRejectedValue(new Error('network timeout'));
    expect((await f.text('Вопрос')).handoff?.reason).toBe('AI_UNAVAILABLE');
  });
});

describe('deterministic order wizard', () => {
  it.each(['ru', 'kk'] as const)(
    'collects all fields and computes the amount before explicit confirmation (%s)',
    async (language) => {
      const f = fixture(language);
      const result = await f.complete();
      expect(result.customer.conversationState).toBe('ORDER_CONFIRMATION');
      expect(result.order).toMatchObject({
        recipientName: 'Арман',
        recipientPhone: '+77011234567',
        city: 'Алматы',
        quantity: 2,
        unitPrice: 20000,
        totalAmount: 40000,
        orderStatus: 'AWAITING_CONFIRMATION',
        paymentStatus: 'NOT_CREATED',
      });
      expect(result.createPayment).toBeUndefined();
      expect(f.answer).not.toHaveBeenCalled();
      expect(JSON.stringify(result.messages)).toContain(
        language === 'ru' ? 'Проверьте заказ' : 'Тапсырысты тексеріңіз',
      );
      const confirmed = await f.click(A.ORDER_CONFIRM);
      expect(confirmed.createPayment).toBe(true);
      expect(confirmed.order?.paymentStatus).toBe('CREATING');
      expect(confirmed.customer.conversationState).toBe('PAYMENT_PENDING');
      expect((await f.click(A.ORDER_CONFIRM)).createPayment).toBeUndefined();
      expect((await f.text('я оплатил')).order?.paymentStatus).toBe('CREATING');
    },
  );
  it('rejects unsupported media, malformed phone and unbounded quantities without advancing', async () => {
    const f = fixture();
    await f.click(A.MENU_ORDER);
    const media = await f.send({ type: 'unsupported', text: 'image.jpg' });
    expect(media.customer.conversationState).toBe('ORDER_NAME');
    expect(media.order?.recipientName).toBeNull();
    await f.text('Арман');
    expect((await f.text('12345')).customer.conversationState).toBe('ORDER_PHONE');
    await f.text('+77011234567');
    await f.text('Алматы');
    await f.text('Абая 10');
    await f.click(`${A.DISC_PREFIX}${f.catalog.discs()[0]!.id}`);
    await f.click(A.DISC_DONE);
    for (const input of ['0', '-1', '1.5', '11', '1e1', '20000']) {
      expect((await f.text(input)).customer.conversationState).toBe('ORDER_QUANTITY');
    }
    expect((await f.click(A.ORDER_QUANTITY_ONE)).order?.totalAmount).toBe(20000);
  });
  it('does not consume a payment-credentials redaction marker as an order field', async () => {
    const f = fixture();
    await f.click(A.MENU_ORDER);
    const result = await f.text('[PAYMENT_CREDENTIALS_REDACTED]');
    expect(result.customer.conversationState).toBe('ORDER_NAME');
    expect(result.order?.recipientName).toBeNull();
    expect(JSON.stringify(result.messages)).toContain('Не отправляйте реквизиты');
  });
  it('keeps draft fields across menu and language changes', async () => {
    const f = fixture();
    await f.click(A.MENU_ORDER);
    const initial = await f.text('Арман');
    await f.click(A.MENU_BACK);
    await f.click(A.LANG_KK);
    const resumed = await f.click(A.MENU_ORDER);
    expect(resumed.order?.id).toBe(initial.order?.id);
    expect(resumed.order?.recipientName).toBe('Арман');
    expect(resumed.customer.conversationState).toBe('ORDER_PHONE');
    expect(resumed.customer.preferredLanguage).toBe('kk');
  });
  it('edits one selected field and returns to a freshly calculated summary', async () => {
    const f = fixture();
    await f.complete();
    await f.click(A.ORDER_EDIT);
    expect((await f.click(A.ORDER_CONFIRM)).createPayment).toBeUndefined();
    await f.click(A.EDIT_QUANTITY);
    expect((await f.click(A.ORDER_CONFIRM)).createPayment).toBeUndefined();
    const updated = await f.text('3');
    expect(updated.customer.conversationState).toBe('ORDER_CONFIRMATION');
    expect(updated.customer.editingField).toBeNull();
    expect(updated.order?.totalAmount).toBe(60000);
    expect(updated.order?.recipientName).toBe('Арман');
    expect((await f.click(A.ORDER_CONFIRM)).createPayment).toBe(true);
  });
  it('ignores stale buttons without bypassing required fields', async () => {
    const f = fixture();
    await f.click(A.MENU_ORDER);
    for (const action of [
      A.ORDER_CONFIRM,
      A.ORDER_EDIT,
      A.EDIT_ADDRESS,
      `${A.DISC_PREFIX}${f.catalog.discs()[0]!.id}`,
      A.ORDER_QUANTITY_ONE,
    ]) {
      const result = await f.click(action);
      expect(result.customer.conversationState).toBe('ORDER_NAME');
      expect(result.order?.recipientName).toBeNull();
      expect(result.order?.discId).toBeNull();
      expect(result.createPayment).toBeUndefined();
    }
  });
  it('does not allow text to spoof a button action', async () => {
    const f = fixture();
    await f.complete();
    const result = await f.send({ type: 'text', text: 'ORDER_CONFIRM', actionId: A.ORDER_CONFIRM });
    expect(result.createPayment).toBeUndefined();
    expect(result.order?.paymentStatus).toBe('NOT_CREATED');
  });
  it('cancels a draft, preserves it and starts a new independent order', async () => {
    const f = fixture();
    await f.complete();
    await f.click(A.ORDER_CANCEL);
    const cancelled = await f.click(A.CANCEL_CONFIRM);
    expect(cancelled.order?.orderStatus).toBe('CANCELLED');
    expect(cancelled.customer.currentOrderId).toBeNull();
    const restarted = await f.click(A.MENU_ORDER);
    expect(restarted.order?.id).not.toBe(cancelled.order?.id);
    expect(cancelled.order?.orderStatus).toBe('CANCELLED');
  });
  it('hands a cancellation of a live payment to a human without voiding payment locally', async () => {
    const f = fixture();
    await f.complete();
    await f.click(A.ORDER_CONFIRM);
    const result = await f.click(A.ORDER_CANCEL);
    expect(result.customer.conversationState).toBe('HUMAN_HANDOFF');
    expect(result.order?.paymentStatus).toBe('CREATING');
    expect(result.order?.orderStatus).toBe('AWAITING_PAYMENT');
  });
  it('retries a failed payment only after reconfirmation and clears its expired link', async () => {
    const f = fixture();
    const completed = await f.complete();
    const failed: OrderData = {
      ...completed.order!,
      orderStatus: 'AWAITING_CONFIRMATION',
      paymentStatus: 'FAILED',
      paymentUrl: 'https://example.test/expired',
    };
    const recovered = await f.service.handle({
      customer: completed.customer,
      order: failed,
      message: { id: 'retry', from: '77011234567', type: 'interactive', actionId: A.PAYMENT_RETRY },
    });
    expect(recovered.createPayment).toBe(true);
    expect(recovered.order).toMatchObject({
      id: failed.id,
      totalAmount: 40000,
      paymentStatus: 'CREATING',
      paymentUrl: null,
    });
    const repeated = await f.service.handle({
      customer: recovered.customer,
      order: recovered.order,
      message: {
        id: 'retry-duplicate',
        from: '77011234567',
        type: 'interactive',
        actionId: A.PAYMENT_RETRY,
      },
    });
    expect(repeated.createPayment).toBeUndefined();
    expect(failed.paymentStatus).toBe('FAILED');
  });
  it('does not revive a cancelled order through an old confirmation button', async () => {
    const f = fixture();
    await f.complete();
    await f.click(A.ORDER_CANCEL);
    const cancelled = await f.click(A.CANCEL_CONFIRM);
    const confirmed = await f.click(A.ORDER_CONFIRM);
    expect(confirmed.order).toEqual(cancelled.order);
    expect(confirmed.createPayment).toBeUndefined();
    expect(confirmed.customer.currentOrderId).toBeNull();
  });
  it('does not mutate a paid order when replaying old edit/confirm/disc buttons', async () => {
    const f = fixture();
    const completed = await f.complete();
    const paid: OrderData = { ...completed.order!, orderStatus: 'PAID', paymentStatus: 'PAID' };
    for (const actionId of [
      A.ORDER_CONFIRM,
      A.ORDER_EDIT,
      A.EDIT_NAME,
      `${A.DISC_PREFIX}${f.catalog.discs()[0]!.id}`,
    ]) {
      const result = await f.service.handle({
        customer: { ...completed.customer, conversationState: 'PAID' },
        order: paid,
        message: { id: actionId, from: '77011234567', type: 'interactive', actionId },
      });
      expect(result.order).toEqual(paid);
      expect(result.createPayment).toBeUndefined();
    }
    const newOrder = await f.service.handle({
      customer: { ...completed.customer, conversationState: 'PAID' },
      order: paid,
      message: { id: 'new', from: '77011234567', type: 'interactive', actionId: A.MENU_ORDER },
    });
    expect(newOrder.order?.id).not.toBe(paid.id);
    expect(paid.paymentStatus).toBe('PAID');
  });
  it('does not mutate objects owned by the persistence caller', async () => {
    const f = fixture();
    const before = await f.complete();
    const snapshot = structuredClone(before);
    await f.service.handle({
      customer: before.customer,
      order: before.order,
      message: {
        id: 'confirm',
        from: '77011234567',
        type: 'interactive',
        actionId: A.ORDER_CONFIRM,
      },
    });
    expect(before).toEqual(snapshot);
  });
});

describe('catalog buttons and availability', () => {
  it('paginates large catalogs within WhatsApp list limits', async () => {
    const f = fixture();
    const discs: Disc[] = Array.from({ length: 30 }, (_, index) => ({
      id: `disc_${index}`,
      title: `Melody ${index}`,
      artist: null,
      available: true,
      imageUrl: null,
      demo: true,
    }));
    vi.spyOn(f.catalog, 'discs').mockReturnValue(discs);
    const first = await f.click(A.PRODUCT_DISCS);
    const middle = await f.click(`${A.DISC_PAGE_PREFIX}1`);
    const last = await f.click(`${A.DISC_PAGE_PREFIX}3`);
    for (const result of [first, middle, last]) {
      const list = result.messages.find((message) => message.type === 'list');
      expect(list?.type).toBe('list');
      if (list?.type === 'list') expect(list.rows.length).toBeLessThanOrEqual(10);
    }
    expect(JSON.stringify(middle.messages)).toContain(`${A.DISC_PAGE_PREFIX}0`);
    expect(JSON.stringify(middle.messages)).toContain(`${A.DISC_PAGE_PREFIX}2`);
  });
  it('rechecks availability at confirmation and sends the buyer back to disc selection', async () => {
    const f = fixture();
    await f.complete();
    vi.spyOn(f.catalog, 'disc').mockReturnValue(undefined);
    const result = await f.click(A.ORDER_CONFIRM);
    expect(result.customer.conversationState).toBe('HUMAN_HANDOFF');
    expect(result.handoff?.reason).toBe('CHECKOUT_REQUIRES_REVIEW');
    expect(result.createPayment).toBeUndefined();
  });
});
