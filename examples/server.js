/**
 * A tiny, dependency-free demo server showing the whole gateway end to end.
 *
 *   node examples/server.js      then open http://localhost:4400
 *
 * It uses the in-memory store, so orders vanish on restart — that is the point of
 * a demo. Wire your own store and your own "ship the product" code into `onPaid`
 * for the real thing; see the README.
 *
 * With only UPI_ID / UPI_PAYEE_NAME set you get the full payment screen and a live
 * QR. Add IMAP_USER / IMAP_APP_PASSWORD and the page will tick over to "paid" on
 * its own when the bank alert lands. Without them, use the "I paid (demo)" button
 * to simulate a settlement so you can see the flow without real money.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGateway, MemoryStore, config, autoConfirmEnabled } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const PORT = Number(process.env.PORT || 4400);

const store = new MemoryStore();
const gateway = createGateway({
  store,
  // The one hook you replace: this is where a real app emails the licence key,
  // unlocks the download, notifies you on Telegram — whatever "paid" should do.
  async onPaid(intent, info) {
    console.log(`\n  ✅ ${intent.id} is PAID — ship it here. matched on ${info.matchedOn}, bankRef ${info.bankRef || '—'}\n`);
  },
});
gateway.start();

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const send = (res, code, body, type = 'application/json') =>
  res.writeHead(code, { 'content-type': type }).end(body);

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // --- API -----------------------------------------------------------------
  if (url.pathname === '/api/config') {
    return send(res, 200, JSON.stringify({
      upiConfigured: Boolean(config.upi.id && config.upi.payee),
      autoConfirm: autoConfirmEnabled,
      payee: config.upi.payee || null,
    }));
  }

  if (url.pathname === '/api/order' && req.method === 'POST') {
    const { priceRupees } = await readBody(req);
    const price = Number(priceRupees);
    if (!Number.isFinite(price) || price <= 0) return send(res, 400, JSON.stringify({ error: 'Give a price in rupees.' }));
    const id = `DEMO-${Date.now().toString(36).toUpperCase()}`;
    const result = gateway.createIntent({ id, priceRupees: price });
    if (!result.ok) return send(res, 400, JSON.stringify({ error: result.error }));
    const { intent, qrSvg } = result;
    return send(res, 200, JSON.stringify({
      id: intent.id,
      amountDue: gateway.amountDue(intent),
      amountPaise: intent.amountPaise,
      upiId: intent.upiId,
      upiUri: intent.upiUri,
      reference: intent.reference,
      expiresAt: intent.expiresAt,
      qrSvg,
    }));
  }

  if (url.pathname.startsWith('/api/order/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const intent = store.get(id);
    if (!intent) return send(res, 404, JSON.stringify({ error: 'no such order' }));

    // Demo-only shortcut: pretend the bank alert arrived, so the flow can be seen
    // without real money or a configured inbox. Never expose this in production.
    if (url.searchParams.get('simulatePaid') === '1' && intent.status === 'holding') {
      store.markPaid(id, { amountPaise: intent.amountPaise, matchedOn: 'demo', bankRef: 'DEMO', verifiedAt: Date.now() });
      console.log(`\n  ✅ ${id} marked paid via the demo button.\n`);
    }
    return send(res, 200, JSON.stringify({ id: intent.id, status: intent.status, paidInfo: intent.paidInfo || null }));
  }

  // --- static files --------------------------------------------------------
  const file = url.pathname === '/' ? '/pay.html' : url.pathname;
  const full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (full.startsWith(PUBLIC) && fs.existsSync(full) && fs.statSync(full).isFile()) {
    return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
  }
  return send(res, 404, 'Not found', 'text/plain');
});

server.listen(PORT, () => {
  console.log(`\n  UPI FamPay Gateway demo → http://localhost:${PORT}`);
  if (!config.upi.id || !config.upi.payee) {
    console.log('  ⚠  Set UPI_ID and UPI_PAYEE_NAME in .env to get a real QR (see .env.example).');
  }
  if (!autoConfirmEnabled) {
    console.log('  ℹ  IMAP not configured — auto-confirm is off. Use the "I paid (demo)" button.\n');
  } else {
    console.log('  ✓  Watching the inbox — real payments will confirm themselves.\n');
  }
});
