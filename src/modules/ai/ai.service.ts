import OpenAI from 'openai';
import type { ResponseInput } from 'openai/resources/responses/responses.js';
import { CatalogService, isPlaceholder, type Language } from '../knowledge/catalog.service.js';
import { buildSystemPrompt } from './ai.prompt.js';
import { aiTools, executeAiTool } from './ai.tools.js';
import type { AiAnswer, AiInput, AiService, HandoffReason } from './ai.types.js';

export type { AiAnswer, AiInput, AiService } from './ai.types.js';

const handoffText: Record<Language, string> = {
  ru: 'Точную информацию нужно уточнить у менеджера. Передаю ваш вопрос.',
  kk: 'Нақты ақпаратты менеджерден анықтау керек. Сұрағыңызды менеджерге жолдаймын.',
};

function handoff(language: Language, reason: HandoffReason = 'UNKNOWN_INFORMATION'): AiAnswer {
  return { text: handoffText[language], action: 'request_human_handoff', reason };
}

// Payment credentials are rejected before reaching the model. The application must
// additionally avoid sending order-form history to this service.
const sensitiveText =
  /PAYMENT_CREDENTIALS_REDACTED|\b(?:cvv|cvc|pin|otp|password)\b|(?:пин|смс|sms)[ -]?(?:код|code)|парол|құпиясөз|карта(?:ның)?\s*(?:номер|нөмір)|(?:\d[ -]?){13,19}/iu;
const personalText =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\+?\d[\d ()-]{8,}\d)|(?:меня зовут|мо[йя] адрес|мой телефон|менің атым|менің мекенжайым)|(?:улица|проспект|квартира|көшесі|пәтер)\s+/iu;

/** Best-effort redaction for free text; structured order PII never belongs in AI context. */
export function sanitizeAiText(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[email removed]')
    .replace(/(?:\+?\d[\d ()-]{8,}\d)/gu, '[number removed]')
    .replace(/\b(?:sk|sk-proj)-[A-Za-z0-9_-]+\b/gu, '[secret removed]')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._-]+/giu, '[secret removed]')
    .slice(0, 1200);
}

function guardInput(input: AiInput, catalog: CatalogService): AiAnswer | undefined {
  const text = input.text.toLocaleLowerCase().trim();
  const kk = input.language === 'kk';
  if (sensitiveText.test(text)) {
    return {
      ...handoff(input.language, 'PAYMENT_PROBLEM'),
      text: kk
        ? 'Карта деректерін, құпиясөздерді және растау кодтарын чатқа жібермеңіз. Сұрағыңызды менеджерге жолдаймын.'
        : 'Не отправляйте в чат реквизиты карты, пароли и коды подтверждения. Передаю вопрос менеджеру.',
    };
  }
  if (personalText.test(text)) {
    return {
      text: kk
        ? 'Жеке деректерді тек тапсырыс формасында енгізіңіз. Тапсырыс беру үшін мәзірді ашыңыз.'
        : 'Личные данные вводите только в форме заказа. Для оформления откройте меню.',
    };
  }
  if (/менеджер|оператор|человек|адаммен|кеңесші/iu.test(text))
    return handoff(input.language, 'MANAGER_REQUESTED');
  if (/жалоб|претензи|сломал|сломано|брак|шағым|сынған|ақау/iu.test(text))
    return handoff(input.language, 'COMPLAINT');
  if (
    /верни(?:те)? деньги|вернуть деньги|возврат средств|ақшаны қайтар|ақшамды қайтар/iu.test(text)
  )
    return handoff(input.language, 'REFUND_REQUEST');
  if (
    /не (?:прош[её]л|проходи[тл]) плат[её]ж|ошибк[аи] оплат|списал|төлем.*(?:қате|өтпеді)/iu.test(
      text,
    )
  )
    return handoff(input.language, 'PAYMENT_PROBLEM');
  if (
    /сво[юяеи] (?:песн|мелоди)|индивидуальн|кастом|собственн.*(?:песн|мелоди)|өз(?:імнің)?\s*ән|жеке\s*әуен/iu.test(
      text,
    )
  )
    return handoff(input.language, 'CUSTOM_ORDER');
  if (/оптом|оптов|көтерме/iu.test(text)) return handoff(input.language, 'BULK_ORDER');
  if (
    /(?:я|уже) оплатил|оплатил[аи]?|төледім|төленді|отметь.*оплачен|подтверд[иь].*оплат|mark.*paid/iu.test(
      text,
    )
  ) {
    return {
      text: kk
        ? 'Төлемді тек төлем жүйесінің растауы бойынша тексереміз. Растау келгенде сізге хабарлама жіберіледі.'
        : 'Оплата подтверждается только платёжной системой. Когда придёт подтверждение, вы получите сообщение.',
    };
  }
  if (/скидк|жеңілдік|цен[ау].*(?:теперь|измени)|(?:измени|поменяй).*цен/iu.test(text)) {
    return {
      text: catalog.faq(input.language).find((entry) => entry.id === 'price')?.answer ?? '',
    };
  }
  if (/^(?:меню|назад|басты мәзір|мәзір)[.!\s]*$/iu.test(text)) return { action: 'show_main_menu' };
  if (
    /^(?:хочу |давайте |можно |я хочу )?(?:заказать|купить|оформить заказ|тапсырыс бер(?:емін|гім келеді)|сатып ал(?:ғым келеді|амын))[.!\s]*$/iu.test(
      text,
    )
  )
    return { action: 'start_order' };
  return undefined;
}

const faqPatterns: [string, RegExp][] = [
  ['gift_packaging', /подарочн.*упаков|упаков.*подар|сыйлық.*қаптама|қаптама/iu],
  [
    'delivery_time',
    /сколько.*(?:достав|дней)|срок.*достав|когда.*(?:достав|приед)|жеткізу.*(?:уақыт|күн)|қанша.*күн/iu,
  ],
  ['price', /сколько сто|цен[аыу]|стоимост|баға|қанша тұрады|қанша теңге/iu],
  ['package', /комплект|что входит|жиынтық|не кіреді/iu],
  ['mechanism', /как работа|механизм|батарей|қалай жұмыс|батарея/iu],
  ['delivery', /достав|самовывоз|жеткіз|алып кет/iu],
  ['returns', /возврат|вернуть|обмен|қайтар|айырбаст/iu],
  ['warranty', /гаранти|кепілдік/iu],
  ['payment', /оплат|плат[её]ж|төле|төлем/iu],
  ['quantity', /несколько|штук|количеств|бірнеше|дана/iu],
  ['gift', /подар|девушк|сыйлық/iu],
  ['choose_song', /выбрать пес|выбор пес|ән.*таңда/iu],
  ['discs', /мелоди|диск|песн|әуен|әндер/iu],
];

function missingKnownFact(input: AiInput, catalog: CatalogService): AiAnswer | undefined {
  const product = catalog.product(input.language);
  for (const [pattern, field] of [
    [/материал|из чего|неден жасал|материалы/iu, 'material'],
    [/размер|габарит|өлшем/iu, 'dimensions'],
  ] as const) {
    if (pattern.test(input.text)) {
      const value = product[field];
      return value && !isPlaceholder(value) ? { text: value } : handoff(input.language);
    }
  }
  const topic = faqPatterns.find(([, pattern]) => pattern.test(input.text))?.[0];
  if (!topic) return undefined;
  const answer = catalog.faq(input.language).find((entry) => entry.id === topic)?.answer;
  return !answer || /\bTODO\b/iu.test(answer) ? handoff(input.language) : undefined;
}

export class DemoAiService implements AiService {
  private readonly catalog: CatalogService;
  constructor(options: { catalog: CatalogService }) {
    this.catalog = options.catalog;
  }

  async answer(input: AiInput): Promise<AiAnswer> {
    if (input.context?.state === 'HUMAN_HANDOFF') return {};
    const guarded = guardInput(input, this.catalog);
    if (guarded) return guarded;
    const missing = missingKnownFact(input, this.catalog);
    if (missing) return missing;
    const text = input.text.trim();
    if (/^(?:привет|здравствуйте|добрый день|сәлем|сәлеметсіз бе)[.!\s]*$/iu.test(text)) {
      return {
        text:
          input.language === 'ru'
            ? 'Здравствуйте! Могу рассказать о шкатулке, показать мелодии или помочь оформить заказ.'
            : 'Сәлеметсіз бе! Қобдиша туралы айтып, әуендерді көрсетіп немесе тапсырыс беруге көмектесе аламын.',
      };
    }
    const matchingDisc = this.catalog
      .discs(false)
      .find((disc) => text.toLocaleLowerCase().includes(disc.title.toLocaleLowerCase()));
    if (matchingDisc) {
      if (!matchingDisc.available)
        return {
          text:
            input.language === 'ru'
              ? 'Эта мелодия сейчас недоступна в каталоге. Можно выбрать другую доступную мелодию.'
              : 'Бұл әуен қазір каталогта қолжетімсіз. Басқа қолжетімді әуенді таңдауға болады.',
        };
      return {
        text:
          input.language === 'ru'
            ? `${matchingDisc.title} есть в ${matchingDisc.demo ? 'демонстрационном ' : ''}каталоге доступных мелодий.`
            : `${matchingDisc.title} қолжетімді әуендердің ${matchingDisc.demo ? 'демонстрациялық ' : ''}каталогында бар.`,
      };
    }
    // Unknown requested titles need a human; do not silently replace them with the demo assortment.
    if (/есть (?:ли )?(?:песня|мелодия|диск)\s+["«\wа-яё]|(?:әні|әуені) бар ма/iu.test(text))
      return handoff(input.language);
    const topic = faqPatterns.find(([, pattern]) => pattern.test(text))?.[0];
    if (topic) {
      const entry = this.catalog.faq(input.language).find((faq) => faq.id === topic);
      if (!entry?.answer || /\bTODO\b/iu.test(entry.answer)) return handoff(input.language);
      const prefix =
        this.catalog.product(input.language).demo &&
        ['price', 'package', 'discs', 'choose_song'].includes(topic)
          ? input.language === 'ru'
            ? 'Демонстрационный каталог. '
            : 'Демонстрациялық каталог. '
          : '';
      return { text: prefix + entry.answer };
    }
    if (/товар|шкатулк|қобдиша|өнім/iu.test(text)) {
      const product = this.catalog.product(input.language);
      if (!product.description) return handoff(input.language);
      return { text: product.description };
    }
    return handoff(input.language);
  }
}

export interface OpenAiOptions {
  apiKey: string;
  model: string;
  catalog: CatalogService;
  timeoutMs?: number;
  maxTools?: number;
}

export class OpenAiService implements AiService {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly catalog: CatalogService;
  private readonly timeoutMs: number;
  private readonly maxTools: number;

  constructor(options: OpenAiOptions) {
    if (!options.apiKey.trim() || !options.model.trim())
      throw new Error('OpenAI key and model are required');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxTools = options.maxTools ?? 4;
    if (!Number.isSafeInteger(this.maxTools) || this.maxTools < 1 || this.maxTools > 20)
      throw new Error('AI maxTools must be 1–20');
    if (this.timeoutMs < 1 || this.timeoutMs > 60_000)
      throw new Error('AI timeout must be 1–60000 ms');
    this.client = new OpenAI({ apiKey: options.apiKey, timeout: this.timeoutMs, maxRetries: 0 });
    this.model = options.model;
    this.catalog = options.catalog;
  }

  async answer(input: AiInput): Promise<AiAnswer> {
    if (input.context?.state === 'HUMAN_HANDOFF') return {};
    const guarded = guardInput(input, this.catalog);
    if (guarded) return guarded;
    const missing = missingKnownFact(input, this.catalog);
    if (missing) return missing;
    const messages: ResponseInput = (input.history ?? [])
      .slice(-6)
      .filter(
        (message) => !personalText.test(message.content) && !sensitiveText.test(message.content),
      )
      .map((message) => ({ role: message.role, content: sanitizeAiText(message.content) }));
    messages.push({ role: 'user', content: sanitizeAiText(input.text) });
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      let toolCount = 0;
      for (let round = 0; round <= this.maxTools; round += 1) {
        const response = await this.client.responses.create(
          {
            model: this.model,
            instructions: buildSystemPrompt(this.catalog, input.language),
            input: messages,
            tools: aiTools,
            tool_choice: 'auto',
            parallel_tool_calls: false,
            store: false,
            max_output_tokens: 700,
          },
          { signal },
        );
        if (response.status !== 'completed') return handoff(input.language, 'AI_UNCERTAIN');
        const calls = response.output.filter((item) => item.type === 'function_call');
        if (calls.length > 1) return handoff(input.language, 'AI_UNCERTAIN');
        if (!calls.length) {
          const text = response.output_text.trim();
          if (!isSafeReply(text, this.catalog.product(input.language).price))
            return handoff(input.language, 'AI_UNCERTAIN');
          return { text };
        }
        // Replay every response item, including reasoning items, for stateless tool continuation.
        for (const item of response.output) {
          if (
            item.type === 'function_call' ||
            item.type === 'reasoning' ||
            item.type === 'message'
          ) {
            messages.push(item);
          } else {
            return handoff(input.language, 'AI_UNCERTAIN');
          }
        }
        for (const call of calls) {
          if (++toolCount > this.maxTools) return handoff(input.language, 'AI_UNCERTAIN');
          const result = executeAiTool(
            call.name,
            call.arguments,
            this.catalog,
            input.language,
            input.context,
          );
          if (result.action) {
            return result.action.action === 'request_human_handoff'
              ? { ...result.action, text: handoffText[input.language] }
              : result.action;
          }
          messages.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify(result.output),
          });
        }
      }
    } catch {
      // Do not log SDK errors: they can contain request bodies and customer text.
      return handoff(input.language, 'AI_UNCERTAIN');
    }
    return handoff(input.language, 'AI_UNCERTAIN');
  }
}

/** Defense in depth; business state mutations are impossible through the AI interface. */
export function isSafeReply(text: string, price: number): boolean {
  if (!text || text.length > 1600 || sensitiveText.test(text) || /\bTODO\b/iu.test(text))
    return false;
  if (
    /оплата (?:получена|прошла|подтверждена|успешна)|заказ\s+оплачен|плат[её]ж\s+(?:успешен|подтвержд[её]н)|төлем\s+(?:қабылданды|расталды|сәтті өтті)|payment\s+(?:received|confirmed|successful)|скидк[ау]\s+(?:сдела|предостав)|жеңілдік\s+бер/iu.test(
      text,
    )
  )
    return false;
  const amounts = [...text.matchAll(/(\d[\d \u00a0\u202f]*(?:[.,]\d{1,2})?)\s*(?:₸|тенге|KZT)/giu)];
  if (
    amounts.some(
      (match) =>
        Number((match[1] ?? '').replace(/[ \u00a0\u202f]/gu, '').replace(',', '.')) !== price,
    )
  )
    return false;
  return !isPlaceholder(text) || /демонстрацион|демонстрациялық/iu.test(text);
}
