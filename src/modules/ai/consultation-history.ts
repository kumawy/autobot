// Only explicitly tagged consultation messages may use this helper. Order-form
// values and prompts must never be added to consultation history in the first place.
const privateText =
  /PAYMENT_CREDENTIALS_REDACTED|\b(?:cvv|cvc|pin|otp|password)\b|(?:пин|смс|sms)[ -]?(?:код|code)|парол|құпиясөз|(?:\d[ -]?){13,19}|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\+?\d[\d ()-]{8,}\d)|(?:меня зовут|мо[йя] адрес|мой телефон|менің атым|менің мекенжайым)|(?:улица|проспект|квартира|көшесі|пәтер)\s+|\b(?:sk|sk-proj)-[A-Za-z0-9_-]+\b|Bearer\s+[A-Za-z0-9._-]+/iu;

export function safeConsultationText(value: string | null): string | null {
  if (!value || privateText.test(value)) return null;
  return value.slice(0, 1200);
}
