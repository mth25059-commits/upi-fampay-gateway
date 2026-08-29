/**
 * The rules for deciding that a payment is real, and which order it belongs to.
 *
 * This module is pure: it reads facts and returns a verdict. It never touches a
 * database, never sends a message, never marks anything paid. That is deliberate
 * — the one question worth isolating is *what convinced us this was paid*, and
 * keeping it side-effect free means there is exactly one file to read for the
 * answer. Persisting the result and fulfilling the order are the gateway's job.
 *
 * Two ideas do all the work:
 *
 *   1. The amount is the reference. Every pending order reserves a unique number
 *      of paise (see `src/upi.js`), so ₹499.12 and ₹499.37 are two different
 *      customers, not two guesses about one. The UPI note is checked when it
 *      survives but nothing depends on it — apps drop it.
 *
 *   2. A From header is a line of text anyone can type. Automatic confirmation
 *      makes a forged alert worth real money, so a credit is only believed when
 *      the mail carries a DKIM pass for the sender's own domain in a header the
 *      receiving server (Gmail) wrote — a claim the sending domain's published
 *      key has to back, not the sender.
 */

import { config } from './config.js';
import { displayAmount } from './upi.js';

/* ---------------------------- sender authenticity ------------------------- */

const domainOf = (address) => String(address || '').split('@').pop().toLowerCase().trim();

/**
 * True when `candidate` is the expected domain or a subdomain of it. Written out
 * rather than done with `endsWith`, because `endsWith('famapp.in')` also accepts
 * `notfamapp.in`, which is exactly the domain an attacker would register.
 */
function domainMatches(candidate, expected) {
  const c = String(candidate || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  const e = String(expected || '').toLowerCase();
  if (!c || !e) return false;
  return c === e || c.endsWith(`.${e}`);
}

/**
 * Decides whether a mail genuinely came from the bank.
 *
 * Two independent things have to hold. The From address has to be the one we
 * expect, and the mail has to carry `dkim=pass` for that address's own domain in
 * an Authentication-Results header the receiving server wrote. The first alone is
 * worthless — it is attacker-controlled text. The second is what makes it mean
 * something: only the holder of the domain's private key can produce a signature
 * that verifies against the key published in its DNS.
 *
 * The header being read is the one your mail provider stamped on delivery, which
 * is trustworthy only because the connection to it is authenticated and it is the
 * one that wrote it. If this ever moves to a mail store that does not verify DKIM
 * itself, this function is the thing to rewrite, not the thing to delete.
 */
export function senderIsAuthentic(headers, expectedSender = config.imap.sender) {
  const from = String(headers.from || '').toLowerCase();
  const expected = String(expectedSender || '').toLowerCase();
  const expectedDomain = domainOf(expected);
  const problems = [];

  if (!from.includes(expected)) {
    problems.push(`From is ${from.slice(0, 80) || '(missing)'}, expected ${expected}`);
  }

  // There can be several of these, one per hop. Any one passing for the right
  // domain is enough; none passing is a refusal.
  const lines = []
    .concat(headers['authentication-results'] || [])
    .map((line) => String(line).toLowerCase().replace(/\s+/g, ' '));

  const dkimPassedForDomain = lines.some((line) =>
    [...line.matchAll(/dkim=pass[^;]*/g)].some((m) => {
      const d = /header\.(?:d|i)=@?([a-z0-9.-]+)/.exec(m[0]);
      return d ? domainMatches(d[1], expectedDomain) : false;
    }),
  );

  if (!dkimPassedForDomain) {
    problems.push(
      lines.length
        ? `no dkim=pass for ${expectedDomain} in Authentication-Results`
        : 'no Authentication-Results header at all — cannot verify the sender',
    );
  }

  return { ok: problems.length === 0, problems };
}

/* ---------------------------------- matching ------------------------------ */

/**
 * Finds the single order a credit belongs to among the orders still holding an
 * amount, or explains why it found none.
 *
 * Order of preference is amount first, reference second — the opposite of what
 * looks natural. The amount is the thing we control and made unique on purpose;
 * the reference is a courtesy field that UPI apps and banks are free to truncate,
 * re-encode or drop. A match on both must be consistent: if the amount points at
 * order A and the reference at order B, that is not a near-miss to resolve by
 * picking one — it means an assumption is broken, and the honest response is to
 * settle nothing and say so.
 *
 * `holding` is the list of orders currently eligible to be settled — the caller
 * (the gateway) has already dropped anything outside its payment window.
 */
export function matchCredit(credit, holding, now = Date.now()) {
  const candidates = holding.filter((order) => {
    // The credit cannot predate the intent it is supposed to be paying.
    if (credit.at && order.setAt && credit.at < order.setAt - 5 * 60 * 1000) return false;
    return true;
  });

  const byAmount = candidates.filter((o) => o.amountPaise === credit.amountPaise);
  const byReference = credit.reference
    ? candidates.filter((o) => o.reference === credit.reference)
    : [];

  if (byReference.length === 1 && byAmount.length === 1 && byReference[0] !== byAmount[0]) {
    return {
      order: null,
      reason:
        `amount ${displayAmount(credit.amountPaise)} points at ${byAmount[0].id} but reference ` +
        `${credit.reference} points at ${byReference[0].id} — refusing to guess`,
    };
  }
  if (byAmount.length === 1) return { order: byAmount[0], matchedOn: 'amount' };
  if (byAmount.length > 1) {
    return {
      order: null,
      reason: `${byAmount.length} orders are holding ${displayAmount(credit.amountPaise)} — the amounts should have been unique`,
    };
  }
  if (byReference.length === 1) return { order: byReference[0], matchedOn: 'reference' };

  return {
    order: null,
    reason: `no pending order is waiting for ${displayAmount(credit.amountPaise)}`,
  };
}

/* --------------------------------- settling ------------------------------- */

/**
 * The one place a payment is judged. Returns a decision; it does not act on it.
 *
 * Every check that could reject the mail runs here. The caller marks the message
 * seen only on a *successful* settlement — a mail rejected for a bad signature is
 * not burned, because the reason it failed might be a bug rather than an attack,
 * and a fixed bug should be able to re-read it.
 *
 * @param parsed  one message from `mailbox.parseMessage`
 * @param holding orders currently eligible to be settled
 * @param expectedSender the address the bank alerts come from
 * @param isSettled (messageId) => boolean — the replay guard
 */
export function settlePayment(parsed, { holding, expectedSender = config.imap.sender, isSettled } = {}) {
  const { headers = {}, credit = null, messageId = '' } = parsed || {};

  if (!credit) return { settled: false, reason: 'not a credit notification' };
  if (credit.direction !== 'in') {
    return { settled: false, reason: `${credit.direction} — money going out, not a customer payment` };
  }
  if (!credit.amountPaise) return { settled: false, reason: 'no amount could be read' };

  if (!messageId) return { settled: false, reason: 'mail has no Message-Id — the replay guard cannot hold' };
  if (isSettled && isSettled(messageId)) {
    return { settled: false, reason: 'already settled by an earlier scan' };
  }

  const auth = senderIsAuthentic(headers, expectedSender);
  if (!auth.ok) {
    return { settled: false, suspicious: true, reason: `sender not authentic: ${auth.problems.join('; ')}` };
  }

  const match = matchCredit(credit, holding || []);
  if (!match.order) return { settled: false, reason: match.reason };

  return {
    settled: true,
    order: match.order,
    matchedOn: match.matchedOn,
    amountPaise: credit.amountPaise,
    bankRef: credit.bankRef || '',
    messageId,
  };
}

/** Human-readable one-liner for a notification or the log. */
export const describeSettlement = (result) =>
  result.settled
    ? `${result.order.id} paid ${displayAmount(result.amountPaise)} (matched on ${result.matchedOn})`
    : `ignored: ${result.reason}`;
