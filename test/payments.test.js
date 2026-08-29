/**
 * Tests for the parts that decide whether a payment is real.
 *
 *   node test/payments.test.js
 *
 * No framework — the toolkit has zero dependencies and so does its test suite.
 * The cases that matter are the refusals: a false accept here hands somebody a
 * paid product for free.
 */

import assert from 'node:assert/strict';
import { senderIsAuthentic, matchCredit, settlePayment } from '../src/payments.js';
import { pickAmount, formatAmount } from '../src/upi.js';
import { createGateway } from '../src/gateway.js';
import { MemoryStore } from '../src/store.js';

const SENDER = 'no-reply@famapp.in';
const GOOD_AUTH =
  'mx.google.com; dkim=pass header.i=@famapp.in header.s=s1 header.b=AbCd; ' +
  'spf=pass (google.com: domain of no-reply@famapp.in designates 1.2.3.4) ' +
  'smtp.mailfrom=no-reply@famapp.in; dmarc=pass (p=REJECT) header.from=famapp.in';

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass += 1; }
  catch (err) { fails.push(`${name}\n    ${err.message.split('\n')[0]}`); }
}

/* ------------------------------ sender checks ----------------------------- */

check('accepts a mail with dkim=pass for the sender domain', () => {
  const r = senderIsAuthentic({ from: 'FamApp <no-reply@famapp.in>', 'authentication-results': [GOOD_AUTH] }, SENDER);
  assert.equal(r.ok, true, r.problems.join('; '));
});

check('rejects a mail with no Authentication-Results at all', () => {
  const r = senderIsAuthentic({ from: 'FamApp <no-reply@famapp.in>' }, SENDER);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /cannot verify the sender/);
});

check('rejects dkim=fail even when From looks right', () => {
  const r = senderIsAuthentic({ from: 'no-reply@famapp.in', 'authentication-results': ['mx; dkim=fail header.i=@famapp.in'] }, SENDER);
  assert.equal(r.ok, false);
});

check('rejects dkim=pass signed by somebody else', () => {
  const r = senderIsAuthentic({ from: 'no-reply@famapp.in', 'authentication-results': ['mx; dkim=pass header.i=@attacker.example'] }, SENDER);
  assert.equal(r.ok, false);
});

check('rejects a lookalike domain that merely ends with the real one', () => {
  const r = senderIsAuthentic({ from: 'no-reply@notfamapp.in', 'authentication-results': ['mx; dkim=pass header.i=@notfamapp.in'] }, SENDER);
  assert.equal(r.ok, false, 'notfamapp.in must not pass as famapp.in');
});

check('accepts a legitimate subdomain signature', () => {
  const r = senderIsAuthentic({ from: 'no-reply@famapp.in', 'authentication-results': ['mx; dkim=pass header.i=@mail.famapp.in'] }, SENDER);
  assert.equal(r.ok, true, r.problems.join('; '));
});

check('rejects a forged From even with a valid signature from our own domain', () => {
  const r = senderIsAuthentic({ from: 'payments@evil.example', 'authentication-results': [GOOD_AUTH] }, SENDER);
  assert.equal(r.ok, false);
});

/* --------------------------------- matching -------------------------------- */

const intent = (id, amountPaise, reference, extra = {}) => ({
  id, amountPaise, reference, status: 'holding',
  setAt: Date.now() - 60_000, expiresAt: Date.now() + 10 * 60_000, ...extra,
});

check('matches the one order holding that exact amount', () => {
  const holding = [intent('A', 49912, 'PAY-20260828-AAAAAA'), intent('B', 49937, 'PAY-20260828-BBBBBB')];
  const m = matchCredit({ amountPaise: 49937, at: Date.now() }, holding);
  assert.equal(m.order?.id, 'B');
  assert.equal(m.matchedOn, 'amount');
});

check('two customers at the same price do not cross-settle', () => {
  const holding = [intent('A', 49912, 'PAY-x-A'), intent('B', 49937, 'PAY-x-B')];
  assert.equal(matchCredit({ amountPaise: 49912, at: Date.now() }, holding).order?.id, 'A');
  assert.equal(matchCredit({ amountPaise: 49937, at: Date.now() }, holding).order?.id, 'B');
});

check('an amount nobody is waiting for settles nothing', () => {
  const m = matchCredit({ amountPaise: 120000, at: Date.now() }, [intent('A', 49912, 'PAY-x-A')]);
  assert.equal(m.order, null);
  assert.match(m.reason, /no pending order/);
});

check('falls back to the reference when the amount does not match', () => {
  const m = matchCredit({ amountPaise: 49900, reference: 'PAY-x-A', at: Date.now() }, [intent('A', 49912, 'PAY-x-A')]);
  assert.equal(m.order?.id, 'A');
  assert.equal(m.matchedOn, 'reference');
});

check('refuses to guess when amount and reference disagree', () => {
  const holding = [intent('A', 49912, 'PAY-x-A'), intent('B', 49937, 'PAY-x-B')];
  const m = matchCredit({ amountPaise: 49912, reference: 'PAY-x-B', at: Date.now() }, holding);
  assert.equal(m.order, null);
  assert.match(m.reason, /refusing to guess/);
});

check('ignores a credit that predates the intent', () => {
  const m = matchCredit({ amountPaise: 49912, at: Date.now() - 60 * 60 * 1000 }, [intent('A', 49912, 'PAY-x-A', { setAt: Date.now() })]);
  assert.equal(m.order, null);
});

/* -------------------------------- settling --------------------------------- */

const mail = (over = {}) => ({
  messageId: '<abc123@mail.famapp.in>',
  headers: { from: 'FamApp <no-reply@famapp.in>', 'authentication-results': [GOOD_AUTH] },
  credit: { direction: 'in', amountPaise: 49912, reference: 'PAY-x-A', at: Date.now() },
  ...over,
});

check('settles a genuine credit, and the replay guard blocks the re-read', () => {
  const holding = [intent('A', 49912, 'PAY-x-A')];
  const seen = new Set();
  const isSettled = (id) => seen.has(id);

  const first = settlePayment(mail(), { holding, expectedSender: SENDER, isSettled });
  assert.equal(first.settled, true, first.reason);
  assert.equal(first.order.id, 'A');
  seen.add(first.messageId); // the gateway would rememberSettled() here

  const second = settlePayment(mail(), { holding, expectedSender: SENDER, isSettled });
  assert.equal(second.settled, false);
  assert.match(second.reason, /already settled/);
});

check('refuses a debit — our own spending is not a customer payment', () => {
  const r = settlePayment(mail({ credit: { direction: 'out', amountPaise: 49912, at: Date.now() } }), { holding: [intent('A', 49912, 'PAY-x-A')], expectedSender: SENDER });
  assert.equal(r.settled, false);
  assert.match(r.reason, /money going out/);
});

check('refuses an unsigned mail and flags it as suspicious', () => {
  const r = settlePayment(mail({ headers: { from: 'no-reply@famapp.in' } }), { holding: [intent('A', 49912, 'PAY-x-A')], expectedSender: SENDER });
  assert.equal(r.settled, false);
  assert.equal(r.suspicious, true);
});

check('refuses a mail with no Message-Id, since the replay guard cannot hold', () => {
  const r = settlePayment(mail({ messageId: '' }), { holding: [intent('A', 49912, 'PAY-x-A')], expectedSender: SENDER });
  assert.equal(r.settled, false);
  assert.match(r.reason, /Message-Id/);
});

/* ------------------------- the reserved amount ---------------------------- */

check('the quoted figure round-trips through the string a UPI app receives', () => {
  for (const price of [1, 1.5, 2, 199, 499, 5499, 12999]) {
    for (let i = 0; i < 25; i += 1) {
      const got = pickAmount(price);
      assert.equal(got.error, undefined, got.error);
      assert.equal(Math.round(Number(formatAmount(got.amountPaise)) * 100), got.amountPaise);
    }
  }
});

check('a price of ₹499 is never quoted above ₹499', () => {
  for (let i = 0; i < 50; i += 1) {
    const { amountPaise } = pickAmount(499);
    assert.ok(amountPaise < 49900, `${amountPaise} should be below the listed price`);
    assert.ok(amountPaise >= 49801, `${amountPaise} should stay within a rupee`);
  }
});

check('a ₹1 price goes above the listed price, because UPI refuses under ₹1', () => {
  const { amountPaise } = pickAmount(1);
  assert.ok(amountPaise >= 101 && amountPaise <= 199, String(amountPaise));
});

check('every slot on one price is distinct, and the overflow is refused not guessed', () => {
  const taken = new Set();
  for (let i = 0; i < 99; i += 1) {
    const got = pickAmount(499, taken);
    assert.equal(got.error, undefined, `slot ${i}: ${got.error}`);
    assert.equal(taken.has(got.amountPaise), false, 'the same amount was handed out twice');
    taken.add(got.amountPaise);
  }
  assert.match(pickAmount(499, taken).error, /Too many payments in progress/);
});

/* ------------------------- the gateway, end to end ------------------------ */

check('createIntent reserves a unique amount and is idempotent per order', () => {
  process.env.UPI_ID = process.env.UPI_ID || 'demo@upi';
  process.env.UPI_PAYEE_NAME = process.env.UPI_PAYEE_NAME || 'Demo';
  const gw = createGateway({ store: new MemoryStore() });
  const a = gw.createIntent({ id: 'O1', priceRupees: 499 });
  const b = gw.createIntent({ id: 'O2', priceRupees: 499 });
  assert.equal(a.ok && b.ok, true, a.error || b.error);
  assert.notEqual(a.intent.amountPaise, b.intent.amountPaise, 'two live orders must never share a figure');
  const again = gw.createIntent({ id: 'O1', priceRupees: 499 });
  assert.equal(again.intent.amountPaise, a.intent.amountPaise, 're-quoting an order must not re-roll it');
  assert.ok(a.qrSvg.startsWith('<svg'), 'a QR should be produced');
});

/* ---------------------------------- report --------------------------------- */

console.log(`payments: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  FAIL ${f}`);
  process.exitCode = 1;
}
