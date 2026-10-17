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
function fixture(
  language: Language | null = 'ru',
  replay = true,
  managerHandoffEnabled = true,
  productPrice = 20000,
) {
  const catalog = new CatalogService({ productPrice });
  const answer = vi.fn(async (_input: AiInput): Promise<AiAnswer> => ({ text: 'Цена 20 000 ₸.' }));
  const service = new ConversationService({
    catalog,
    ai: { answer },
    productPrice,
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
  const selection = async () => {
    await click(A.MENU_ORDER);
    await click(`${A.DISC_PREFIX}${catalog.discs()[0]!.id}`);
    return click(A.DISC_DONE);
  };
  const nameStep = async () => {
    await selection();
    await text('2');
    await text('Алматы');
    return click(A.NOTIFICATIONS_SKIP);
  };
  const complete = async () => {
    await nameStep();
    await text('Арман');
    await text('8 701 123 45 67');
    return text('Абая 10, квартира 12');
  };
  return {
    service,
    catalog,
    answer,
    send,
    click,
    text,
    selection,
    nameStep,
    complete,
    current: () => result,
  };
}

describe('language and safe routing', () => {
  it.each(['ru', 'kk'] as const)(
    'resumes a legacy handoff in %s without consuming the triggering text as a field',
    async (language) => {
      const f = fixture(language, true, false);
      await f.nameStep();
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
      expect((await f.text('+77011234567')).customer.conversationState).toBe('ORDER_ADDRESS');
      expect(f.answer).not.toHaveBeenCalled();
    },
  );
  it('honors STOP before recovering a legacy disabled handoff on the next message', async () => {
    const f = fixture('ru', true, false);
    await f.nameStep();
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
      await f.nameStep();
      await f.text('Арман');
      const before = structuredClone(f.current());
      const after = await f.click(A.MANAGER);
      expect(after.handoff).toBeUndefined();
      expect(after.customer).toEqual(before.customer);
      expect(after.order).toEqual(before.order);
      expect(JSON.stringify(after.messages)).toContain(
        language === 'ru' ? 'не подключён' : 'қосылмаған',
      );
      expect((await f.text('+77011234567')).customer.conversationState).toBe('ORDER_ADDRESS');
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
    expect((await f.click(A.MENU_ORDER)).customer.conversationState).toBe('ORDER_DISC');
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
  it('uses the configured catalog price consistently through summary and payment confirmation', async () => {
    const f = fixture('ru', true, true, 25000);
    const product = await f.click(A.MENU_PRODUCT);
    expect(JSON.stringify(product.messages)).toContain('25 000');
    const ready = await f.complete();
    expect(ready.order).toMatchObject({
      unitPrice: 25000,
      subtotalAmount: 50000,
      totalAmount: 50000,
    });
    const confirmed = await f.click(A.ORDER_CONFIRM);
    expect(confirmed.createPayment).toBe(true);
    expect(confirmed.order?.totalAmount).toBe(50000);
  });
  it('starts with the catalog selection and asks explicitly for quantity before personal data', async () => {
    const f = fixture();
    await f.click(A.PRODUCT_DISCS);
    const id = f.catalog.discs()[0]!.id;
    await f.click(`${A.DISC_PREFIX}${id}`);
    const started = await f.click(A.PRODUCT_BUY);
    expect(started.customer.conversationState).toBe('ORDER_QUANTITY');
    expect(started.order?.selectedDiscIds).toEqual([id]);
    expect(started.order?.quantity).toBe(1);
    expect(started.order?.recipientName).toBeNull();
    expect((await f.text('2 комплекта')).customer.conversationState).toBe('ORDER_CITY');
    expect((await f.text('Алматы')).customer.conversationState).toBe('ORDER_CONSENT');
    expect((await f.click(A.NOTIFICATIONS_SKIP)).customer.conversationState).toBe('ORDER_NAME');
    expect(f.current().customer.notificationConsent).not.toBe(true);
    expect(f.answer).not.toHaveBeenCalled();
  });
  it.each(['2 комплекта', 'екі жиынтық'])(
    'accepts an unambiguous natural quantity: %s',
    async (quantity) => {
      const f = fixture();
      await f.selection();
      const result = await f.text(quantity);
      expect(result.order?.quantity).toBe(2);
      expect(result.customer.conversationState).toBe('ORDER_CITY');
      expect(f.answer).not.toHaveBeenCalled();
    },
  );
  it('accepts a multiline address and includes every line in the final order', async () => {
    const f = fixture();
    await f.nameStep();
    await f.text('Арман');
    await f.text('+77011234567');
    const address = 'ул. Абая 10\nдом 2, квартира 5';
    const result = await f.text(address);
    expect(result.customer.conversationState).toBe('ORDER_CONFIRMATION');
    expect(result.order?.address).toBe('ул. Абая 10 дом 2, квартира 5');
    expect(result.order?.totalAmount).toBe(40000);
  });
  it.each(['ru', 'kk'] as const)(
    'asks for recipient data without character-count instructions (%s)',
    async (language) => {
      const f = fixture(language);
      const name = await f.nameStep();
      expect(JSON.stringify(name.messages)).not.toMatch(/символ|таңба/iu);
      await f.text('Арман');
      const address = await f.text('+77011234567');
      expect(address.customer.conversationState).toBe('ORDER_ADDRESS');
      expect(JSON.stringify(address.messages)).not.toMatch(/символ|таңба/iu);
    },
  );
  it('does not send recipient-field history to AI when answering an interruption', async () => {
    const f = fixture();
    await f.complete();
    const current = f.current();
    const result = await f.service.handle({
      customer: current.customer,
      order: current.order,
      message: {
        id: 'private-history-question',
        from: '77011234567',
        type: 'text',
        text: 'Как работает шкатулка?',
      },
      history: [
        { role: 'user', content: 'Арман' },
        { role: 'user', content: '+77011234567' },
        { role: 'user', content: 'Абая 10, квартира 12' },
      ],
    });
    expect(result.customer.conversationState).toBe('ORDER_CONFIRMATION');
    const input = f.answer.mock.calls.at(-1)?.[0];
    expect(input).toBeDefined();
    expect(JSON.stringify(input)).not.toContain('Арман');
    expect(JSON.stringify(input)).not.toContain('+77011234567');
    expect(JSON.stringify(input)).not.toContain('Абая 10');
  });
  it('does not treat the recipient name as personal data when it is only a substring of an ordinary word', async () => {
    const f = fixture();
    await f.nameStep();
    await f.text('Анна');
    await f.text('+77011234567');
    await f.text('Абая 10');
    const before = structuredClone(f.current().order);
    const question = 'Данная модель работает без батареек?';
    const result = await f.text(question);
    expect(f.answer).toHaveBeenCalledOnce();
    expect(f.answer.mock.calls[0]?.[0].text).toBe(question);
    expect(result.customer.conversationState).toBe('ORDER_CONFIRMATION');
    expect(result.order).toEqual(before);
    expect(result.createPayment).toBeUndefined();
  });
  it.each(['ru', 'kk'] as const)(
    'answers questions at every shopping and recipient step without storing them as fields (%s)',
    async (language) => {
      const f = fixture(language);
      f.answer.mockResolvedValue({
        text: language === 'ru' ? 'Можно выбрать подарок.' : 'Сыйлық таңдауға болады.',
      });
      const question =
        language === 'ru' ? 'А как работает шкатулка?' : 'Қобдиша қалай жұмыс істейді?';
      const check = async () => {
        const before = structuredClone(f.current());
        const result = await f.text(question);
        expect(result.customer.conversationState).toBe(before.customer.conversationState);
        expect(result.order).toEqual(before.order);
        expect(result.createPayment).toBeUndefined();
        expect(JSON.stringify(result.messages)).toContain(
          language === 'ru' ? 'Можно выбрать подарок.' : 'Сыйлық таңдауға болады.',
        );
      };
      await f.click(A.MENU_ORDER);
      await check();
      await f.click(`${A.DISC_PREFIX}${f.catalog.discs()[0]!.id}`);
      await f.click(A.DISC_DONE);
      await check();
      await f.text('2');
      await check();
      await f.text('Алматы');
      await check();
      await f.click(A.NOTIFICATIONS_SKIP);
      await check();
      await f.text('Арман');
      await check();
      await f.text('+77011234567');
      await check();
      await f.text('Абая 10');
      await check();
      expect(f.answer).toHaveBeenCalledTimes(8);
      expect(JSON.stringify(f.answer.mock.calls)).not.toContain('+77011234567');
      expect(JSON.stringify(f.answer.mock.calls)).not.toContain('Абая 10');
    },
  );
  it.each(['да, всё верно', 'бәрі дұрыс'])(
    'confirms the current complete order with natural text and creates no duplicate payment: %s',
    async (confirmation) => {
      const f = fixture();
      await f.complete();
      expect((await f.text(confirmation)).createPayment).toBe(true);
      expect(f.current().order?.paymentStatus).toBe('CREATING');
      expect((await f.text(confirmation)).createPayment).toBeUndefined();
      expect(f.current().order?.paymentStatus).toBe('CREATING');
    },
  );
  it('does not interpret a conditional yes as approval to create a payment', async () => {
    const f = fixture();
    await f.complete();
    const result = await f.text('Да, но можно изменить адрес?');
    expect(result.createPayment).toBeUndefined();
    expect(result.order?.paymentStatus).toBe('NOT_CREATED');
    expect(result.customer.conversationState).toBe('ORDER_CONFIRMATION');
  });
  it('answers a general payment question while preserving the frozen checkout', async () => {
    const f = fixture();
    await f.complete();
    const pending = structuredClone(await f.click(A.ORDER_CONFIRM));
    f.answer.mockResolvedValue({ text: 'Оплатить можно на защищённой странице.' });
    const result = await f.text('Как оплатить заказ?');
    expect(result.customer.conversationState).toBe('PAYMENT_PENDING');
    expect(result.order).toEqual(pending.order);
    expect(result.createPayment).toBeUndefined();
    expect(JSON.stringify(result.messages)).toContain('защищённой странице');
  });
  it.each([
    ['ru', 'Статус оплаты'],
    ['kk', 'Төлем мәртебесі'],
  ] as const)(
    'returns the existing payment status without asking AI (%s)',
    async (language, question) => {
      const f = fixture(language);
      await f.complete();
      const before = structuredClone(await f.click(A.ORDER_CONFIRM));
      const result = await f.text(question);
      expect(result.customer.conversationState).toBe('PAYMENT_PENDING');
      expect(result.order).toEqual(before.order);
      expect(result.createPayment).toBeUndefined();
      expect(f.answer).not.toHaveBeenCalled();
      expect(JSON.stringify(result.messages)).toContain(
        language === 'ru' ? 'Оплата пока не подтверждена' : 'Төлем жүйесі төлемді әлі растаған жоқ',
      );
    },
  );
  it('routes a broken payment link to a manager without changing the payment', async () => {
    const f = fixture();
    await f.complete();
    const pending = structuredClone(await f.click(A.ORDER_CONFIRM));
    const result = await f.text('Ссылка не открывается');
    expect(result.customer.conversationState).toBe('HUMAN_HANDOFF');
    expect(result.handoff).toBeDefined();
    expect(result.order).toEqual(pending.order);
    expect(result.createPayment).toBeUndefined();
  });
  it('keeps a question reversible when the answer needs an unavailable manager', async () => {
    const f = fixture('ru', true, false);
    await f.nameStep();
    const before = structuredClone(f.current());
    f.answer.mockResolvedValue({ action: 'request_human_handoff', reason: 'UNKNOWN_INFORMATION' });
    const result = await f.text('А гарантия сколько действует?');
    expect(result.order).toEqual(before.order);
    expect(result.customer.conversationState).toBe('ORDER_NAME');
    expect(result.handoff).toBeUndefined();
    expect(JSON.stringify(result.messages)).toContain('не подключён');
    expect((await f.text('Арман')).customer.conversationState).toBe('ORDER_PHONE');
  });
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
    await f.selection();
    for (const input of ['0', '-1', '1.5', '11', '1e1', '20000']) {
      expect((await f.text(input)).customer.conversationState).toBe('ORDER_QUANTITY');
    }
    expect((await f.click(A.ORDER_QUANTITY_ONE)).order?.totalAmount).toBe(20000);
    await f.text('Алматы');
    await f.click(A.NOTIFICATIONS_SKIP);
    const media = await f.send({ type: 'unsupported', text: 'image.jpg' });
    expect(media.customer.conversationState).toBe('ORDER_NAME');
    expect(media.order?.recipientName).toBeNull();
    await f.text('Арман');
    expect((await f.text('12345')).customer.conversationState).toBe('ORDER_PHONE');
    await f.text('+77011234567');
    expect((await f.text('Абая 10')).customer.conversationState).toBe('ORDER_CONFIRMATION');
  });
  it('does not consume a payment-credentials redaction marker as an order field', async () => {
    const f = fixture();
    await f.nameStep();
    const result = await f.text('[PAYMENT_CREDENTIALS_REDACTED]');
    expect(result.customer.conversationState).toBe('ORDER_NAME');
    expect(result.order?.recipientName).toBeNull();
    expect(JSON.stringify(result.messages)).toContain('Не отправляйте реквизиты');
  });
  it('keeps draft fields across menu and language changes', async () => {
    const f = fixture();
    await f.nameStep();
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
  it('resumes the selected edit after answering a question without advancing the order', async () => {
    const f = fixture();
    await f.complete();
    await f.click(A.ORDER_EDIT);
    await f.click(A.EDIT_NAME);
    const before = structuredClone(f.current().order);
    const answer = await f.text('Сколько стоит доставка?');
    expect(answer.customer.conversationState).toBe('ORDER_NAME');
    expect(answer.customer.editingField).toBe(A.EDIT_NAME);
    expect(answer.order).toEqual(before);
    expect(answer.createPayment).toBeUndefined();
    const changed = await f.text('Алия');
    expect(changed.customer.conversationState).toBe('ORDER_CONFIRMATION');
    expect(changed.customer.editingField).toBeNull();
    expect(changed.order?.recipientName).toBe('Алия');
    expect(changed.order?.quantity).toBe(before?.quantity);
    expect(changed.order?.totalAmount).toBe(before?.totalAmount);
  });
  it('ignores stale buttons without bypassing required fields', async () => {
    const f = fixture();
    await f.nameStep();
    const before = structuredClone(f.current().order);
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
      expect(result.order).toEqual(before);
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
  it('sends a frozen failed payment for review after a price change without rewriting the agreed order', async () => {
    const f = fixture();
    await f.complete();
    const pending = await f.click(A.ORDER_CONFIRM);
    const failed: OrderData = {
      ...structuredClone(pending.order!),
      paymentStatus: 'FAILED',
      orderStatus: 'AWAITING_CONFIRMATION',
      paymentUrl: 'https://example.test/failed-payment',
    };
    const before = structuredClone(failed);
    const updatedService = new ConversationService({
      catalog: new CatalogService({ productPrice: 25000 }),
      ai: { answer: f.answer },
      productPrice: 25000,
      maxQuantity: 10,
      processFirstMessageAfterLanguage: true,
      managerHandoffEnabled: true,
    });
    const result = await updatedService.handle({
      customer: { ...pending.customer, conversationState: 'ORDER_CONFIRMATION' },
      order: failed,
      message: {
        id: 'retry-after-price-change',
        from: '77011234567',
        type: 'interactive',
        actionId: A.PAYMENT_RETRY,
      },
    });
    expect(result.customer.conversationState).toBe('HUMAN_HANDOFF');
    expect(result.handoff?.reason).toBe('CHECKOUT_REQUIRES_REVIEW');
    expect(result.createPayment).toBeUndefined();
    expect(result.order).toEqual(before);
    expect(result.order?.unitPrice).toBe(20000);
    expect(result.order?.totalAmount).toBe(40000);
    expect(result.order?.packageSnapshot).toEqual(before.packageSnapshot);
    expect(result.order?.deliverySnapshot).toEqual(before.deliverySnapshot);
    expect(failed).toEqual(before);
    expect(f.answer).not.toHaveBeenCalled();
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
