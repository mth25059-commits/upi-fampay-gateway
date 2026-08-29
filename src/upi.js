/**
 * UPI request strings, and the trick that makes automatic confirmation reliable.
 *
 * A UPI intent URI carries a note field (`tn`). The obvious design is to put a
 * random reference in there, wait for the bank's notification mail, and match on
 * that reference. That is what the FamPay bot this was ported from does — and it
 * is why that bot needs a second, weaker rule underneath: several UPI apps drop
 * or rewrite `tn` on the way through, so the note simply never arrives. Its
 * fallback then accepts *any* incoming payment of the right amount inside a ten
 * minute window, which will happily settle the wrong customer's order the moment
 * two people buy the same plan at once.
 *
 * So the note is not the primary key here. The amount is.
 *
 * Every pending order is charged a slightly different number of paise, unique
 * across all live orders, which makes the amount itself the reference. Nothing
 * downstream depends on the note surviving, and two simultaneous buyers of the
 * same plan cannot collide because they are never quoted the same figure. The
 * note still goes out, and it is still checked when it does arrive — belt and
 * braces, not the load-bearing wall.
 */
import { randomInt } from 'node:crypto';

/** Paise are the unit of truth everywhere in this module — integers, no floats. */
export const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100);

export const rupees = (paise) => Number(paise || 0) / 100;

/** `1298.57` / `1299` — trailing zeros trimmed, which is what UPI apps expect. */
export function formatAmount(paise) {
  const n = Math.max(0, Math.round(Number(paise) || 0));
  const whole = Math.floor(n / 100);
  const frac = n % 100;
  if (!frac) return String(whole);
  return `${whole}.${String(frac).padStart(2, '0')}`;
}

/** ₹1,298.57 — for the payment screen and the confirmation mail. */
export function displayAmount(paise) {
  const n = Math.max(0, Math.round(Number(paise) || 0));
  const whole = (n - (n % 100)) / 100;
  const frac = n % 100;
  const head = whole.toLocaleString('en-IN');
  return frac ? `₹${head}.${String(frac).padStart(2, '0')}` : `₹${head}`;
}

/* ------------------------------ the reference ----------------------------- */

const SUFFIX_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — read aloud

/**
 * `SF-20260828-K7P2QX`. The date segment is for a human reading a bank statement;
 * only the suffix carries entropy, and it comes from `crypto` rather than
 * `Math.random` because it is a payment reference, not a UI id. 32^6 ≈ 30 bits,
 * which is plenty for something that also has to match an amount inside a
 * fifteen minute window.
 */
export function makeReference(prefix = 'SF') {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)];
  }
  return `${String(prefix).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'SF'}-${day}-${suffix}`;
}

/** Matches what `makeReference` produces, for pulling one out of an email body. */
export const referencePattern = (prefix = 'SF') =>
  new RegExp(`\\b${String(prefix).toUpperCase().replace(/[^A-Z0-9]/g, '')}-\\d{8}-[A-Z0-9]{6}\\b`);

/* --------------------------- the unique amount --------------------------- */

/*
 * Paise granularity of a reserved amount.
 *
 * 1 means the last two digits identify the order, which gives 99 slots per price.
 * That relies on the bank's notification printing paise in full, and it does: the
 * account holder has received a ₹1.56 credit whose alert carried both digits. The
 * two alerts captured in samples/ happen to be ₹1.0 and ₹1.7, so on those alone a
 * trailing zero and a rounded figure are indistinguishable — hence this note, and
 * hence the test below that pins the behaviour we are relying on.
 *
 * If an alert ever turns up with a rounded amount, set this to 10. Ten-paise marks
 * read the same whether printed as `₹498.60` or `₹498.6`, so matching keeps working
 * at the cost of 9 slots per price instead of 99. That is the whole fix — one digit.
 */
const STEP_PAISE = 1;

/**
 * Picks the exact figure this order will be charged: the listed price, minus up
 * to 99 paise, so the last two digits identify the order.
 *
 * Shaving paise off rather than adding them means the customer is never asked
 * for more than the price on the card — a rounding surprise in the buyer's
 * favour needs no explaining, one against them is a support ticket. The
 * exception is a price so small that the discount would push it under ₹1, which
 * UPI rejects outright; there the paise go on top instead.
 *
 * `taken` is every amount currently spoken for by a live order. Uniqueness is
 * enforced on the final figure, not on the paise alone, because two different
 * plan prices can never produce the same total anyway.
 */
export function pickAmount(priceRupees, taken = new Set()) {
  const base = toPaise(priceRupees);
  if (!Number.isFinite(base) || base <= 0) {
    return { error: 'That product has no usable price.' };
  }

  const busy = new Set([...taken].map(Number));
  // Below ₹2 there is no room to discount and stay above the ₹1 floor.
  const downward = base - 100 >= 100;

  const candidates = [];
  for (let paise = STEP_PAISE; paise <= 99; paise += STEP_PAISE) {
    candidates.push(downward ? base - 100 + paise : base + paise);
  }
  // Shuffled so consecutive orders do not walk 01, 02, 03 — an amount that is
  // guessable is an amount someone can pay before we have quoted it.
  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const free = candidates.find((amount) => !busy.has(amount));
  if (free === undefined) {
    // Every slot on one price taken by an unexpired order at once. Unlikely at
    // this volume, and the honest answer is to ask the customer to retry rather
    // than to quote a figure we cannot attribute.
    return { error: 'Too many payments in progress for this product — try again in a few minutes.' };
  }

  return { amountPaise: free, listedPaise: base, discountPaise: base - free };
}

/* ------------------------------- the URI --------------------------------- */

/**
 * `upi://pay?...` — the string a QR encodes and an Android intent opens.
 *
 * Field order is deliberate: `pa` and `pn` first, then the amount, then the
 * note. Some older UPI apps parse positionally and get confused when `am`
 * arrives before the payee.
 */
export function buildUpiUri({ upiId, payeeName, amountPaise, note }) {
  const pa = String(upiId || '').trim();
  if (!/^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.-]{1,32}$/.test(pa)) {
    throw new Error(`UPI id does not look valid: ${pa || '(empty)'}`);
  }

  // Letters, digits and spaces only — UPI apps choke on other punctuation in the
  // payee name, and `&` here would break the query if it survived.
  const pn = String(payeeName || '').replace(/[^\w &.-]/g, '').trim().slice(0, 40) || 'Payee';
  const am = formatAmount(amountPaise);
  const tn = note ? String(note).replace(/[^\w -]/g, '').slice(0, 50) : '';

  /*
   * The query is built by hand, on purpose. `URLSearchParams` percent-encodes the
   * `@` in `pa` to `%40`, which is technically correct but breaks real phones:
   * BHIM (and a few others) do not decode `%40` in this field and try to pay a
   * VPA literally spelled "name%40bank", which does not exist. `@` is a legal
   * query character (RFC 3986 sub-delims) and the regex above proves `pa` holds
   * nothing else that needs escaping, so it goes out verbatim.
   *
   * Everything that CAN carry an unsafe character — `pn` may hold `&` or a space —
   * is run through encodeURIComponent, which also emits `%20` for a space rather
   * than the `+` that `URLSearchParams` produces and that UPI apps decode
   * inconsistently. `am` (digits + dot) and `cu` need no escaping.
   */
  const query =
    `pa=${pa}` +
    `&pn=${encodeURIComponent(pn)}` +
    `&am=${am}` +
    `&cu=INR` +
    (tn ? `&tn=${encodeURIComponent(tn)}` : '');

  return `upi://pay?${query}`;
}
