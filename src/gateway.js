/**
 * The gateway: everything wired together behind one small object.
 *
 * It joins the four pieces that each know nothing about the others —
 *
 *   upi.js       builds the request string + the unique amount
 *   mailbox.js   reads the bank alerts out of Gmail
 *   payments.js  decides which alert pays which order
 *   your store   remembers the orders and the mails already acted on
 *
 * — and adds the two things that need state: a payment window (an order owns its
 * amount for a while, then releases it) and a poller (look at the inbox on a
 * timer, but only while something is actually waiting to be paid).
 *
 *   const gw = createGateway({ store, async onPaid(intent, info) { ...ship it... } });
 *   const { intent, qrSvg } = gw.createIntent({ id: order.id, priceRupees: 499 });
 *   gw.start();   // begins watching the inbox; a no-op if IMAP is not configured
 */

import { config, autoConfirmEnabled, SERVERLESS } from './config.js';
import {
  buildUpiUri,
  displayAmount,
  makeReference,
  pickAmount,
  toPaise,
} from './upi.js';
import { toSvg } from './qr.js';
import { scan } from './mailbox.js';
import { settlePayment, describeSettlement } from './payments.js';

const EVERY_MS = 15000;
const BACKOFF_START_MS = 30000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;

export function createGateway({
  store,
  onPaid = async () => {},
  onSuspicious = null,
  log = console,
} = {}) {
  if (!store) throw new Error('createGateway needs a { store } — see src/store.js for the contract.');

  let timer = null;
  let running = false;
  let backoffMs = 0;
  let failures = 0;
  let lastError = '';
  let warnedSuspicious = false;
  const stats = { scans: 0, settled: 0, lastScanAt: null, lastSettledAt: null };

  /* ------------------------------ the window ------------------------------ */

  // True while an order can still legitimately be settled by an incoming credit.
  const stillHolding = (intent, now) =>
    intent.status === 'holding' && now <= (intent.expiresAt || now) + config.graceMs;

  // Orders eligible to be matched right now.
  const holding = (now = Date.now()) => store.open().filter((i) => stillHolding(i, now));

  // Amounts currently spoken for, so two live orders never get the same figure.
  const reservedAmounts = (exceptId = null) => {
    const now = Date.now();
    const taken = new Set();
    for (const intent of holding(now)) {
      if (intent.id === exceptId) continue;
      taken.add(intent.amountPaise);
    }
    return taken;
  };

  const awaitingPayment = () => holding().length > 0;

  /* ---------------------------- creating intents -------------------------- */

  /**
   * Reserves a unique amount for an order and builds its payment instrument.
   * Idempotent: an order that already holds an intent keeps it, because
   * re-rolling the amount mid-window would orphan a payment already started.
   *
   * @returns { ok, intent, qrSvg } or { ok:false, error }
   */
  function createIntent({ id, priceRupees }) {
    if (!id) return { ok: false, error: 'createIntent needs an { id }.' };

    const existing = store.get(id);
    if (existing && existing.amountPaise && existing.upiUri) {
      return { ok: true, reused: true, intent: existing, qrSvg: toSvg(existing.upiUri) };
    }
    if (!config.upi.id || !config.upi.payee) {
      return { ok: false, error: 'No UPI id is configured on the server.' };
    }

    const chosen = pickAmount(priceRupees, reservedAmounts(id));
    if (chosen.error) return { ok: false, error: chosen.error };

    const reference = makeReference(config.upi.refPrefix);
    let upiUri;
    try {
      upiUri = buildUpiUri({
        upiId: config.upi.id,
        payeeName: config.upi.payee,
        amountPaise: chosen.amountPaise,
        note: reference,
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }

    const now = Date.now();
    const intent = {
      id,
      priceRupees,
      status: 'holding',
      upiId: config.upi.id,
      payee: config.upi.payee,
      reference,
      amountPaise: chosen.amountPaise,
      listedPaise: chosen.listedPaise,
      upiUri,
      setAt: now,
      expiresAt: now + config.paymentWindowMs,
    };
    store.reserve(intent);
    return { ok: true, reused: false, intent, qrSvg: toSvg(upiUri) };
  }

  /** The amount to ask for, as a display string. Never the listed price. */
  const amountDue = (intent) => displayAmount(intent?.amountPaise || toPaise(intent?.priceRupees));

  /** An order's QR as SVG, or null if it has no payment instrument yet. */
  const qrSvg = (intent) => (intent?.upiUri ? toSvg(intent.upiUri) : null);

  /* ------------------------------ the poller ------------------------------ */

  /**
   * One pass: read the mailbox, settle whatever matches, fulfil what settled.
   * Returns a small summary rather than throwing — the caller is a timer with
   * nobody to report to. Safe to call by hand for a "check now" button.
   */
  async function verifyOnce({ force = false } = {}) {
    if (!autoConfirmEnabled) return { ok: false, reason: 'automatic confirmation is off' };
    if (running) return { ok: false, reason: 'a scan is already in flight' };
    if (!force && !awaitingPayment()) return { ok: true, skipped: true, settled: 0 };

    running = true;
    try {
      const result = await scan();
      stats.scans += 1;
      stats.lastScanAt = Date.now();

      if (!result.ok) {
        failures += 1;
        if (result.error !== lastError) {
          log.warn?.(`[gateway] mailbox unreachable: ${result.error}`);
          lastError = result.error;
        } else if (failures % 20 === 0) {
          log.warn?.(`[gateway] still failing (${failures}×): ${result.error}`);
        }
        backoffMs = Math.min(backoffMs ? backoffMs * 2 : BACKOFF_START_MS, BACKOFF_MAX_MS);
        return { ok: false, reason: result.error };
      }

      if (failures) log.log?.(`[gateway] mailbox reachable again after ${failures} failure(s)`);
      failures = 0;
      backoffMs = 0;
      lastError = '';

      let settled = 0;
      for (const message of result.messages) {
        const decision = settlePayment(message, {
          holding: holding(),
          expectedSender: config.imap.sender,
          isSettled: (id) => store.isSettled(id),
        });

        if (decision.settled) {
          // Burn the message id and persist the settlement *before* fulfilling,
          // so a crash in fulfilment can never double-pay on the next scan.
          store.rememberSettled(decision.messageId);
          const info = {
            amountPaise: decision.amountPaise,
            matchedOn: decision.matchedOn,
            bankRef: decision.bankRef,
            messageId: decision.messageId,
            verifiedAt: Date.now(),
          };
          const intent = store.markPaid(decision.order.id, info) || decision.order;
          settled += 1;
          stats.settled += 1;
          stats.lastSettledAt = Date.now();
          log.log?.(`[gateway] ${describeSettlement(decision)}`);
          try {
            await onPaid(intent, info);
          } catch (err) {
            // The order is already marked paid; only the fulfilment hook threw.
            log.warn?.(`[gateway] ${intent.id} settled but onPaid() failed: ${err.message}`);
          }
          continue;
        }

        if (decision.suspicious && !warnedSuspicious) {
          warnedSuspicious = true;
          log.warn?.(`[gateway] REJECTED an unauthentic mail: ${decision.reason}`);
          log.warn?.('[gateway] further rejections this run will not be repeated here.');
          if (onSuspicious) {
            try {
              await onSuspicious(decision);
            } catch { /* advisory only */ }
          }
        }
      }

      return { ok: true, scanned: result.messages.length, settled };
    } catch (err) {
      log.error?.(`[gateway] unexpected failure: ${err.stack || err.message}`);
      return { ok: false, reason: err.message };
    } finally {
      running = false;
    }
  }

  /**
   * Starts the poll loop. A no-op unless automatic confirmation is configured, so
   * it is safe to call unconditionally.
   */
  function start() {
    if (timer) return timer;
    if (!autoConfirmEnabled) return null; // config.js has already said what is missing
    if (SERVERLESS) {
      log.warn?.('[gateway] serverless host — the mail poller cannot run here; settle orders manually.');
      return null;
    }

    log.log?.(
      `[gateway] watching ${config.imap.user} for mail from ${config.imap.sender} every ${EVERY_MS / 1000}s.`,
    );

    // Self-rescheduling timeout, not setInterval: the delay changes when the
    // mailbox is failing, and the gap is measured from the end of a scan so a
    // slow IMAP server can never queue overlapping runs.
    const tick = async () => {
      await verifyOnce();
      timer = setTimeout(tick, backoffMs || EVERY_MS);
      if (timer.unref) timer.unref();
    };
    timer = setTimeout(tick, 2000);
    if (timer.unref) timer.unref();
    return timer;
  }

  function stop() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  const status = () => ({
    on: Boolean(timer),
    autoConfirm: autoConfirmEnabled,
    scans: stats.scans,
    settled: stats.settled,
    lastScanAt: stats.lastScanAt,
    lastSettledAt: stats.lastSettledAt,
    failing: failures ? { count: failures, error: lastError, nextTryInMs: backoffMs } : null,
  });

  return {
    createIntent,
    amountDue,
    qrSvg,
    verifyOnce,
    start,
    stop,
    status,
    // Exposed for tests and for building a custom scheduler.
    _internals: { holding, reservedAmounts, awaitingPayment, stillHolding },
  };
}
