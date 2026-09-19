/**
 * `sms:` deep links.
 *
 * `sms:<e164>?&body=<urlencoded>` is the one form both iOS and Android parse: the stray `&`
 * after the `?` is deliberate, and dropping it makes iOS treat the body as part of the number.
 * The same builder is used for the QR `pagr connect` prints and for the plain fallback line, so
 * a person who scans and a person who copies end up sending exactly the same text.
 */

/** The text a new Mac asks you to send. Any message from a verified number links it. */
export const LINK_PHONE_BODY = 'Hi Pagr';

export function smsLink(e164: string, body: string): string {
  return `sms:${e164}?&body=${encodeURIComponent(body)}`;
}

/** The link that gets a phone attached to the account this Mac just paired with. */
export function linkPhoneSms(productNumber: string): string {
  return smsLink(productNumber, LINK_PHONE_BODY);
}
