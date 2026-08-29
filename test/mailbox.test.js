/*
 * Tests for the mail reader.
 *
 *   node test/mailbox.test.js
 *
 * Most cases use synthetic fixtures built to FamApp's header shape, so they run
 * anywhere. A handful are checked against samples/famapp-received.example.eml —
 * the sanitised sample that ships with the repo — because the whole risk in this
 * module is guessing the wording wrong.
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { parseMessage, internals } from '../src/mailbox.js';
import { senderIsAuthentic } from '../src/payments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(here, '..', 'samples', 'famapp-received.example.eml');

let pass = 0, fail = 0, skip = 0;
function test(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (err) { fail += 1; console.log(`  FAIL ${name}`); console.log(`       ${err.message.split('\n').slice(0, 3).join('\n       ')}`); }
}

/** Builds a multipart/alternative message with FamApp's own header shape. */
function build({ subject, plain, html, encoding = '7bit', messageId = '<abc@ap-south-1.amazonses.com>', date = 'Thu, 27 Aug 2026 12:59:13 +0000', auth = 'dkim=pass header.i=@famapp.in header.b=WEeY8ssv;' } = {}) {
  const b = '----=_Part_1';
  const body = (t) => (encoding === 'base64' ? Buffer.from(t, 'utf8').toString('base64') : t);
  const parts = [];
  if (plain !== undefined) parts.push(`--${b}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n${body(plain)}\r\n`);
  if (html !== undefined) parts.push(`--${b}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n${body(html)}\r\n`);
  return (
    `Date: ${date}\r\nFrom: FamApp <no-reply@famapp.in>\r\nTo: someone@example.com\r\n` +
    `Subject: ${subject}\r\nAuthentication-Results: mx.google.com;\r\n       ${auth}\r\n` +
    `MIME-Version: 1.0\r\nContent-Type: multipart/alternative; \r\n\tboundary="${b}"\r\n` +
    `Message-ID: ${messageId}\r\n\r\n` + parts.join('') + `--${b}--\r\n`
  );
}

/* ------------------------------ the sample -------------------------------- */

console.log('\nsanitised sample (samples/famapp-received.example.eml)');
if (!fs.existsSync(SAMPLE)) {
  skip += 1; console.log('  skip sample-backed tests — example file not present');
} else {
  const m = parseMessage(fs.readFileSync(SAMPLE));

  test('RFC 2047 subject decodes to a real rupee sign', () => assert.equal(m.subject, 'You received ₹1.07 in your FamX account'));
  test('quoted-printable text/plain decodes', () => assert.match(m.text, /You have successfully received ₹1\.07/));
  test('direction is a credit', () => assert.equal(m.credit.direction, 'in'));
  test('₹1.07 reads as 107 paise', () => assert.equal(m.credit.amountPaise, 107));
  test('the ₹9.99 balance is not mistaken for the amount', () => assert.notEqual(m.credit.amountPaise, 999));
  test('UTR is captured as the bank reference', () => assert.equal(m.credit.bankRef, '999999999999'));
  test('Message-Id is read and the angle brackets stripped', () => assert.match(m.messageId, /@ap-south-1\.amazonses\.com$/));
  test('two DKIM-Signature headers are kept as an array', () => assert.equal([].concat(m.headers['dkim-signature']).length, 2));
  test('payments.js accepts the sample as authentic', () => {
    const v = senderIsAuthentic(m.headers);
    assert.deepEqual(v.problems, []);
    assert.equal(v.ok, true);
  });
}

/* ----------------------------- amount formats ----------------------------- */

console.log('\namount formats a bank alert can emit');
for (const [printed, paise] of [['₹1.0', 100], ['₹1.07', 107], ['₹5498.78', 549878], ['₹5498.7', 549870], ['₹5,498.78', 549878], ['₹5499', 549900], ['Rs. 499.5', 49950], ['INR 250.25', 25025]]) {
  test(`"received ${printed}" → ${paise} paise`, () => {
    const m = parseMessage(build({ subject: `You received ${printed} in your FamX account`, plain: `You have successfully received ${printed} from Someone. Your updated balance is ₹99999.0.` }));
    assert.equal(m.credit.amountPaise, paise);
  });
}

/* -------------------------------- direction ------------------------------- */

console.log('\ndirection');
test('"Purpose: Paid via CRED" inside a credit does not make it a debit', () => {
  const m = parseMessage(build({ subject: 'You received ₹1.0 in your FamX account', plain: 'You have successfully received ₹1.0 from X. UTR: 1. Purpose: Paid via CRED.' }));
  assert.equal(m.credit.direction, 'in');
});
test('a real debit is read as going out', () => {
  const m = parseMessage(build({ subject: 'You paid ₹500.0 from your FamX account', plain: 'You have successfully paid ₹500.0 to Someone. UTR: 2.' }));
  assert.equal(m.credit.direction, 'out');
});
test('a mail about no money at all yields no credit', () => {
  assert.equal(parseMessage(build({ subject: 'Your card is ready', plain: 'Tap to activate.' })).credit, null);
});
test('a credit with no readable amount yields no credit rather than a zero', () => {
  assert.equal(parseMessage(build({ subject: 'You received money', plain: 'You have successfully received some money.' })).credit, null);
});

/* ----------------------------------- MIME --------------------------------- */

console.log('\nMIME handling');
test('base64 parts decode', () => {
  const m = parseMessage(build({ subject: 'You received ₹12.34 in your FamX account', plain: 'You have successfully received ₹12.34 from X. UTR: 7788990011.', encoding: 'base64' }));
  assert.equal(m.credit.amountPaise, 1234);
  assert.equal(m.credit.bankRef, '7788990011');
});
test('HTML-only mail still yields the amount', () => {
  const m = parseMessage(build({ subject: 'You received ₹9.99 in your FamX account', html: '<p>You have successfully received <b>₹9.99</b> from X.</p>' }));
  assert.equal(m.credit.amountPaise, 999);
});
test('a subject with no encoded word is left alone', () => assert.equal(internals.decodeWords('Plain subject'), 'Plain subject'));
test('base64 encoded word in a header decodes', () => {
  const e = `=?UTF-8?B?${Buffer.from('You received ₹3.5', 'utf8').toString('base64')}?=`;
  assert.equal(internals.decodeWords(e), 'You received ₹3.5');
});
test('adjacent encoded words join without a stray space', () => assert.equal(internals.decodeWords('=?UTF-8?Q?You_?= =?UTF-8?Q?paid?='), 'You paid'));

/* ------------------------------ IMAP framing ------------------------------ */

console.log('\nIMAP response framing');
test('a tagged line is found once complete', () => {
  const buf = Buffer.from('* 1 EXISTS\r\na1 OK done\r\n', 'binary');
  const hit = internals.findEnd(buf, 'a1');
  assert.equal(hit.end, buf.length);
  assert.equal(hit.line, 'a1 OK done');
});
test('an incomplete response reports that more bytes are needed', () => assert.equal(internals.findEnd(Buffer.from('* 1 EXI', 'binary'), 'a1'), null));
test('a literal is stepped over, not parsed', () => {
  const body = 'Subject: x\r\na1 OK done\r\nreal body\r\n';
  const raw = `* 1 FETCH (BODY[] {${body.length}}\r\n${body})\r\na1 OK FETCH complete\r\n`;
  assert.equal(internals.findEnd(Buffer.from(raw, 'binary'), 'a1').line, 'a1 OK FETCH complete');
  assert.equal(internals.firstLiteral(Buffer.from(raw, 'binary')).toString('binary'), body);
});
test('a literal whose bytes have not all arrived is not treated as complete', () => assert.equal(internals.findEnd(Buffer.from('* 1 FETCH (BODY[] {40}\r\nonly a few bytes', 'binary'), 'a1'), null));
test('SEARCH uids are parsed, and an empty result is empty', () => {
  assert.deepEqual(internals.searchUids(Buffer.from('* SEARCH 4 7 91\r\na1 OK\r\n')), [4, 7, 91]);
  assert.deepEqual(internals.searchUids(Buffer.from('* SEARCH\r\na1 OK\r\n')), []);
});
test('IMAP SINCE date is formatted the one way the protocol accepts', () => assert.equal(internals.imapDate(Date.parse('2026-08-27T12:00:00Z')), '27-Aug-2026'));

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
process.exit(fail ? 1 : 0);
