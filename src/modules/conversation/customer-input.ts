/** Recognize interruptions before a free-text field can consume them as order data. */
export function isCustomerQuestion(text: string): boolean {
  const value = text.trim();
  const explicitQuestion =
    /[?？]/u.test(value) ||
    /^(?:а\s+)?(?:как|сколько|когда|почему|зачем|можно|можете|есть\s+ли|что\s+(?:входит|такое|значит)|какой|какая|какие|куда|где|у\s+вас|это|хочу\s+(?:узнать|уточнить|спросить|понять)|хотел(?:а)?\s+(?:бы\s+)?(?:узнать|уточнить|спросить|понять)|интересует|интересуют|интересно|подскажите|расскажите|объясните|не\s+знаю|помоги(?:те)?|қалай|қанша|қашан|неге|қайда|қайсы|қандай|бар\s+ма|бола\s+ма|сіздерде|бұл|білгім\s+келеді|түсіндір|айтып\s+бер)(?=\s|[,.!?]|$)/iu.test(
      value,
    ) ||
    /(?:^|\s)(?:сколько|почему|зачем|есть\s+ли|қанша|қашан|қалай)(?=\s|[,.!?]|$)/iu.test(value) ||
    /(?:бар\s+ма|бола\s+ма)(?:[.!\s]*)$/iu.test(value) ||
    /^а\s+\S+(?:\s+\S+){2,}/iu.test(value);
  if (explicitQuestion) return true;
  // A street's name may contain a business term. Do not turn an address into a consultation.
  if (
    /^(?:ул\.?|улица|проспект|пр[-.]?т|переулок|мкр\.?|микрорайон|көше|көшесі)\s+.*\d/iu.test(value)
  )
    return false;
  return /(?:^|[\s,.:;()])(?:бағасы|жеткізу|кепілдік|қаптама|самовывоз|доставк(?:а|и|у|е|ой|ами|ах)?|гаранти(?:я|и|ю|ей|ям|ями|ях)|гарантийн(?:ый|ая|ое|ые|ого|ой|ому|ым|ыми|ых)|комплектаци(?:я|и|ю|ей)|упаковк(?:а|и|у|е|ой)|оплат(?:а|ы|у|е|ой|ить|ил[аи]?|им|ят)|заплат(?:ить|ил[аи]?|им|ят)|оплач(?:ен[ао]?|ены|ива(?:ть|ю|ем|ют))|плат[её]ж(?:а|и|у|ей|ом)?|плат[её]жн(?:ый|ая|ое|ые|ого|ой|ому|ым|ыми|ых)|скидк(?:а|и|у|е|ой)|возврат(?:а|ы|у|ом)?|цен(?:а|ы|у|е|ой)|стоимост(?:ь|и|ью)|шкатулк(?:а|и|у|е|ой)|қобдиша)(?=$|[\s,.:;!?()])/iu.test(
    value,
  );
}

export function isPaymentProblem(text: string): boolean {
  return /(?:ссылк[аиу].*(?:не\s+(?:открыва|работа)|ошиб)|не\s+(?:открыва|работа).*ссылк|ошибк.*(?:оплат|плат[её]ж)|не\s+(?:могу\s+оплатить|проходи[тл]\s+(?:оплат|плат[её]ж))|(?:списал|списан).*(?:дважды|два\s+раза)|төлем.*(?:қате|өтпеді)|сілтеме.*(?:ашылмай|істемей))/iu.test(
    text,
  );
}

export function isOrderConfirmation(text: string): boolean {
  return /^(?:да(?:\s*[,!—-]?\s*(?:вс[её]\s+(?:верно|правильно)|подтверждаю))?|вс[её]\s+(?:верно|правильно)|подтверждаю(?:\s+заказ)?|верно|дұрыс|бәрі\s+дұрыс|иә(?:\s*[,!—-]?\s*бәрі\s+дұрыс)?|растаймын)[.!\s]*$/iu.test(
    text.trim(),
  );
}

export function isPaymentStatusRequest(text: string): boolean {
  return /^(?:я\s+оплатил[аи]?|оплатил[аи]?|төледім|төленді|статус(?:\s+оплаты)?|проверить\s+оплату|төлем(?:нің)?\s+күйі|төлем\s+мәртебесі)[.!\s]*$/iu.test(
    text.trim(),
  );
}

export function normalizeOrderText(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

const acknowledgement =
  /^(?:(?:да|нет|ок|окей|ok|okay|ага|угу|хорошо|понятно|ясно|спасибо|отлично|согласен|согласна|привет|здравствуйте|добрый\s+(?:день|вечер)|рахмет|иә|ия|жоқ|жарайды|түсінікті|жақсы|сәлем|сәлеметсіз\s+бе|hello|hi)[\s,.!]*)+$/iu;

function isCollectedName(text: string, maxLength: number): boolean {
  return (
    !acknowledgement.test(text) &&
    !isCustomerQuestion(text) &&
    text.length >= 2 &&
    text.length <= maxLength &&
    text.split(/\s+/u).length <= 4 &&
    /^[\p{L}\p{M}]+(?:[ .’'-]+[\p{L}\p{M}]+)*\.?$/u.test(text)
  );
}

export function isRecipientName(text: string): boolean {
  return isCollectedName(text, 80);
}

export function isCityName(text: string): boolean {
  return isCollectedName(text, 100);
}
