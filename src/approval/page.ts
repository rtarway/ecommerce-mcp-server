import type { Approval } from "./service.js";

const esc = (s: string | number) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const shell = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${esc(title)}</title><style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}` +
  `table{width:100%;border-collapse:collapse}td,th{padding:.4rem 0;border-bottom:1px solid #ddd;text-align:left}td:last-child,th:last-child{text-align:right}` +
  `.total{font-weight:700}button{font:inherit;padding:.6rem 1.2rem;margin-right:.5rem;border-radius:.4rem;border:1px solid #888;cursor:pointer}` +
  `.go{background:#0a5;color:#fff;border-color:#0a5}.muted{color:#555}</style></head><body>${body}</body></html>`;

export function reviewPage(a: Approval, csrf: string): string {
  const rows = a.summary.items
    .map((i) => `<tr><td>${esc(i.name)} × ${esc(i.quantity)}</td><td>${money(i.quantity * i.unitPriceCents)}</td></tr>`)
    .join("");
  const addr = a.summary.shippingAddress;
  return shell(
    "Approve purchase",
    `<h1>Approve this purchase?</h1>
<p class="muted">An assistant wants to buy the following on your behalf. Nothing is charged unless you approve.</p>
<table><tr><th>Item</th><th>Price</th></tr>${rows}<tr class="total"><td>Total</td><td>${money(a.summary.totalCents)}</td></tr></table>
<p><b>Pay with:</b> ${esc(a.summary.payment.brand)} ending ${esc(a.summary.payment.last4)}<br>
<b>Ship to:</b> ${esc(addr.name)}, ${esc(addr.line1)}, ${esc(addr.city)} ${esc(addr.postalCode)}, ${esc(addr.country)}</p>
<form method="post" action="/approve/decision">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<button class="go" name="decision" value="approve">Approve and pay ${money(a.summary.totalCents)}</button>
<button name="decision" value="deny">Cancel</button>
</form>`,
  );
}

export const messagePage = (title: string, message: string) => shell(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);
