/**
 * The payment screen's behaviour. Plain browser JS, no framework.
 *
 * Flow: create an order → show the amount, QR and UPI id → poll the order's
 * status every few seconds → flip to "paid" the moment the server confirms it.
 */

const $ = (id) => document.getElementById(id);

const startCard = $('startCard');
const payCard = $('payCard');
let poll = null;
let autoConfirm = false;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Learn whether the server has UPI + inbox configured, so the UI can adapt.
(async () => {
  try {
    const cfg = await api('/api/config');
    autoConfirm = cfg.autoConfirm;
    if (cfg.payee) $('payeeSub').textContent = `Pay securely to ${cfg.payee}`;
    if (!cfg.upiConfigured) {
      $('startNote').textContent = 'Server has no UPI id set — see .env.example. A QR still shows so you can see the flow.';
    }
  } catch { /* config is best-effort */ }
})();

$('createBtn').addEventListener('click', async () => {
  $('startNote').textContent = '';
  const priceRupees = Number($('priceInput').value);
  try {
    const order = await api('/api/order', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priceRupees }),
    });
    showPayment(order);
  } catch (err) {
    $('startNote').textContent = err.message;
  }
});

function showPayment(order) {
  startCard.hidden = true;
  payCard.hidden = false;

  $('amountValue').textContent = order.amountDue;
  $('qrBox').innerHTML = order.qrSvg || '';
  $('upiId').textContent = order.upiId;
  $('openApp').href = order.upiUri;

  // The demo button only makes sense when nothing is really watching an inbox.
  $('demoBtn').hidden = autoConfirm;

  $('copyBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(order.upiId);
      $('copyBtn').textContent = 'Copied ✓';
      setTimeout(() => ($('copyBtn').textContent = 'Copy UPI ID'), 1500);
    } catch { /* clipboard may be blocked; the id is on screen anyway */ }
  };

  $('demoBtn').onclick = async () => {
    await api(`/api/order/${encodeURIComponent(order.id)}?simulatePaid=1`);
  };

  $('againBtn').onclick = reset;

  startPolling(order.id);
}

function startPolling(id) {
  stopPolling();
  poll = setInterval(async () => {
    try {
      const s = await api(`/api/order/${encodeURIComponent(id)}`);
      if (s.status === 'paid') {
        stopPolling();
        markPaid();
      }
    } catch { /* transient; keep polling */ }
  }, 3000);
}

function stopPolling() {
  if (poll) clearInterval(poll);
  poll = null;
}

function markPaid() {
  const box = $('statusBox');
  box.classList.remove('waiting');
  box.classList.add('paid');
  box.querySelector('.spinner')?.remove();
  $('statusText').textContent = 'Payment received ✓';
  $('demoBtn').hidden = true;
}

function reset() {
  stopPolling();
  payCard.hidden = true;
  startCard.hidden = false;
  const box = $('statusBox');
  box.classList.add('waiting');
  box.classList.remove('paid');
  if (!box.querySelector('.spinner')) {
    const s = document.createElement('span');
    s.className = 'spinner';
    box.prepend(s);
  }
  $('statusText').textContent = 'Waiting for your payment…';
}
