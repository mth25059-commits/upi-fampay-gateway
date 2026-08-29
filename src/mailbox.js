/*
 * Reads the FamApp payment alerts out of a Gmail inbox.
 *
 * Two layers, deliberately separable:
 *
 *   parseMessage(raw)  — pure. Takes one RFC 822 message and returns the shape
 *                        payments.js wants. Unit-tested against a real saved
 *                        alert in samples/, no network involved.
 *   scan()             — the IMAP conversation. Everything network-shaped lives
 *                        here so the parser can be tested without a mailbox.
 *
 * Why hand-rolled rather than `imapflow` + `mailparser`: those two pull in ~90
 * transitive packages, and this project ships one dependency on a 512 MB VPS.
 * What is actually needed is four IMAP commands and enough MIME to reach a
 * text/plain part — a few hundred lines, and the security-critical decisions
 * (which sender to believe, which order to credit) are not in here at all. They
 * are in payments.js, which this file only feeds.
 *
 * NOT a general-purpose mail library. It handles what Amazon SES sends on
 * FamApp's behalf: multipart/alternative, quoted-printable or base64, UTF-8.
 * It ignores attachments and non-text parts on purpose.
 */

import tls from 'node:tls';
import { config } from './config.js';
import { toPaise, referencePattern } from './upi.js';

/* ------------------------------- MIME decoding ---------------------------- */

/*
 * Everything below works in latin1 ("binary") strings rather than utf8. One
 * latin1 char is exactly one byte, so string offsets stay byte offsets and the
 * original bytes survive intact until a part's real charset is known. Decoding
 * to utf8 too early mangles any header that turns out to be something else.
 */

function nodeCharset(name) {
  const c = String(name || '').toLowerCase().replace(/["']/g, '').trim();
  if (!c || c === 'utf-8' || c === 'utf8' || c === 'us-ascii' || c === 'ascii') return 'utf8';
  if (c === 'iso-8859-1' || c === 'latin1' || c === 'windows-1252') return 'latin1';
  // Anything else (koi8, big5, …) is not something FamApp sends. utf8 is the
  // least-wrong fallback: valid ASCII still reads correctly.
  return 'utf8';
}

function charsetOf(contentType) {
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(String(contentType || ''));
  return nodeCharset(m ? m[1] : 'utf-8');
}

/** Undoes `=E2=82=B9` and soft line breaks. */
function decodeQp(body, charset = 'utf8') {
  const bytes = body
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return Buffer.from(bytes, 'binary').toString(charset);
}

function transferDecode(body, encoding, charset) {
  const enc = String(encoding || '7bit').toLowerCase().trim();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString(charset);
  if (enc === 'quoted-printable') return decodeQp(body, charset);
  return Buffer.from(body, 'binary').toString(charset);
}

/*
 * RFC 2047 encoded words — `=?UTF-8?Q?You_received_=E2=82=B91.0?=`. Gmail and
 * SES both use them for any Subject containing a rupee sign, so a parser that
 * skips this step cannot read the amount out of the subject line at all.
 */
function decodeWords(value) {
  return String(value)
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (all, charset, enc, text) => {
      try {
        const bytes =
          enc.toLowerCase() === 'b'
            ? Buffer.from(text, 'base64')
            : Buffer.from(
                text
                  .replace(/_/g, ' ')
                  .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
                'binary',
              );
        return bytes.toString(nodeCharset(charset));
      } catch {
        return all;
      }
    });
}

/**
 * Header block to a lookup.
 *
 * A key that appeared once is stored as a string, a key that repeated as an
 * array. That is not tidiness — `payments.js` reads `headers.from` as a scalar
 * and `headers['authentication-results']` through `[].concat(...)`, because a
 * mail relayed through several hops carries one Authentication-Results per hop
 * and any one of them passing is enough.
 */
function parseHeaders(block) {
  const out = {};
  // Unfold first: a continuation line starts with space or tab and belongs to
  // whatever came before it. Long DKIM signatures are always folded.
  const lines = block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  for (const line of lines) {
    const at = line.indexOf(':');
    if (at < 1) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (out[key] === undefined) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  }
  return out;
}

function splitOnce(text) {
  const at = text.search(/\r?\n\r?\n/);
  if (at === -1) return [text, ''];
  return [text.slice(0, at), text.slice(at).replace(/^\r?\n\r?\n/, '')];
}

/**
 * Collects every text/* part, depth-first, skipping attachments.
 *
 * Both halves of a multipart/alternative are kept. text/plain is what the credit
 * parser wants, but FamApp could drop it in future and the HTML carries the same
 * sentence — so the caller falls back rather than failing.
 */
function walkParts(headerBlock, body, out = []) {
  const h = parseHeaders(headerBlock);
  const ctype = String(h['content-type'] || 'text/plain');
  const disposition = String(h['content-disposition'] || '');

  if (/^\s*multipart\//i.test(ctype)) {
    const b = /boundary\s*=\s*"?([^";]+)"?/i.exec(ctype);
    if (!b) return out;
    const chunks = body.split(`--${b[1]}`);
    // chunks[0] is the preamble; a chunk starting with "--" is the closing
    // delimiter and everything after it is epilogue.
    for (const chunk of chunks.slice(1)) {
      if (chunk.startsWith('--')) break;
      const [ph, pb] = splitOnce(chunk.replace(/^\r?\n/, ''));
      walkParts(ph, pb, out);
    }
    return out;
  }

  if (/attachment/i.test(disposition)) return out;
  if (!/^\s*text\//i.test(ctype)) return out;

  out.push({
    type: ctype.split(';')[0].trim().toLowerCase(),
    text: transferDecode(body, h['content-transfer-encoding'], charsetOf(ctype)),
  });
  return out;
}

/* ----------------------------- the credit parser -------------------------- */

/*
 * FamApp's own wording (names and ids replaced with placeholders — see
 * samples/famapp-received.example.eml for the sanitised sample this is built on):
 *
 *   Subject: You received ₹1.0 in your FamX account
 *   Body:    Hey <you>, You have successfully received ₹1.0 from <payer>
 *            at 06:29 PM IST, 27 August 2026 with transaction id
 *            FMPIB0000000000. Your updated balance is ₹2.0. UTR: 000000000000.
 *            Purpose: Paid via CRED.
 *
 * Three things in that one sentence shaped the regexes below.
 *
 * 1. `₹1.0` — ONE decimal place. The amount is printed by something that
 *    stringifies a float, so ₹1 arrives as "1.0", ₹1.07 as "1.07", and ₹5498.70
 *    would arrive as "5498.7". A `\d{2}` fraction would silently miss two of
 *    those three, which on this design means the paise that identify the order
 *    are lost. Hence `\.\d{1,2}`.
 *
 * 2. "Purpose: **Paid** via CRED" sits inside a *credit* notification. Testing
 *    for the bare word "paid" to detect money going out would classify this very
 *    mail as a debit. Both directions therefore anchor on "you <verb>".
 *
 * 3. "Your updated balance is ₹2.0" is a second rupee figure in the same
 *    sentence, and it is larger than the credit. Matching the first ₹ in the
 *    body would have credited the wrong order the moment the wallet held any
 *    balance at all — so the amount is only read immediately after "received".
 */

const MONEY = String.raw`(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)`;

const RECEIVED = new RegExp(String.raw`received\s*${MONEY}`, 'i');
const IS_CREDIT = /you\s+(?:have\s+successfully\s+)?received\b/i;
const IS_DEBIT = /you\s+(?:have\s+successfully\s+)?(?:paid|sent|transferred|spent)\b/i;

function amountFrom(text) {
  const m = RECEIVED.exec(text);
  if (!m) return 0;
  const paise = toPaise(m[1].replace(/,/g, ''));
  return Number.isFinite(paise) && paise > 0 ? paise : 0;
}

/**
 * Reads the direction, amount and bank reference out of an alert.
 *
 * Returns null when the mail is not about money at all — a promo or an OTP —
 * which `settlePayment` treats as "not a credit notification" and ignores.
 */
function readCredit({ subject, text, date }) {
  const whole = `${subject}\n${text}`;

  let direction = null;
  if (IS_CREDIT.test(whole)) direction = 'in';
  else if (IS_DEBIT.test(whole)) direction = 'out';
  if (!direction) return null;

  // Subject first: it is one short line containing exactly one figure, so it
  // cannot be confused by a balance or a fee mentioned later in the body.
  const amountPaise = amountFrom(subject) || amountFrom(text);
  if (!amountPaise && direction === 'in') return null;

  const utr = /\bUTR\s*[:\-]?\s*([A-Za-z0-9]{6,})/i.exec(text);
  const txn = /transaction\s*id\s*[:\-]?\s*([A-Za-z0-9]{6,})/i.exec(text);

  /*
   * The payment note is looked for but never relied on. FamApp's alert does not
   * reproduce the UPI `tn` field anywhere — verified against the saved sample —
   * so in practice this is null and matching happens on the unique amount alone.
   * Kept because it costs one regex and would strengthen every match for free if
   * FamApp ever starts including it.
   */
  const ref = referencePattern(config.upi.refPrefix).exec(whole);

  return {
    direction,
    amountPaise,
    reference: ref ? ref[0] : null,
    bankRef: (utr && utr[1]) || (txn && txn[1]) || '',
    at: date || null,
  };
}

/**
 * One raw message to the object `settlePayment` expects.
 *
 * `headers` is passed through untouched because the sender check needs the real
 * Authentication-Results lines, not a cleaned-up summary of them.
 */
export function parseMessage(raw) {
  const source = Buffer.isBuffer(raw) ? raw.toString('binary') : String(raw);
  const [headerBlock, body] = splitOnce(source);
  const headers = parseHeaders(headerBlock);

  const parts = walkParts(headerBlock, body);
  const plain = parts.find((p) => p.type === 'text/plain');
  const html = parts.find((p) => p.type === 'text/html');

  // Tags stripped rather than parsed: the fallback only has to expose the same
  // sentence to the regexes above, not render anything.
  const text = plain
    ? plain.text
    : html
      ? html.text.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
      : '';

  const subject = decodeWords(Array.isArray(headers.subject) ? headers.subject[0] : headers.subject || '');
  const rawId = String(Array.isArray(headers['message-id']) ? headers['message-id'][0] : headers['message-id'] || '');
  const dateValue = Date.parse(String(Array.isArray(headers.date) ? headers.date[0] : headers.date || ''));

  return {
    messageId: rawId.replace(/^<|>$/g, '').trim(),
    headers,
    subject,
    text,
    date: Number.isFinite(dateValue) ? dateValue : null,
    credit: readCredit({ subject, text, date: Number.isFinite(dateValue) ? dateValue : null }),
  };
}

/* -------------------------------- IMAP client ----------------------------- */

/*
 * Just enough of RFC 3501 to ask one question: which alerts have arrived since
 * <date>? Four commands — LOGIN, SELECT, UID SEARCH, UID FETCH — plus LOGOUT.
 *
 * The one part that cannot be simplified is literals. An IMAP server does not
 * escape a message body; it announces `{11147}` and then sends exactly that many
 * raw bytes, which may contain CRLFs and may contain a line that looks exactly
 * like a tagged completion response. Scanning for the tag without honouring the
 * byte count is the classic way these hand-rolled clients truncate mail, so the
 * reader below tracks literals explicitly.
 */

const CRLF = '\r\n';

/** IMAP quoted string — backslash and double quote are the only two escapes. */
const quoted = (s) => `"${String(s).replace(/([\\"])/g, '\\$1')}"`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `28-Aug-2026`, the only date format IMAP SEARCH accepts. */
function imapDate(ms) {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

/**
 * Finds the end of a complete response for `tag`, or reports that more bytes are
 * needed. Returns the byte offset just past the tagged line plus that line
 * itself, so the caller can slice the response out and read its status without
 * re-scanning — a status regex run over "the last 200 bytes" would eventually
 * match a line *inside* a short message body.
 */
function findEnd(buf, tag) {
  const text = buf.toString('binary'); // 1 char === 1 byte, offsets stay valid
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf(CRLF, i);
    if (nl === -1) return null;
    const line = text.slice(i, nl);

    // `... {11147}` at the end of a line means the next N bytes are payload and
    // must be stepped over rather than parsed. The remainder of the logical line
    // continues immediately after them.
    const literal = /\{(\d+)\}$/.exec(line);
    if (literal) {
      const start = nl + CRLF.length;
      const need = Number(literal[1]);
      if (text.length < start + need) return null;
      i = start + need;
      continue;
    }

    i = nl + CRLF.length;
    if (line.startsWith(`${tag} `)) return { end: i, line };
  }
  return null;
}

/**
 * Opens a TLS session and returns `{ send, close }`.
 *
 * Commands are issued one at a time and fully awaited. IMAP does allow pipelining
 * but there is nothing to gain here — one scan is four round trips against a
 * server in the same continent, and serialising it keeps the reader trivial.
 */
function connect({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let waiter = null; // { tag, resolve, reject }
    let failed = null;

    const socket = tls.connect({ host, port, servername: host }, () => {
      socket.setTimeout(timeoutMs);
    });

    const fail = (err) => {
      if (failed) return;
      failed = err instanceof Error ? err : new Error(String(err));
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.reject(failed);
      } else {
        reject(failed);
      }
      socket.destroy();
    };

    const pump = () => {
      if (!waiter) return;
      const hit = findEnd(buffer, waiter.tag);
      if (!hit) return;
      const response = buffer.slice(0, hit.end);
      buffer = buffer.slice(hit.end);
      const w = waiter;
      waiter = null;
      const status = /^\S+ (OK|NO|BAD)\b/i.exec(hit.line);
      if (status && status[1] !== 'OK') {
        // The server's own words are the most useful thing to log — a wrong app
        // password says "Invalid credentials (Failure)" in as many words.
        w.reject(new Error(`IMAP ${status[1]}: ${hit.line.slice(0, 200).trim()}`));
        return;
      }
      w.resolve(response);
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });
    socket.on('error', fail);
    socket.on('timeout', () => fail(new Error(`IMAP timed out after ${timeoutMs}ms`)));
    socket.on('close', () => {
      if (waiter) fail(new Error('IMAP connection closed mid-command'));
    });

    let counter = 0;
    const send = (command) =>
      new Promise((ok, no) => {
        if (failed) return no(failed);
        counter += 1;
        const tag = `a${counter}`;
        waiter = { tag, resolve: ok, reject: no };
        socket.write(`${tag} ${command}${CRLF}`);
        // Bytes for this command may already be sitting in the buffer if the
        // server was quick, and 'data' will not fire again for them.
        pump();
      });

    const close = async () => {
      try {
        await send('LOGOUT');
      } catch {
        /* the session is being torn down either way */
      }
      socket.destroy();
    };

    // The greeting arrives unsolicited and untagged. Wait for it before sending
    // anything, or LOGIN races the server's capability announcement.
    const onGreeting = () => {
      const text = buffer.toString('binary');
      const at = text.indexOf(CRLF);
      if (at === -1) return;
      if (!/^\* (OK|PREAUTH)/i.test(text)) return fail(new Error(`IMAP refused the connection: ${text.slice(0, 120)}`));
      buffer = buffer.slice(at + CRLF.length);
      socket.off('data', onGreeting);
      resolve({ send, close });
    };
    socket.on('data', onGreeting);
  });
}

/** UIDs out of an `* SEARCH 4 7 9` line. */

function searchUids(response) {
  const line = /^\* SEARCH([^\r\n]*)/im.exec(response.toString('binary'));
  if (!line) return [];
  return line[1].trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
}

/** The payload of the first literal in a FETCH response — i.e. the message. */
function firstLiteral(response) {
  const text = response.toString('binary');
  const m = /\{(\d+)\}\r\n/.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  return response.slice(start, start + Number(m[1]));
}

/**
 * One pass over the inbox: every alert from the configured sender inside the
 * lookback window, parsed.
 *
 * Newest last, because the caller settles them in order and two credits for the
 * same amount (which should not happen, but) should be applied oldest first.
 *
 * SEARCH is deliberately narrowed by sender *and* date on the server side. It
 * keeps the fetch small on a 512 MB box, but the sender there is a filter and
 * nothing more — it is not the security check. Anyone can put that address in a
 * From line. `payments.js` re-verifies every message against DKIM before a rupee
 * is believed, and it is that check, not this one, that makes the scan safe.
 */
export async function scan({ sinceMs } = {}) {
  const { host, port, user, pass, mailbox, sender, lookbackHours } = config.imap;
  if (!user || !pass) return { ok: false, error: 'IMAP is not configured', messages: [] };

  const since = sinceMs || Date.now() - lookbackHours * 3600 * 1000;
  let session = null;

  try {
    session = await connect({ host, port, timeoutMs: 20000 });
    await session.send(`LOGIN ${quoted(user)} ${quoted(pass)}`);
    await session.send(`SELECT ${quoted(mailbox)}`);

    // SINCE has whole-day granularity, so this over-fetches by up to a day. That
    // is fine and cannot be tightened: the precise cutoff is enforced later,
    // against each order's own `setAt`, in matchCredit.
    const found = await session.send(`UID SEARCH FROM ${quoted(sender)} SINCE ${imapDate(since)}`);
    const uids = searchUids(found);

    const messages = [];
    for (const uid of uids) {
      // BODY.PEEK[] rather than BODY[]: reading a mail must not mark it \Seen.
      // The owner's own inbox is the audit trail, and a poller that silently
      // marks everything read destroys it. The replay guard is the Message-Id
      // in db.seenPaymentMail, never the \Seen flag.
      const raw = firstLiteral(await session.send(`UID FETCH ${uid} BODY.PEEK[]`));
      if (!raw) continue;
      const parsed = parseMessage(raw);
      if (parsed.date && parsed.date < since) continue;
      messages.push({ uid, ...parsed });
    }

    messages.sort((a, b) => (a.date || 0) - (b.date || 0));
    return { ok: true, messages };
  } catch (err) {
    return { ok: false, error: err.message, messages: [] };
  } finally {
    if (session) await session.close().catch(() => {});
  }
}

/*
 * Exported for mailbox.test.js only. `findEnd` is the piece most likely to be
 * quietly wrong — a literal mishandled by one byte truncates a message instead
 * of throwing — so it is tested directly rather than only through a live
 * mailbox, which no test suite can rely on being reachable.
 */
export const internals = { findEnd, parseHeaders, decodeWords, walkParts, searchUids, firstLiteral, imapDate };
