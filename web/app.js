"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let info = null;
let pollTimer = null;
let clockTimer = null;

async function api(path, body, method) {
  const res = await fetch(path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

const fmtSats = (n) => `${Number(n).toLocaleString("en-US")} sats`;
const zatToZec = (z) => (Number(z) / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");

// --- Gateway info -------------------------------------------------------------

async function loadInfo() {
  try {
    info = await api("/api/info");
    document.querySelectorAll(".dom").forEach((el) => { el.textContent = info.lightning_address_domain; });
    const h = Math.round(info.retain_secs / 3600);
    $("#retain").textContent = h === 1 ? "1 hour" : `${h} hours`;
    $("#rcv-amount").min = info.min_sats;
    $("#rcv-amount").max = info.max_sats;
    $("#rcv-amount").placeholder = `${info.min_sats}–${info.max_sats}`;
    estimateReceive();
  } catch {
    // The navbar readout shows the gateway as offline.
  }
}

function estimateReceive() {
  const sats = Number($("#rcv-amount").value);
  const out = $("#rcv-estimate");
  if (!info || !sats) { out.innerHTML = "&nbsp;"; return; }
  const zat = Math.floor(sats * info.rate.zat_per_sat * (1 - info.fee_bps / 10000)) - info.zec_network_fee_zat;
  out.textContent = zat > 0
    ? `You receive about ${zatToZec(zat)} ZEC, after the ${info.fee_bps / 100}% fee and the Zcash network fee.`
    : "Too small to cover the Zcash network fee.";
}

// --- Tabs ---------------------------------------------------------------------

function selectTab(which) {
  const pay = which === "pay";
  $("#tab-pay").setAttribute("aria-selected", String(pay));
  $("#tab-receive").setAttribute("aria-selected", String(!pay));
  $("#form-pay").hidden = !pay;
  $("#form-receive").hidden = pay;
}
$("#tab-pay").addEventListener("click", () => selectTab("pay"));
$("#tab-receive").addEventListener("click", () => selectTab("receive"));

// --- Forms --------------------------------------------------------------------

function wireForm(form, handler) {
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("button[type=submit]", form);
    const err = $(".err", form);
    err.hidden = true;
    btn.disabled = true;
    try {
      await handler();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

const savedAddress = store.get("leyden.address");
if (savedAddress) {
  ["#pay-refund", "#rcv-address", "#ln-address"].forEach((s) => { $(s).value = savedAddress; });
}

wireForm($("#form-pay"), async () => {
  const refund = $("#pay-refund").value.trim();
  const swap = await api("/api/swaps/pay", { invoice: $("#pay-invoice").value.trim(), refund_address: refund });
  store.set("leyden.address", refund);
  showSwap(swap);
});

wireForm($("#form-receive"), async () => {
  const addr = $("#rcv-address").value.trim();
  const swap = await api("/api/swaps/receive", {
    payout_address: addr,
    amount_sats: Number($("#rcv-amount").value),
    memo: $("#rcv-memo").value.trim() || null,
  });
  store.set("leyden.address", addr);
  showSwap(swap);
});
$("#rcv-amount").addEventListener("input", estimateReceive);

wireForm($("#form-ln"), async () => {
  const res = await api("/api/ln-address", { name: $("#ln-name").value.trim(), payout_address: $("#ln-address").value.trim() });
  const box = $(".claimed", $("#form-ln"));
  box.innerHTML = "";
  const p = document.createElement("p");
  p.innerHTML = `Your Lightning address: <b class="mono"></b>`;
  $("b", p).textContent = res.lightning_address;
  const k = document.createElement("p");
  k.textContent = "Manage key (save it; it is the only way to delete this address):";
  box.append(p, k, copyRow(res.manage_key));
  box.hidden = false;
});

// --- Swap view ----------------------------------------------------------------

const STEPS = {
  zec_to_ln: [
    { key: "quote", label: "Quote" },
    { key: "seen", label: "ZEC received" },
    { key: "paying", label: "Paying invoice" },
    { key: "done", label: "Paid", bolt: true },
  ],
  ln_to_zec: [
    { key: "quote", label: "Invoice" },
    { key: "paid", label: "Lightning paid", bolt: true },
    { key: "sending", label: "Sending ZEC" },
    { key: "done", label: "Shielded" },
  ],
};

function progress(s) {
  if (s.direction === "zec_to_ln") {
    if (s.state === "complete") return 4;
    if (s.state === "paying_ln") return 2.5;
    if (s.received_zec) return 1.5;
    return 0.5;
  }
  if (s.state === "complete") return 4;
  if (s.state === "paying_zec") return 2.5;
  return 0.5;
}

function showSwap(s) {
  location.hash = `swap=${s.id}`;
  renderSwap(s);
  clearInterval(pollTimer);
  if (!s.final) {
    pollTimer = setInterval(async () => {
      try {
        const next = await api(`/api/swaps/${s.id}`);
        renderSwap(next);
        if (next.final) { clearInterval(pollTimer); loadInfo(); }
      } catch { /* keep polling */ }
    }, 4000);
  }
}

function renderSwap(s) {
  const root = $("#swap");
  root.innerHTML = "";
  root.append($("#tpl-swap").content.cloneNode(true));
  const steps = STEPS[s.direction];
  const p = progress(s);
  const failed = ["refunding", "refunded", "expired", "failed"].includes(s.state);

  $(".swap-kind", root).textContent = s.direction === "zec_to_ln" ? "ZEC → Lightning" : "Lightning → ZEC";
  const wire = $(".wire", root);
  wire.style.setProperty("--done", Math.min(1, Math.floor(p) / (steps.length - 1)).toString());
  wire.classList.toggle("live", s.state === "complete");
  steps.forEach((st, i) => {
    const li = document.createElement("li");
    li.textContent = st.label;
    if (st.bolt) li.classList.add("bolt");
    if (i < p) li.classList.add("on");
    if (!s.final && i === Math.ceil(p) - 1 + (Number.isInteger(p) ? 1 : 0)) li.classList.add("now");
    if (failed && i === Math.min(steps.length - 1, Math.ceil(p))) li.classList.add("bad");
    wire.append(li);
  });

  clearInterval(clockTimer);
  const clock = $(".swap-clock", root);
  const tick = () => {
    if (s.final || !["awaiting_zec", "awaiting_ln"].includes(s.state)) { clock.textContent = s.state.replace(/_/g, " "); return; }
    const left = s.expires_at - Math.floor(Date.now() / 1000);
    clock.textContent = left > 0 ? `quote valid ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "quote expired";
  };
  tick();
  clockTimer = setInterval(tick, 1000);

  const body = $(".swap-body", root);
  if (s.direction === "zec_to_ln") renderPay(s, body); else renderReceive(s, body);
}

function renderPay(s, body) {
  if (s.state === "awaiting_zec" && !s.received_zec) {
    body.append(qrBox(s.payment_uri), facts([
      ["Send exactly", `<span class="big">${s.zec} <small>ZEC</small></span>`],
      ["To this one-time shielded address", copyRow(s.deposit_address)],
      ["Pays", `${fmtSats(s.amount_sats)} over Lightning`],
      ["", note("Scan with Zodl, Zkool or any shielded wallet. Each quote gets a fresh address, so no two payments can be linked.")],
    ]));
    return;
  }
  const rows = [["Lightning invoice", fmtSats(s.amount_sats)]];
  if (s.received_zec) rows.push(["Received", `${s.received_zec} ZEC (shielded)`]);
  if (s.state === "awaiting_zec") rows.push(["", note("Payment seen in a block. Waiting for confirmation.")]);
  if (s.state === "paying_ln") rows.push(["", note("Paying the invoice over Lightning…")]);
  if (s.state === "complete") {
    rows.push(["", note("Paid. The preimage below is the payee's cryptographic proof of payment.", "ok")]);
    rows.push(["Preimage", copyRow(s.preimage ?? "(erased)")]);
  }
  if (s.state === "refunding") rows.push(["", note(`Refunding: ${s.error ?? ""}`, "bad")]);
  if (s.state === "refunded") rows.push(["", note(`Refunded to your shielded address. ${s.error ?? ""}`, "bad")], ["Refund txid", copyRow(s.refund_txid ?? "(erased)")]);
  if (s.state === "expired") rows.push(["", note("This quote expired before any payment arrived. Nothing was charged.", "bad")]);
  if (s.state === "failed") rows.push(["", note(s.error ?? "Failed.", "bad")]);
  body.append(facts(rows));
}

function renderReceive(s, body) {
  if (s.state === "awaiting_ln") {
    body.append(qrBox(`lightning:${s.invoice}`.toUpperCase()), facts([
      ["Pay this Lightning invoice", `<span class="big">${fmtSats(s.amount_sats)}</span>`],
      ["Invoice", copyRow(s.invoice)],
      ["You receive", `${s.zec} ZEC, shielded`],
      ["", note("Pay from any Lightning wallet. The ZEC is sent the moment the invoice is paid.")],
    ]));
    return;
  }
  const rows = [["You receive", `<span class="big">${s.zec} <small>ZEC</small></span>`]];
  if (s.state === "paying_zec") rows.push(["", note("Lightning payment received. Sending shielded ZEC…")]);
  if (s.state === "complete") rows.push(["", note("Sent to your shielded address. It shows up in your wallet after the next block.", "ok")], ["Zcash txid", copyRow(s.payout_txid ?? "(erased)")]);
  if (s.state === "expired") rows.push(["", note("The invoice expired unpaid. Nothing was charged.", "bad")]);
  if (s.error && s.state !== "complete") rows.push(["", note(s.error, "bad")]);
  body.append(facts(rows));
}

// --- Small builders -------------------------------------------------------------

function qrBox(text) {
  const div = document.createElement("div");
  div.className = "qr";
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  div.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  div.setAttribute("role", "img");
  div.setAttribute("aria-label", "QR code");
  return div;
}

function facts(rows) {
  const dl = document.createElement("dl");
  dl.className = "facts";
  for (const [label, value] of rows) {
    const wrap = document.createElement("div");
    if (label) { const dt = document.createElement("dt"); dt.textContent = label; wrap.append(dt); }
    const dd = document.createElement("dd");
    if (value instanceof Node) dd.append(value); else dd.innerHTML = value;
    wrap.append(dd);
    dl.append(wrap);
  }
  return dl;
}

function copyRow(text) {
  const row = document.createElement("div");
  row.className = "copy";
  const code = document.createElement("code");
  code.textContent = text;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Copy";
  btn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; }
    catch { btn.textContent = "Select and copy"; }
    setTimeout(() => { btn.textContent = "Copy"; }, 1600);
  });
  row.append(code, btn);
  return row;
}

function note(text, kind) {
  const p = document.createElement("p");
  p.className = `note${kind ? " " + kind : ""}`;
  p.textContent = text;
  return p;
}

// --- Boot -----------------------------------------------------------------------

loadInfo();
setInterval(loadInfo, 60000);
// Links from the landing page: /app/?dir=pay|receive&sats=N
const params = new URLSearchParams(location.search);
if (params.get("dir") === "receive") {
  selectTab("receive");
  if (Number(params.get("sats")) > 0) $("#rcv-amount").value = Number(params.get("sats"));
} else if (params.get("dir") === "pay") {
  selectTab("pay");
}
const m = location.hash.match(/swap=([0-9a-f]+)/);
if (m) {
  api(`/api/swaps/${m[1]}`).then((s) => {
    selectTab(s.direction === "zec_to_ln" ? "pay" : "receive");
    showSwap(s);
  }).catch(() => {});
}
