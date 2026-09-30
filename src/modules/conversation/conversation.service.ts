import { randomUUID } from 'node:crypto';
import type {
  CustomerData,
  ConversationResult,
  ConversationState,
  InboundMessage,
  Language,
  OrderData,
  OutboundMessage,
} from '../../types/domain.js';
import { loadBusinessData, type BusinessDataConfig } from '../../config/business.config.js';
import {
  prepareCheckout,
  assertCheckoutReady,
  selectedDiscs,
  packageIssues,
} from '../orders/checkout.js';
import { normalizePhone } from '../../utils/phone.js';
import type { AiService } from '../ai/ai.service.js';
import type { CatalogService } from '../knowledge/catalog.service.js';
import { calculateTotal, validText, validateOrder } from '../orders/order.validator.js';
import { WhatsAppActions as A } from './actions.js';
import { firstMissingField, isEditableOrder, orderInputStates } from './state-machine.js';

export { WhatsAppActions } from './actions.js';

interface Options {
  catalog: Pick<CatalogService, 'product' | 'discs' | 'disc' | 'faq'>;
  ai: AiService;
  productPrice: number;
  maxQuantity: number;
  processFirstMessageAfterLanguage: boolean;
  business?: BusinessDataConfig;
  integrationMode?: 'demo' | 'staging' | 'live';
  managerHandoffEnabled?: boolean;
}
interface Input {
  customer: CustomerData;
  order: OrderData | null;
  message: InboundMessage;
  history?: { role: 'user' | 'assistant'; content: string }[];
}

const choose = (language: Language, ru: string, kk: string) => (language === 'kk' ? kk : ru);
const lang = (result: ConversationResult): Language => result.customer.preferredLanguage ?? 'ru';
const say = (result: ConversationResult, ru: string, kk: string) =>
  result.messages.push({ type: 'text', text: choose(lang(result), ru, kk) });
const money = (amount: number) =>
  new Intl.NumberFormat('ru-RU').format(amount).replace(/\u00a0/g, ' ');
const editStates: Record<string, ConversationState> = {
  [A.EDIT_NAME]: 'ORDER_NAME',
  [A.EDIT_PHONE]: 'ORDER_PHONE',
  [A.EDIT_CITY]: 'ORDER_CITY',
  [A.EDIT_ADDRESS]: 'ORDER_ADDRESS',
  [A.EDIT_DISC]: 'ORDER_DISC',
  [A.EDIT_QUANTITY]: 'ORDER_QUANTITY',
};

/** Returns a transition only. The caller atomically persists it and queues outbound work. */
export class ConversationService {
  private readonly business: BusinessDataConfig;
  constructor(private readonly options: Options) {
    this.business = structuredClone(options.business ?? loadBusinessData({ tolerant: true }));
    calculateTotal(1, options.productPrice, options.maxQuantity);
    if (!Number.isSafeInteger(options.maxQuantity) || options.maxQuantity < 1)
      throw new Error('Invalid max quantity');
  }

  async handle(input: Input): Promise<ConversationResult> {
    const result = await this.transition(input);
    if (result.order && result.order.id === input.order?.id) {
      const fields = [
        'recipientName',
        'recipientPhone',
        'city',
        'address',
        'productId',
        'selectedDiscIds',
        'quantity',
        'unitPrice',
        'subtotalAmount',
        'deliveryAmount',
        'deliveryMode',
        'totalAmount',
        'currency',
        'packageSnapshot',
        'deliverySnapshot',
        'configVersion',
      ] as const;
      const changed = fields.some(
        (field) => JSON.stringify(result.order![field]) !== JSON.stringify(input.order![field]),
      );
      if (changed && input.order.checkoutFrozenAt) throw new Error('CHECKOUT_FROZEN');
      if (changed) {
        result.order.contentVersion = (input.order.contentVersion ?? 1) + 1;
        result.order.version = (input.order.version ?? 1) + 1;
      }
    }
    return result;
  }

  private async transition(input: Input): Promise<ConversationResult> {
    const result: ConversationResult = {
      customer: structuredClone(input.customer),
      order: input.order ? structuredClone(input.order) : null,
      messages: [],
    };
    const { customer } = result;
    const text = input.message.text?.trim() ?? '';
    const action =
      input.message.type === 'interactive' || input.message.type === 'button'
        ? input.message.actionId
        : undefined;

    const menuRequested =
      action === A.MENU || action === A.MENU_BACK || /^(меню|menu|мәзір|басты мәзір)$/iu.test(text);
    const resumeRequested =
      action === A.RESUME_BOT || /^(вернуться к боту|ботқа оралу)$/iu.test(text);
    if (action === A.STOP_NOTIFICATIONS || /^(стоп|stop|тоқтату)$/iu.test(text)) {
      customer.notificationConsent = false;
      customer.optedOutAt = new Date();
      say(
        result,
        'Последующие инициативные уведомления отключены. Заказ и оплата сохранены. На ваши сообщения отвечу.',
        'Кейінгі бастамашыл хабарламалар өшірілді. Тапсырыс пен төлем сақталды. Хабарламаларыңызға жауап беремін.',
      );
      return result;
    }
    if (customer.conversationState === 'HUMAN_HANDOFF') {
      if (this.options.managerHandoffEnabled === false) {
        result.resumeBot = true;
        this.handoff(result, 'MANAGER_DISABLED');
        this.restore(result);
      } else if (resumeRequested) {
        result.resumeBot = true;
        this.restore(result);
      } else if (menuRequested) {
        result.messages.push({
          type: 'buttons',
          text: choose(
            lang(result),
            'Обращение у менеджера. Можно явно вернуться к боту.',
            'Өтініш менеджерде. Ботқа қайта оралуға болады.',
          ),
          buttons: [
            { id: A.RESUME_BOT, title: choose(lang(result), 'Вернуться к боту', 'Ботқа оралу') },
          ],
        });
      }
      return result;
    }
    if (resumeRequested) {
      this.restore(result);
      return result;
    }
    if (action === A.NOTIFICATIONS_OPT_IN) {
      if (!customer.preferredLanguage || !customer.privacyNoticeAt) return this.staleAction(result);
      Object.assign(customer, {
        notificationConsent: true,
        notificationConsentAt: new Date(),
        notificationConsentVersion: this.business.notificationConsentVersion,
        notificationConsentSource: 'WHATSAPP_EXPLICIT_BUTTON',
        notificationConsentScope: 'ORDER_TRANSACTIONAL',
        optedOutAt: null,
      });
      say(
        result,
        'Разрешены последующие сообщения по заказу. Реклама не включена. Отказ: «стоп».',
        'Тапсырыс бойынша кейінгі хабарламаларға рұқсат берілді. Жарнама кірмейді. Бас тарту: «тоқтату».',
      );
      this.currentPrompt(result);
      return result;
    }
    if (action === A.PRIVACY || /^(конфиденциальность|политика|құпиялық)$/iu.test(text)) {
      this.privacyNotice(result);
      return result;
    }
    if (text === '[PAYMENT_CREDENTIALS_REDACTED]') {
      say(
        result,
        'Не отправляйте реквизиты карты, пароли и коды подтверждения.',
        'Карта деректерін, құпиясөздерді және растау кодтарын жібермеңіз.',
      );
      if (!customer.preferredLanguage) this.languageButtons(result);
      else this.currentPrompt(result);
      return result;
    }

    const selectedLanguage =
      action === A.LANG_RU ? 'ru' : action === A.LANG_KK ? 'kk' : this.languageCommand(text);
    if (!customer.preferredLanguage) {
      if (selectedLanguage) {
        const original = customer.firstUnhandledMessage;
        customer.preferredLanguage = selectedLanguage;
        customer.firstUnhandledMessage = null;
        customer.conversationState = 'MAIN_MENU';
        this.menu(result);
        if (
          this.options.processFirstMessageAfterLanguage &&
          original &&
          !this.isGreeting(original)
        ) {
          await this.answer(result, original, input.history);
        }
      } else {
        customer.conversationState = 'AWAITING_LANGUAGE';
        if (!customer.firstUnhandledMessage && input.message.type === 'text' && text)
          customer.firstUnhandledMessage = text;
        this.languageButtons(result);
      }
      return result;
    }

    // Media never becomes a name, address, or other order field.
    if (input.message.type === 'unsupported') {
      say(
        result,
        'Пока могу обработать текст и кнопки. Напишите сообщение текстом.',
        'Әзірге мәтін мен батырмаларды өңдей аламын. Хабарламаңызды мәтінмен жазыңыз.',
      );
      return result;
    }
    if (selectedLanguage) {
      customer.preferredLanguage = selectedLanguage;
      say(result, 'Язык изменён: русский.', 'Тіл өзгертілді: қазақша.');
      this.currentPrompt(result);
      return result;
    }
    if (
      action === A.LANGUAGE_SELECT ||
      action === A.CHANGE_LANGUAGE ||
      /^(язык|сменить язык|тіл|тілді өзгерту)$/iu.test(text)
    ) {
      this.languageButtons(result);
      return result;
    }
    if (
      action === A.HUMAN_HANDOFF ||
      action === A.MANAGER ||
      /менеджер|оператор|адаммен сөйлес|кеңесші/iu.test(text)
    ) {
      return this.handoff(result, 'MANAGER_REQUESTED');
    }
    if (/(верни(?:те)? деньги|хочу вернуть|ақшамды қайтар)/iu.test(text))
      return this.handoff(result, 'REFUND_REQUEST');

    if (action === A.BACK || /^(назад|артқа)$/iu.test(text)) {
      this.back(result);
      return result;
    }
    if (menuRequested) {
      customer.previousState = customer.conversationState;
      customer.conversationState = 'MAIN_MENU';
      customer.editingField = null;
      this.menu(result);
      return result;
    }
    if (
      action === A.MENU_ORDER ||
      action === A.PRODUCT_BUY ||
      /^(заказать|оформить заказ|тапсырыс беру)$/iu.test(text)
    ) {
      return this.startOrder(result);
    }
    if (action === A.MENU_PRODUCT) {
      this.product(result);
      return result;
    }
    if (action === A.MENU_QUESTION) {
      customer.conversationState = 'AI_QA';
      say(result, 'Напишите ваш вопрос.', 'Сұрағыңызды жазыңыз.');
      return result;
    }
    if (action === A.PRODUCT_DISCS) {
      customer.conversationState = 'DISC_LIST';
      this.discs(result, 0);
      return result;
    }

    if (action === A.CANCEL_KEEP) {
      if (customer.conversationState !== 'CANCEL_CONFIRMATION') return this.staleAction(result);
      this.restore(result);
      return result;
    }
    if (action === A.CANCEL_CONFIRM) {
      if (customer.conversationState !== 'CANCEL_CONFIRMATION' || !result.order)
        return this.staleAction(result);
      if (!['NOT_CREATED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(result.order.paymentStatus))
        return this.handoff(result, 'CANCELLATION_REQUEST');
      result.order.orderStatus = 'CANCELLED';
      result.order.paymentStatus = 'CANCELLED';
      customer.currentOrderId = null;
      customer.editingField = null;
      customer.previousState = null;
      customer.conversationState = 'MAIN_MENU';
      say(
        result,
        'Заказ отменён в приложении. Это не отменяет платёж у провайдера и не выполняет возврат.',
        'Тапсырыс қосымшада тоқтатылды. Бұл провайдердегі төлемді тоқтатпайды және ақша қайтармайды.',
      );
      this.menu(result);
      return result;
    }
    if (
      action === A.ORDER_CANCEL ||
      action === A.CANCEL_ORDER ||
      /^(отменить|отменить заказ|тапсырысты тоқтату)$/iu.test(text)
    ) {
      if (!result.order || ['CANCELLED', 'REFUNDED'].includes(result.order.orderStatus)) {
        this.menu(result);
        return result;
      }
      if (!['NOT_CREATED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(result.order.paymentStatus))
        return this.handoff(result, 'CANCELLATION_REQUEST');
      customer.previousState = customer.conversationState;
      customer.conversationState = 'CANCEL_CONFIRMATION';
      this.cancelPrompt(result);
      return result;
    }

    if (action === A.ORDER_EDIT) {
      if (result.order?.checkoutFrozenAt) return this.handoff(result, 'FROZEN_ORDER_CHANGE');
      if (customer.conversationState !== 'ORDER_CONFIRMATION' || !isEditableOrder(result.order))
        return this.staleAction(result);
      customer.editingField = 'select';
      this.editMenu(result);
      return result;
    }
    if (action && editStates[action]) {
      if (action === A.EDIT_DISC && this.business.packageMode === 'FIXED_SET')
        return this.staleAction(result);
      if (
        customer.editingField !== 'select' ||
        customer.conversationState !== 'ORDER_CONFIRMATION' ||
        !isEditableOrder(result.order)
      )
        return this.staleAction(result);
      customer.editingField = action;
      customer.conversationState = editStates[action]!;
      this.currentPrompt(result);
      return result;
    }

    if (action === A.ORDER_CONFIRM || action === A.PAYMENT_RETRY) {
      if (
        result.order &&
        ['PENDING', 'CREATING', 'CREATION_UNKNOWN', 'REVIEW_REQUIRED'].includes(
          result.order.paymentStatus,
        )
      ) {
        this.pending(result);
        return result;
      }
      if (
        customer.conversationState !== 'ORDER_CONFIRMATION' ||
        customer.editingField ||
        !result.order ||
        !['NOT_CREATED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(result.order.paymentStatus) ||
        result.order.orderStatus !== 'AWAITING_CONFIRMATION'
      )
        return this.staleAction(result);
      const order: OrderData = result.order;
      if (!validateOrder(order, this.options.maxQuantity, 20000).valid)
        return this.staleAction(result);
      try {
        assertCheckoutReady(order, {
          business: this.business,
          catalog: this.options.catalog,
          mode: this.options.integrationMode === 'live' ? 'live' : 'demo',
        });
      } catch {
        return this.handoff(result, 'CHECKOUT_REQUIRES_REVIEW');
      }
      order.checkoutFrozenAt ??= new Date();
      order.orderStatus = 'AWAITING_PAYMENT';
      order.paymentStatus = 'CREATING';
      order.paymentUrl = null;
      customer.conversationState = 'PAYMENT_PENDING';
      result.createPayment = true;
      say(
        result,
        `Готовлю ссылку на оплату заказа ${order.publicOrderId}. Сумма: ${money(order.totalAmount)} ₸.`,
        `${order.publicOrderId} тапсырысы үшін төлем сілтемесін дайындап жатырмын. Сома: ${money(order.totalAmount)} ₸.`,
      );
      return result;
    }

    if (action === A.DISC_DONE) {
      if (customer.conversationState !== 'ORDER_DISC' || !isEditableOrder(result.order))
        return this.staleAction(result);
      if (packageIssues(selectedDiscs(result.order), this.business, this.options.catalog).length) {
        say(
          result,
          `Нужно выбрать ровно ${this.business.includedDiscCount} доступных дисков.`,
          `Дәл ${this.business.includedDiscCount} қолжетімді диск таңдау қажет.`,
        );
        this.discs(result, 0);
        return result;
      }
      this.advance(result, 'ORDER_QUANTITY');
      return result;
    }
    if (action?.startsWith(A.DISC_REMOVE_PREFIX)) {
      if (customer.conversationState !== 'ORDER_DISC' || !isEditableOrder(result.order))
        return this.staleAction(result);
      const index = Number(action.slice(A.DISC_REMOVE_PREFIX.length));
      const ids = [...selectedDiscs(result.order)];
      if (!Number.isInteger(index) || index < 0 || index >= ids.length)
        return this.staleAction(result);
      ids.splice(index, 1);
      result.order.selectedDiscIds = ids;
      result.order.discId = ids[0] ?? null;
      this.discs(result, 0);
      return result;
    }
    if (action?.startsWith(A.DISC_PAGE_PREFIX)) {
      if (!['DISC_LIST', 'ORDER_DISC'].includes(customer.conversationState))
        return this.staleAction(result);
      const page = Number(action.slice(A.DISC_PAGE_PREFIX.length));
      this.discs(result, Number.isSafeInteger(page) && page >= 0 ? page : 0);
      return result;
    }
    if (action?.startsWith(A.DISC_PREFIX)) {
      const disc = this.options.catalog.disc(action.slice(A.DISC_PREFIX.length));
      if (!['DISC_LIST', 'ORDER_DISC'].includes(customer.conversationState))
        return this.staleAction(result);
      if (!disc?.available) {
        say(
          result,
          'Эта мелодия недоступна. Выберите другую из списка.',
          'Бұл әуен қолжетімсіз. Тізімнен басқасын таңдаңыз.',
        );
        this.discs(result, 0);
        return result;
      }
      customer.selectedDiscId = disc.id;
      if (customer.conversationState === 'ORDER_DISC') {
        if (!isEditableOrder(result.order)) return this.staleAction(result);
        const ids = [...selectedDiscs(result.order)];
        if (
          ids.length >= this.business.includedDiscCount ||
          (!this.business.allowRepeatedDiscs && ids.includes(disc.id))
        ) {
          say(
            result,
            'Этот диск уже выбран либо комплект заполнен. Удалите позицию для замены.',
            'Бұл диск таңдалған немесе жиынтық толы. Ауыстыру үшін бір позицияны жойыңыз.',
          );
        } else {
          ids.push(disc.id);
          result.order.selectedDiscIds = ids;
          result.order.discId = ids[0] ?? null;
        }
        this.discs(result, 0);
      } else {
        result.messages.push({
          type: 'buttons',
          text: choose(
            lang(result),
            `Выбрана мелодия: ${disc.title}`,
            `Таңдалған әуен: ${disc.title}`,
          ),
          buttons: [
            { id: A.PRODUCT_BUY, title: choose(lang(result), '🛒 Заказать', '🛒 Тапсырыс') },
            { id: A.MENU_BACK, title: choose(lang(result), '⬅️ Назад', '⬅️ Артқа') },
          ],
        });
      }
      return result;
    }

    if (action === A.ORDER_QUANTITY_ONE && customer.conversationState === 'ORDER_QUANTITY')
      return this.orderInput(result, '1');
    if (action) return this.staleAction(result);
    if (customer.conversationState === 'CANCEL_CONFIRMATION') {
      this.cancelPrompt(result);
      return result;
    }
    if (!text) {
      say(
        result,
        'Напишите сообщение текстом или выберите кнопку.',
        'Мәтін жазыңыз немесе батырманы таңдаңыз.',
      );
      return result;
    }
    if (result.order?.paymentStatus === 'PENDING' && /оплат|плат[её]ж|төле|төлем/iu.test(text)) {
      this.pending(result);
      return result;
    }
    if (orderInputStates.has(customer.conversationState)) return this.orderInput(result, text);
    if (customer.conversationState === 'ORDER_CONFIRMATION') {
      if (customer.editingField === 'select') this.editMenu(result);
      else this.summary(result);
      return result;
    }
    if (customer.conversationState === 'PAYMENT_PENDING') {
      this.pending(result);
      return result;
    }
    if (result.order?.paymentStatus === 'PAID' && /оплат|плат[её]ж|төле|төлем/iu.test(text)) {
      say(
        result,
        `Заказ ${result.order.publicOrderId} оплачен.${this.options.managerHandoffEnabled === false ? '' : ' По вопросам заказа поможет менеджер.'}`,
        `${result.order.publicOrderId} тапсырысы төленді.${this.options.managerHandoffEnabled === false ? '' : ' Тапсырыс бойынша менеджер көмектеседі.'}`,
      );
      return result;
    }
    await this.answer(result, text, input.history);
    return result;
  }

  private privacyNotice(result: ConversationResult): void {
    const policy = this.business.privacyPolicyUrl;
    const contact = this.business.businessContact;
    result.messages.push({
      type: 'text',
      text: `${this.business.privacyNotice[lang(result)]}${policy ? `\n${policy}` : ''}${contact ? `\n${contact}` : ''}`,
    });
    result.customer.privacyNoticeVersion = this.business.privacyNoticeVersion;
    result.customer.privacyNoticeAt = new Date();
    result.messages.push({
      type: 'buttons',
      text: this.business.notificationConsentText[lang(result)],
      buttons: [
        { id: A.NOTIFICATIONS_OPT_IN, title: choose(lang(result), 'Разрешить', 'Рұқсат беру') },
      ],
    });
  }

  private cancelPrompt(result: ConversationResult): void {
    result.messages.push({
      type: 'buttons',
      text: choose(
        lang(result),
        'Подтвердить отмену заказа? Отмена здесь не аннулирует платёж у провайдера.',
        'Тапсырысты тоқтатуды растайсыз ба? Бұл провайдердегі төлемді жоймайды.',
      ),
      buttons: [
        { id: A.CANCEL_CONFIRM, title: choose(lang(result), 'Да, отменить', 'Иә, тоқтату') },
        { id: A.CANCEL_KEEP, title: choose(lang(result), 'Сохранить заказ', 'Тапсырысты сақтау') },
      ],
    });
  }

  private restore(result: ConversationResult): void {
    const order = result.order;
    if (
      order &&
      ['PENDING', 'CREATING', 'CREATION_UNKNOWN', 'REVIEW_REQUIRED'].includes(order.paymentStatus)
    )
      result.customer.conversationState = 'PAYMENT_PENDING';
    else if (order?.paymentStatus === 'PAID') result.customer.conversationState = 'PAID';
    else if (order && !['CANCELLED', 'REFUNDED', 'REFUND_PENDING'].includes(order.orderStatus)) {
      const prior = result.customer.previousState;
      result.customer.conversationState = order.checkoutFrozenAt
        ? 'ORDER_CONFIRMATION'
        : prior && orderInputStates.has(prior)
          ? prior
          : (firstMissingField(order, this.options.maxQuantity) ?? 'ORDER_CONFIRMATION');
    } else
      result.customer.conversationState = result.customer.preferredLanguage
        ? 'MAIN_MENU'
        : 'AWAITING_LANGUAGE';
    result.customer.previousState = null;
    this.currentPrompt(result);
  }

  private back(result: ConversationResult): void {
    if (result.customer.conversationState === 'CANCEL_CONFIRMATION') {
      this.restore(result);
      return;
    }
    if (!isEditableOrder(result.order)) {
      this.currentPrompt(result);
      return;
    }
    const steps: ConversationState[] = [
      'ORDER_NAME',
      'ORDER_PHONE',
      'ORDER_CITY',
      'ORDER_ADDRESS',
      ...(this.business.packageMode === 'SELECTABLE_DISCS' ? ['ORDER_DISC' as const] : []),
      'ORDER_QUANTITY',
      'ORDER_CONFIRMATION',
    ];
    const index = steps.indexOf(result.customer.conversationState);
    if (index < 1) {
      result.customer.conversationState = 'MAIN_MENU';
      this.menu(result);
      return;
    }
    result.customer.editingField = null;
    result.customer.conversationState = steps[index - 1]!;
    this.currentPrompt(result);
  }

  private languageCommand(text: string): Language | null {
    if (/^(русский|по-русски|на русском|давай на русском|орысша|орыс тілінде)[.!]?$/iu.test(text))
      return 'ru';
    if (/^(қазақша|қазақ тілінде|казахский|на казахском|давай на казахском)[.!]?$/iu.test(text))
      return 'kk';
    return null;
  }

  private isGreeting(text: string): boolean {
    return /^(здравствуй(?:те)?|привет|добрый (?:день|вечер)|доброе утро|сәлем(?:етсіз бе)?|салем|қайырлы (?:күн|кеш|таң)|hello|hi)[\s!.👋]*$/iu.test(
      text.trim(),
    );
  }

  private languageButtons(result: ConversationResult): void {
    result.messages.push({
      type: 'buttons',
      text: 'Қай тілде сөйлескіңіз келеді?\nНа каком языке вам удобно общаться?',
      buttons: [
        { id: A.LANG_KK, title: '🇰🇿 Қазақша' },
        { id: A.LANG_RU, title: '🇷🇺 Русский' },
      ],
    });
  }

  private menu(result: ConversationResult): void {
    result.messages.push({
      type: 'buttons',
      text: choose(
        lang(result),
        'Чем могу помочь?\nДля смены языка напишите «язык».',
        'Қалай көмектесе аламын?\nТілді өзгерту үшін «тіл» деп жазыңыз.',
      ),
      buttons: [
        { id: A.MENU_ORDER, title: choose(lang(result), '🛒 Заказать', '🛒 Тапсырыс') },
        { id: A.MENU_PRODUCT, title: choose(lang(result), '🎵 Товар', '🎵 Өнім') },
        { id: A.MENU_QUESTION, title: choose(lang(result), '💬 Вопрос', '💬 Сұрақ') },
      ],
    });
  }

  private product(result: ConversationResult): void {
    const product = this.options.catalog.product(lang(result));
    result.customer.conversationState = 'PRODUCT_VIEW';
    for (const url of product.images.slice(0, 3))
      result.messages.push({ type: 'image', url, caption: product.name });
    const description =
      product.description ??
      choose(
        lang(result),
        'Точное описание пока не заполнено.',
        'Нақты сипаттама әзірге толтырылмаған.',
      );
    const parts = [`${product.name}\n${money(this.options.productPrice)} ₸`, description];
    if (product.demo)
      parts.push(
        choose(
          lang(result),
          'Демонстрационный каталог. Наличие и условия продажи ещё не утверждены.',
          'Демонстрациялық каталог. Қолжетімділік пен сату шарттары әлі бекітілмеген.',
        ),
      );
    if (!product.images.length)
      parts.push(choose(lang(result), 'Фото пока не добавлено.', 'Фотосурет әзірге қосылмаған.'));
    result.messages.push({
      type: 'buttons',
      text: parts.join('\n\n').slice(0, 1000),
      buttons: [
        { id: A.PRODUCT_DISCS, title: choose(lang(result), '🎵 Мелодии', '🎵 Әуендер') },
        { id: A.PRODUCT_BUY, title: choose(lang(result), '🛒 Заказать', '🛒 Тапсырыс') },
        { id: A.MENU_BACK, title: choose(lang(result), '⬅️ Назад', '⬅️ Артқа') },
      ],
    });
  }

  private discs(result: ConversationResult, requestedPage: number): void {
    const discs = this.options.catalog.discs(true);
    if (result.customer.conversationState === 'ORDER_DISC' && result.order) {
      const ids = selectedDiscs(result.order);
      const names = ids
        .map((id, index) => `${index + 1}. ${this.options.catalog.disc(id)?.title ?? id}`)
        .join('\n');
      result.messages.push({
        type: 'buttons',
        text: choose(
          lang(result),
          `Выбрано ${ids.length}/${this.business.includedDiscCount}:\n${names || 'Пока ничего'}\nВсе комплекты будут одинаковыми.`,
          `Таңдалды ${ids.length}/${this.business.includedDiscCount}:\n${names || 'Әзірге бос'}\nБарлық жиынтық бірдей болады.`,
        ).slice(0, 1000),
        buttons: [
          { id: A.DISC_DONE, title: choose(lang(result), 'Готово', 'Дайын') },
          ...(ids.length
            ? [
                {
                  id: `${A.DISC_REMOVE_PREFIX}${ids.length - 1}`,
                  title: choose(lang(result), 'Убрать последний', 'Соңғысын жою'),
                },
              ]
            : []),
          { id: A.BACK, title: choose(lang(result), 'Назад', 'Артқа') },
        ],
      });
    }
    if (!discs.length) {
      say(
        result,
        'Сейчас в каталоге нет доступных мелодий.',
        'Қазір каталогта қолжетімді әуендер жоқ.',
      );
      return;
    }
    // Eight products plus previous/next navigation never exceed Meta's ten-row limit.
    const pageSize = 8;
    const page = Math.min(requestedPage, Math.max(0, Math.ceil(discs.length / pageSize) - 1));
    const rows: Extract<OutboundMessage, { type: 'list' }>['rows'] = discs
      .slice(page * pageSize, (page + 1) * pageSize)
      .map((disc) => ({
        id: `${A.DISC_PREFIX}${disc.id}`,
        title: disc.title.slice(0, 24),
        ...(disc.artist ? { description: disc.artist.slice(0, 72) } : {}),
      }));
    if (page > 0)
      rows.push({
        id: `${A.DISC_PAGE_PREFIX}${page - 1}`,
        title: choose(lang(result), '⬅️ Предыдущие', '⬅️ Алдыңғылары'),
      });
    if ((page + 1) * pageSize < discs.length)
      rows.push({
        id: `${A.DISC_PAGE_PREFIX}${page + 1}`,
        title: choose(lang(result), 'Следующие ➡️', 'Келесілері ➡️'),
      });
    result.messages.push({
      type: 'list',
      text: choose(
        lang(result),
        'Выберите мелодию из доступного каталога.',
        'Қолжетімді каталогтан әуен таңдаңыз.',
      ),
      button: choose(lang(result), 'Мелодии', 'Әуендер'),
      rows,
    });
  }

  private startOrder(result: ConversationResult): ConversationResult {
    const existing = result.order;
    if (existing?.checkoutFrozenAt && existing.orderStatus === 'AWAITING_CONFIRMATION') {
      result.customer.conversationState = 'ORDER_CONFIRMATION';
      this.summary(result);
      return result;
    }
    if (
      existing &&
      ['PENDING', 'CREATING', 'CREATION_UNKNOWN', 'REVIEW_REQUIRED'].includes(
        existing.paymentStatus,
      )
    ) {
      result.customer.conversationState = 'PAYMENT_PENDING';
      this.pending(result);
      return result;
    }
    if (!isEditableOrder(existing)) {
      const id = randomUUID();
      result.order = {
        id,
        publicOrderId: `MB-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${id.replaceAll('-', '').slice(0, 16).toUpperCase()}`,
        customerId: result.customer.id,
        recipientName: null,
        recipientPhone: null,
        city: null,
        address: null,
        productId: this.options.catalog.product(lang(result)).id,
        discId: null,
        quantity: 1,
        unitPrice: this.options.productPrice,
        totalAmount: this.options.productPrice,
        currency: 'KZT',
        orderStatus: 'DRAFT',
        paymentStatus: 'NOT_CREATED',
        paymentUrl: null,
        selectedDiscIds:
          this.business.packageMode === 'FIXED_SET' ? [...this.business.fixedDiscIds] : [],
        subtotalAmount: 20000,
        deliveryAmount: 0,
        deliveryMode: this.business.deliveryMode,
        configVersion: this.business.configVersion,
        contentVersion: 1,
        version: 1,
        checkoutFrozenAt: null,
      };
    }
    const order = result.order!;
    if (
      this.options.integrationMode === 'live' &&
      (!this.business.privacyPolicyUrl || !this.business.businessContact)
    )
      return this.handoff(result, 'BUSINESS_CONFIGURATION_REQUIRED');
    if (result.customer.privacyNoticeVersion !== this.business.privacyNoticeVersion)
      this.privacyNotice(result);
    result.customer.currentOrderId = order.id;
    result.customer.editingField = null;
    if (selectedDiscs(order).some((id) => !this.options.catalog.disc(id)?.available)) {
      order.selectedDiscIds = [];
      order.discId = null;
    }
    if (this.business.packageMode === 'FIXED_SET') {
      order.selectedDiscIds = [...this.business.fixedDiscIds];
      order.discId = order.selectedDiscIds[0] ?? null;
    }
    result.customer.conversationState =
      firstMissingField(order, this.options.maxQuantity) ??
      (order.orderStatus === 'DRAFT' ? 'ORDER_QUANTITY' : 'ORDER_CONFIRMATION');
    this.currentPrompt(result);
    return result;
  }

  private currentPrompt(result: ConversationResult): void {
    const state = result.customer.conversationState;
    switch (state) {
      case 'AWAITING_LANGUAGE':
        this.languageButtons(result);
        break;
      case 'ORDER_NAME':
        say(
          result,
          'Как зовут получателя? Укажите от 2 до 80 символов.',
          'Алушының аты кім? 2–80 таңба енгізіңіз.',
        );
        break;
      case 'ORDER_PHONE':
        say(
          result,
          'Укажите номер телефона получателя, например +7 701 123 45 67.',
          'Алушының телефон нөмірін жазыңыз, мысалы +7 701 123 45 67.',
        );
        break;
      case 'ORDER_CITY':
        say(
          result,
          'В каком городе вы хотите получить заказ?',
          'Тапсырысты қай қалада алғыңыз келеді?',
        );
        break;
      case 'ORDER_ADDRESS':
        say(
          result,
          'Укажите адрес доставки: улица, дом, квартира (от 5 до 300 символов).',
          'Жеткізу мекенжайын жазыңыз: көше, үй, пәтер (5–300 таңба).',
        );
        break;
      case 'ORDER_DISC':
      case 'DISC_LIST':
        this.discs(result, 0);
        break;
      case 'ORDER_QUANTITY':
        result.messages.push({
          type: 'buttons',
          text: choose(
            lang(result),
            `Сколько комплектов? Введите целое число от 1 до ${this.options.maxQuantity}.`,
            `Қанша жиынтық қажет? 1-ден ${this.options.maxQuantity}-ға дейін бүтін сан енгізіңіз.`,
          ),
          buttons: [
            { id: A.ORDER_QUANTITY_ONE, title: choose(lang(result), '1 комплект', '1 жиынтық') },
          ],
        });
        break;
      case 'CANCEL_CONFIRMATION':
        this.cancelPrompt(result);
        break;
      case 'ORDER_CONFIRMATION':
        if (result.customer.editingField === 'select') this.editMenu(result);
        else this.summary(result);
        break;
      case 'PAYMENT_PENDING':
        this.pending(result);
        break;
      case 'PRODUCT_VIEW':
        this.product(result);
        break;
      case 'AI_QA':
        say(result, 'Напишите ваш вопрос.', 'Сұрағыңызды жазыңыз.');
        break;
      case 'HUMAN_HANDOFF':
        break;
      default:
        this.menu(result);
    }
  }

  private orderInput(result: ConversationResult, text: string): ConversationResult {
    if (!isEditableOrder(result.order)) return this.staleAction(result);
    const order = result.order;
    switch (result.customer.conversationState) {
      case 'ORDER_NAME':
        if (!validText(text, 2, 80)) break;
        order.recipientName = text;
        this.advance(result, 'ORDER_PHONE');
        return result;
      case 'ORDER_PHONE': {
        const phone = normalizePhone(text);
        if (!phone) break;
        order.recipientPhone = phone;
        this.advance(result, 'ORDER_CITY');
        return result;
      }
      case 'ORDER_CITY':
        if (!validText(text, 2, 100)) break;
        order.city = text;
        this.advance(result, 'ORDER_ADDRESS');
        return result;
      case 'ORDER_ADDRESS':
        if (!validText(text, 5, 300)) break;
        order.address = text;
        this.advance(
          result,
          this.business.packageMode === 'FIXED_SET' ? 'ORDER_QUANTITY' : 'ORDER_DISC',
        );
        return result;
      case 'ORDER_DISC':
        say(result, 'Выберите мелодию кнопкой из списка.', 'Әуенді тізімдегі батырмамен таңдаңыз.');
        this.discs(result, 0);
        return result;
      case 'ORDER_QUANTITY': {
        if (!/^\d{1,5}$/.test(text)) break;
        const quantity = Number(text);
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > this.options.maxQuantity)
          break;
        order.quantity = quantity;
        order.unitPrice = this.options.productPrice;
        order.totalAmount = calculateTotal(quantity, order.unitPrice, this.options.maxQuantity);
        this.advance(result, 'ORDER_CONFIRMATION');
        return result;
      }
    }
    say(result, 'Проверьте значение и попробуйте ещё раз.', 'Мәнді тексеріп, қайта енгізіңіз.');
    this.currentPrompt(result);
    return result;
  }

  private advance(result: ConversationResult, next: ConversationState): void {
    if (result.customer.editingField) {
      result.customer.editingField = null;
      result.customer.conversationState =
        firstMissingField(result.order!, this.options.maxQuantity) ?? 'ORDER_CONFIRMATION';
    } else result.customer.conversationState = next;
    this.currentPrompt(result);
  }

  private summary(result: ConversationResult): void {
    if (
      !isEditableOrder(result.order) &&
      !(result.order?.checkoutFrozenAt && result.order.orderStatus === 'AWAITING_CONFIRMATION')
    ) {
      if (
        result.order &&
        ['PENDING', 'CREATING', 'CREATION_UNKNOWN', 'REVIEW_REQUIRED'].includes(
          result.order.paymentStatus,
        )
      )
        this.pending(result);
      else {
        result.customer.conversationState = 'MAIN_MENU';
        this.menu(result);
      }
      return;
    }
    const order = result.order!;
    if (!order.checkoutFrozenAt) {
      if (this.business.packageMode === 'FIXED_SET') {
        order.selectedDiscIds = [...this.business.fixedDiscIds];
        order.discId = order.selectedDiscIds[0] ?? null;
      }
      const missing = firstMissingField(order, this.options.maxQuantity);
      if (missing) {
        result.customer.conversationState = missing;
        this.currentPrompt(result);
        return;
      }
      if (packageIssues(selectedDiscs(order), this.business, this.options.catalog).length) {
        if (this.business.packageMode === 'FIXED_SET') {
          this.handoff(result, 'PACKAGE_UNAVAILABLE');
          return;
        }
        order.selectedDiscIds = selectedDiscs(order)
          .filter((id) => this.options.catalog.disc(id)?.available)
          .slice(0, this.business.includedDiscCount);
        order.discId = order.selectedDiscIds[0] ?? null;
        result.customer.conversationState = 'ORDER_DISC';
        this.discs(result, 0);
        return;
      }
      try {
        prepareCheckout(order, this.business, this.options.catalog, this.options.maxQuantity);
      } catch {
        this.handoff(result, 'DELIVERY_TARIFF_UNKNOWN');
        return;
      }
    }
    order.orderStatus = 'AWAITING_CONFIRMATION';
    result.customer.conversationState = 'ORDER_CONFIRMATION';
    const snapshot = order.packageSnapshot;
    const productName =
      snapshot?.productNames[lang(result)] ?? this.options.catalog.product(lang(result)).name;
    const discNames =
      snapshot?.discs.map((disc, index) => `${index + 1}. ${disc.title}`).join('\n') ??
      selectedDiscs(order).join(', ');
    const delivery = order.deliverySnapshot;
    const terms = delivery?.terms[lang(result)] ?? this.business.deliveryTerms[lang(result)];
    const ru = `Проверьте заказ:\n\nЗаказ: ${order.publicOrderId}\nТовар: ${productName}\nСостав каждого комплекта:\n${discNames}\nКоличество комплектов: ${order.quantity}\nТовары: ${money(order.subtotalAmount ?? order.totalAmount)} ₸\nДоставка по ссылке: ${money(order.deliveryAmount ?? 0)} ₸\n${terms}\nСумма по ссылке: ${money(order.totalAmount)} ₸\n\nПолучатель: ${order.recipientName}\nТелефон: ${order.recipientPhone}\nГород: ${order.city}\nАдрес: ${order.address}\n\nВсе комплекты в этом заказе имеют одинаковый состав. Разные составы — отдельные заказы или менеджер.\n${snapshot?.demo ? 'DEMO: демонстрационные условия, реальные платежи отключены.\n' : ''}Всё верно?`;
    const kk = `Тапсырысты тексеріңіз:\n\nТапсырыс: ${order.publicOrderId}\nӨнім: ${productName}\nӘр жиынтықтың құрамы:\n${discNames}\nЖиынтық саны: ${order.quantity}\nТауарлар: ${money(order.subtotalAmount ?? order.totalAmount)} ₸\nСілтемедегі жеткізу: ${money(order.deliveryAmount ?? 0)} ₸\n${terms}\nСілтемедегі сома: ${money(order.totalAmount)} ₸\n\nАлушы: ${order.recipientName}\nТелефон: ${order.recipientPhone}\nҚала: ${order.city}\nМекенжай: ${order.address}\n\nБұл тапсырыста барлық жиынтықтың құрамы бірдей. Әртүрлі құрам үшін бөлек тапсырыс беріңіз немесе менеджерге жазыңыз.\n${snapshot?.demo ? 'DEMO: үлгі шарттар, нақты төлемдер өшірілген.\n' : ''}Барлығы дұрыс па?`;
    // Summary can exceed interactive-body limits for a long address, so keep it a text message.
    result.messages.push({ type: 'text', text: choose(lang(result), ru, kk) });
    result.messages.push({
      type: 'buttons',
      text: choose(
        lang(result),
        'Подтвердите или измените заказ.',
        'Тапсырысты растаңыз немесе өзгертіңіз.',
      ),
      buttons: [
        { id: A.ORDER_CONFIRM, title: choose(lang(result), '✅ Всё верно', '✅ Дұрыс') },
        { id: A.ORDER_EDIT, title: choose(lang(result), '✏️ Изменить', '✏️ Өзгерту') },
        { id: A.ORDER_CANCEL, title: choose(lang(result), '❌ Отменить', '❌ Тоқтату') },
      ],
    });
  }

  private editMenu(result: ConversationResult): void {
    const labels = [
      ['Имя', 'Аты', A.EDIT_NAME],
      ['Телефон', 'Телефон', A.EDIT_PHONE],
      ['Город', 'Қала', A.EDIT_CITY],
      ['Адрес', 'Мекенжай', A.EDIT_ADDRESS],
      ['Мелодия', 'Әуен', A.EDIT_DISC],
      ['Количество', 'Саны', A.EDIT_QUANTITY],
    ];
    result.messages.push({
      type: 'list',
      text: choose(lang(result), 'Что изменить в заказе?', 'Тапсырыста нені өзгертеміз?'),
      button: choose(lang(result), 'Изменить', 'Өзгерту'),
      rows: labels
        .filter(
          ([, , id]) => id !== A.EDIT_DISC || this.business.packageMode === 'SELECTABLE_DISCS',
        )
        .map(([ru, kk, id]) => ({ id: id!, title: choose(lang(result), ru!, kk!) })),
    });
  }

  private pending(result: ConversationResult): void {
    const url = result.order?.paymentUrl;
    say(
      result,
      `Оплата пока не подтверждена платёжной системой. Сообщение «я оплатил» не подтверждает оплату. Как только получу подтверждение, сообщу вам.${url ? `\n\nСсылка на оплату: ${url}` : '\nСсылка на оплату готовится.'}`,
      `Төлем жүйесі төлемді әлі растаған жоқ. «Төледім» деген хабарлама төлемді растамайды. Растау түскенде сізге хабарлаймын.${url ? `\n\nТөлем сілтемесі: ${url}` : '\nТөлем сілтемесі дайындалуда.'}`,
    );
  }

  private staleAction(result: ConversationResult): ConversationResult {
    say(
      result,
      'Эта кнопка сейчас не подходит. Продолжите с текущего шага или откройте меню.',
      'Бұл батырма қазір жарамсыз. Ағымдағы қадамды жалғастырыңыз немесе мәзірді ашыңыз.',
    );
    // Do not render a summary here: rendering one changes confirmation state.
    if (result.customer.conversationState === 'ORDER_CONFIRMATION') {
      if (result.customer.editingField === 'select') this.editMenu(result);
    } else if (
      orderInputStates.has(result.customer.conversationState) &&
      !isEditableOrder(result.order)
    ) {
      result.customer.conversationState =
        result.order?.paymentStatus === 'PENDING' ? 'PAYMENT_PENDING' : 'MAIN_MENU';
      this.currentPrompt(result);
    } else this.currentPrompt(result);
    return result;
  }

  private handoff(result: ConversationResult, reason: string): ConversationResult {
    if (this.options.managerHandoffEnabled === false) {
      say(
        result,
        'Менеджер в этом тестовом режиме не подключён. Я могу помочь с каталогом и оформлением. Продолжите текущий шаг или напишите «меню».',
        'Бұл сынақ режимінде менеджер қосылмаған. Каталог пен тапсырысты рәсімдеуге көмектесе аламын. Ағымдағы қадамды жалғастырыңыз немесе «мәзір» деп жазыңыз.',
      );
      return result;
    }
    result.customer.previousState = result.customer.conversationState;
    result.customer.conversationState = 'HUMAN_HANDOFF';
    result.handoff = { reason };
    say(
      result,
      'Передаю вопрос менеджеру. Он продолжит общение с вами.',
      'Сұрағыңызды менеджерге жіберемін. Әрі қарай ол сізбен сөйлеседі.',
    );
    return result;
  }

  private async answer(
    result: ConversationResult,
    text: string,
    history: Input['history'],
  ): Promise<void> {
    try {
      const answer = await this.options.ai.answer({
        language: lang(result),
        text,
        history,
        context: {
          customerId: result.customer.id,
          state: result.customer.conversationState,
          orderId: result.order?.id,
          orderCustomerId: result.order?.customerId,
          conversationVersion: result.customer.conversationVersion,
        },
      });
      if (
        answer.action === 'request_human_handoff' ||
        (this.options.managerHandoffEnabled === false &&
          answer.text &&
          /менеджер|оператор|кеңесші|специалист|маман|адаммен сөйлес/iu.test(answer.text))
      ) {
        this.handoff(result, answer.reason ?? 'AI_UNCERTAIN');
        return;
      }
      if (!answer.text && !answer.action) {
        this.handoff(result, 'AI_UNCERTAIN');
        return;
      }
      if (answer.text) result.messages.push({ type: 'text', text: answer.text.slice(0, 4000) });
      if (answer.action === 'start_order') {
        this.startOrder(result);
      } else if (answer.action === 'show_main_menu') {
        result.customer.conversationState = 'MAIN_MENU';
        this.menu(result);
      } else {
        result.customer.conversationState = 'AI_QA';
        if (!answer.text) this.handoff(result, 'AI_UNCERTAIN');
      }
    } catch {
      this.handoff(result, 'AI_UNAVAILABLE');
    }
  }
}
