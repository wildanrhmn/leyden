"use strict";

// The app: pay a Lightning invoice with shielded ZEC, get paid over Lightning as shielded ZEC,
// or claim a Lightning address. Once a swap is created it runs inside the same card, polled
// every few seconds, and the URL (#swap=<id>) brings it back after a reload.
(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const anim = !!window.gsap && !matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Real asset marks, each with a small badge for how it moves: shielded, or over Lightning.
  const SHIELD = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 2.5 3.8v3.7c0 3.2 2.3 5.9 5.5 7 3.2-1.1 5.5-3.8 5.5-7V3.8z" fill="currentColor"/></svg>';
  const BOLT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 1 3.5 9.2h3.9L6.6 15l5.9-8.4H8.6z" fill="currentColor"/></svg>';
  const TOKENS = {
    zec: `<span class="ico"><img src="/brand/tokens/zec.svg" alt="" width="26" height="26"><span class="badge badge-shield">${SHIELD}</span></span>ZEC<small>shielded</small>`,
    ln: `<span class="ico"><img src="/brand/tokens/btc.svg" alt="" width="26" height="26"><span class="badge badge-bolt">${BOLT}</span></span>BTC<small>Lightning</small>`,
  };
  document.querySelectorAll("[data-token]").forEach((el) => { el.innerHTML = TOKENS[el.dataset.token]; });

  const n = (v) => Number(v).toLocaleString("en-US");
  const fmtZec = (zat) => (zat / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  const fmtUsd = (usd) => `≈ $${usd < 1 ? usd.toFixed(2) : usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const short = (s, a = 10, b = 8) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
  const sentence = (msg) => { const t = String(msg).trim(); return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : "."); };

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(sentence(data.error ?? `Request failed (${res.status})`));
    return data;
  }

  function shieldedError(addr) {
    if (!addr) return "Add your shielded address.";
    if (/^t[13]/i.test(addr)) return "That's a transparent (public) Zcash address. Use your wallet's shielded address.";
    if (!/^(u1|zs1)[0-9a-z]{20,}$/i.test(addr)) return "That doesn't look like a shielded Zcash address.";
    return null;
  }

  // --- Gateway info ----------------------------------------------------------------------

  let info = null;
  // Estimates mirror the gateway's pricing: Lightning routing allowance + margin, or margin + Zcash network fee.
  const payZat = (sats) => Math.ceil((sats + Math.max(3, Math.floor(sats / 200)) + 1) * info.rate.zat_per_sat * (1 + info.fee_bps / 10000));
  const receiveZat = (sats) => Math.floor(sats * info.rate.zat_per_sat * (1 - info.fee_bps / 10000)) - info.zec_network_fee_zat;

  async function loadInfo() {
    try {
      info = await api("/api/info");
      document.querySelectorAll(".dom").forEach((el) => { el.textContent = info.lightning_address_domain; });
      $("terms").textContent = `${n(info.fee_bps / 100)}% fee · ${n(info.min_sats)}–${n(info.max_sats)} sats · 1 sat ≈ ${info.rate.zat_per_sat.toFixed(1)} zats`;
    } catch {
      $("terms").textContent = "The gateway is unreachable right now.";
    }
    renderPay();
    renderReceive();
    renderAddress();
  }

  // --- Views and tabs --------------------------------------------------------------------

  const card = $("card");
  const tabs = $("tabs");
  const views = { pay: $("view-pay"), receive: $("view-receive"), address: $("view-address"), swap: $("view-swap"), claimed: $("view-claimed") };
  let mode = "pay";

  function placeThumb() {
    const btn = tabs.querySelector('[aria-selected="true"]');
    tabs.style.setProperty("--x", `${btn.offsetLeft}px`);
    tabs.style.setProperty("--w", `${btn.offsetWidth}px`);
  }

  // Measure, change what the card shows, then animate its height from the old content to the new.
  function resize(change, enter) {
    if (!anim) { change(); return; }
    gsap.killTweensOf(card, "height");
    card.style.height = "";
    const from = card.offsetHeight;
    change();
    const to = card.offsetHeight;
    gsap.fromTo(card, { height: from }, { height: to, duration: 0.5, ease: "power3.inOut", clearProps: "height" });
    if (enter) gsap.fromTo(enter, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.45, delay: 0.1, ease: "power2.out", clearProps: "opacity,transform" });
  }

  function show(name) {
    resize(() => {
      Object.entries(views).forEach(([k, v]) => { v.hidden = k !== name; });
      const working = name === "swap" || name === "claimed";
      tabs.classList.toggle("off", working);
      if (!working) {
        mode = name;
        tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === name)));
        placeThumb();
      }
    }, views[name]);
  }

  tabs.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (b && b.dataset.mode !== mode) show(b.dataset.mode);
  });
  tabs.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const all = [...tabs.querySelectorAll("button")];
    const next = all[(all.findIndex((b) => b.dataset.mode === mode) + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length];
    show(next.dataset.mode);
    next.focus();
  });
  document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => {
    dispatchEvent(new Event("leyden:flip"));
    // Flipping from a pasted invoice carries its amount over.
    if (b.dataset.go === "receive" && invoice) $("rcv-sats").value = Math.ceil(invoice.sats);
    show(b.dataset.go);
    renderReceive();
  }));
  addEventListener("resize", () => { if (!tabs.classList.contains("off")) placeThumb(); });

  // Forms: errors appear under the button; the button label always says what happens next.
  function wire(form, render, handler) {
    const btn = form.querySelector(".go");
    const err = form.querySelector(".err");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      err.hidden = true;
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = "One moment…";
      try {
        await handler();
      } catch (ex) {
        err.textContent = ex.message;
        resize(() => { err.hidden = false; });
      } finally {
        btn.textContent = label;
        render();
      }
    });
  }
  function fieldError(input, message) {
    const row = input.closest(".drow");
    row.classList.toggle("bad", !!message);
    if (message) throw new Error(message);
  }

  // Detail rows show a short form of their value; the full invoice or address is never on
  // screen. Invoices and addresses are pasted, not typed, so a paste closes the field at once.
  // A filled invoice offers Clear; a filled address offers Change, which opens an empty field
  // and puts the old address back if nothing new is pasted. Memos are short and just edit.
  function setupRow(row) {
    const input = row.querySelector(".d-input");
    const shown = row.querySelector(".d-show");
    const kind = row.dataset.kind ?? "address";
    let previous = "";
    const check = () => {
      const v = input.value.trim();
      row.classList.toggle("bad", kind === "address" && !!v && !!shieldedError(v));
    };
    const paint = () => {
      const v = input.value.trim();
      check();
      if (!v) { shown.className = "d-show empty"; shown.textContent = row.dataset.empty; return; }
      shown.className = "d-show";
      const text = kind === "memo" ? v : kind === "invoice" ? short(v, 12, 6) : short(v, 10, 8);
      const action = kind === "memo" ? "Edit" : kind === "invoice" ? "Clear" : "Change";
      shown.replaceChildren(el("span", null, text), el("small", null, action));
    };
    const close = () => { row.classList.remove("editing"); paint(); };
    const set = (value) => { input.value = value; input.dispatchEvent(new Event("input")); close(); };

    shown.addEventListener("click", async () => {
      const v = input.value.trim();
      if (kind === "invoice" && v) { set(""); return; }
      if (kind === "invoice") {
        // An empty invoice row pastes straight from the clipboard, if the browser allows it.
        try {
          const text = (await navigator.clipboard.readText()).trim();
          if (text) { set(text); return; }
        } catch { /* fall back to the field */ }
      }
      if (kind === "address" && v) { previous = v; input.value = ""; }
      row.classList.add("editing");
      input.focus();
    });
    input.addEventListener("paste", () => setTimeout(() => { if (input.value.trim()) input.blur(); }));
    input.addEventListener("blur", () => {
      if (kind === "address" && !input.value.trim() && previous) set(previous);
      previous = "";
      close();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { if (previous) input.value = previous; input.blur(); }
    });
    row.paint = paint;
    paint();
  }

  const saved = store.get("leyden.address");
  if (saved) ["pay-refund", "rcv-address", "ln-address"].forEach((id) => { $(id).value = saved; });
  document.querySelectorAll(".drow").forEach(setupRow);

  // --- Pay a Lightning invoice ------------------------------------------------------------

  const payInv = $("pay-invoice");
  const payRefund = $("pay-refund");
  let invoice = null;

  function expiresIn(at) {
    const min = Math.round((at * 1000 - Date.now()) / 60000);
    if (min < 1) return "expires in under a minute";
    return min < 90 ? `expires in ${min} min` : `expires in ${Math.round(min / 60)} h`;
  }

  function renderPay() {
    const raw = payInv.value.trim();
    const note = $("pay-inv-note");
    const go = $("pay-go");
    let problem = null;
    invoice = null;
    if (raw) {
      try {
        const d = bolt11.decode(raw);
        if (d.network !== "mainnet") problem = "This is a testnet invoice. Leyden runs on mainnet.";
        else if (d.sats === null) problem = "This invoice has no amount. Ask for one with an amount in it.";
        else if (d.expiresAt * 1000 < Date.now()) problem = "This invoice has expired. Ask for a fresh one.";
        else invoice = d;
      } catch (e) {
        problem = e.message;
      }
    }

    const sats = invoice ? Math.ceil(invoice.sats) : 0;
    $("pay-sats").textContent = invoice ? n(sats) : "0";
    $("pay-sats").classList.toggle("is-empty", !invoice);
    const zat = invoice && info ? payZat(sats) : 0;
    $("pay-zec").textContent = zat ? fmtZec(zat) : "0";
    $("pay-zec").classList.toggle("is-empty", !zat);
    $("pay-zec-usd").textContent = zat ? fmtUsd((zat / 1e8) * info.rate.zec_usd) : " ";

    note.classList.toggle("bad", !!problem);
    if (problem) note.textContent = problem;
    else if (invoice) {
      const parts = [];
      if (invoice.description) parts.push(Object.assign(document.createElement("q"), { textContent: invoice.description }), " · ");
      parts.push(expiresIn(invoice.expiresAt));
      note.replaceChildren(...parts);
    } else note.textContent = "\u00a0";

    let label = "Pay with shielded ZEC";
    if (!raw) label = "Paste an invoice";
    else if (problem) label = "Check the invoice";
    else if (info && (sats < info.min_sats || sats > info.max_sats)) label = `Leyden pays ${n(info.min_sats)}–${n(info.max_sats)} sats`;
    else if (info && sats > info.liquidity.lightning_sats) label = `Up to ${n(info.liquidity.lightning_sats)} sats right now`;
    else if (!payRefund.value.trim()) label = "Add a refund address";
    else if (shieldedError(payRefund.value.trim())) label = "Use a shielded refund address";
    $("pay-go").textContent = label;
    go.disabled = label !== "Pay with shielded ZEC" || !info;
  }

  payInv.addEventListener("input", renderPay);
  payRefund.addEventListener("input", () => { payRefund.closest(".drow").classList.remove("bad"); renderPay(); });

  wire(views.pay, renderPay, async () => {
    const refund = payRefund.value.trim();
    fieldError(payRefund, shieldedError(refund));
    const swap = await api("/api/swaps/pay", { invoice: payInv.value.trim().replace(/^lightning:/i, ""), refund_address: refund });
    store.set("leyden.address", refund);
    openSwap(swap);
  });

  // --- Get paid over Lightning ------------------------------------------------------------

  const rcvSats = $("rcv-sats");
  const rcvAddr = $("rcv-address");

  function renderReceive() {
    const sats = Math.max(0, Math.floor(Number(rcvSats.value) || 0));
    const go = $("rcv-go");
    if (!info) { go.disabled = true; return; }
    const zat = receiveZat(sats);
    $("rcv-sats-usd").textContent = fmtUsd((sats * info.rate.btc_usd) / 1e8);
    $("rcv-zec").textContent = zat > 0 ? fmtZec(zat) : "0";
    $("rcv-zec").classList.toggle("is-empty", zat <= 0);
    $("rcv-zec-usd").textContent = fmtUsd((Math.max(zat, 0) / 1e8) * info.rate.zec_usd);

    let label = "Create Lightning invoice";
    if (sats < info.min_sats || sats > info.max_sats) label = `Enter ${n(info.min_sats)}–${n(info.max_sats)} sats`;
    else if (zat <= 0) label = "Too small to cover the Zcash network fee";
    else if (zat > info.liquidity.zec_zat) label = "More than Leyden can pay out right now";
    else if (!rcvAddr.value.trim()) label = "Add your shielded address";
    else if (shieldedError(rcvAddr.value.trim())) label = "Use a shielded address";
    go.textContent = label;
    go.disabled = label !== "Create Lightning invoice";
  }

  rcvSats.addEventListener("input", renderReceive);
  rcvAddr.addEventListener("input", () => { rcvAddr.closest(".drow").classList.remove("bad"); renderReceive(); });

  wire(views.receive, renderReceive, async () => {
    const addr = rcvAddr.value.trim();
    fieldError(rcvAddr, shieldedError(addr));
    const swap = await api("/api/swaps/receive", {
      payout_address: addr,
      amount_sats: Math.floor(Number(rcvSats.value)),
      memo: $("rcv-memo").value.trim() || null,
    });
    store.set("leyden.address", addr);
    openSwap(swap);
  });

  // --- Lightning address --------------------------------------------------------------------

  const lnName = $("ln-name");
  const lnAddr = $("ln-address");
  const NAME = /^[a-z0-9_-]{3,32}$/;

  function renderAddress() {
    const name = lnName.value.trim().toLowerCase();
    $("ln-preview").firstChild.textContent = `${name || "name"}@`;
    let label = "Claim address";
    if (!name) label = "Pick a name";
    else if (!NAME.test(name)) label = "Use 3–32 letters, digits, - or _";
    else if (!lnAddr.value.trim()) label = "Add your shielded address";
    else if (shieldedError(lnAddr.value.trim())) label = "Use a shielded address";
    $("ln-go").textContent = label;
    $("ln-go").disabled = label !== "Claim address" || !info;
  }

  lnName.addEventListener("input", renderAddress);
  lnAddr.addEventListener("input", () => { lnAddr.closest(".drow").classList.remove("bad"); renderAddress(); });

  wire(views.address, renderAddress, async () => {
    const addr = lnAddr.value.trim();
    fieldError(lnAddr, shieldedError(addr));
    const res = await api("/api/ln-address", { name: lnName.value.trim().toLowerCase(), payout_address: addr });
    store.set("leyden.address", addr);
    showClaimed(res);
  });

  // --- Building blocks for the swap and claimed views ---------------------------------------

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function big(value, unit) {
    const p = el("span", "sv-big", value);
    if (unit) p.append(" ", el("small", null, unit));
    return p;
  }
  function amount(cap, value, unit, lit) {
    const div = el("div", "sv-amount");
    div.append(el("span", `sv-cap${lit ? " lit" : ""}`, cap), big(value, unit));
    return div;
  }
  function copyBtn(text, label = "Copy") {
    const b = el("button", "copy", label);
    b.type = "button";
    b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; b.classList.add("done"); }
      catch { b.textContent = "Copy failed"; }
      setTimeout(() => { b.textContent = label; b.classList.remove("done"); }, 1600);
    });
    return b;
  }
  // rows: [label, shown text, { copy, href }]
  function rows(list) {
    const dl = el("dl", "sv-rows");
    for (const [label, shown, opt = {}] of list) {
      const div = el("div");
      const dd = el("dd");
      const value = opt.href ? Object.assign(el("a", null, shown), { href: opt.href, target: "_blank", rel: "noopener" }) : el("code", null, shown);
      dd.append(value);
      if (opt.copy) dd.append(copyBtn(opt.copy));
      div.append(el("dt", null, label), dd);
      dl.append(div);
    }
    return dl;
  }
  function qr(text) {
    const div = el("div", "qr");
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    div.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    div.setAttribute("role", "img");
    div.setAttribute("aria-label", "QR code");
    return div;
  }
  function actions(...items) {
    const div = el("div", "sv-actions");
    div.append(...items);
    return div;
  }
  function walletLink(href) {
    const a = el("a", "pill pill-ghost pill-block", "Open in wallet");
    a.href = href;
    return a;
  }
  function backBtn(label, onClick) {
    const b = el("button", "back");
    b.type = "button";
    b.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    b.append(label);
    b.addEventListener("click", onClick);
    return b;
  }
  const explorer = (txid) => `https://blockchair.com/zcash/transaction/${txid}`;

  // --- A swap in progress -------------------------------------------------------------------

  const STEPS = {
    zec_to_ln: ["Send ZEC", "ZEC received", "Paying the invoice", "Paid"],
    ln_to_zec: ["Pay the invoice", "Payment held", "ZEC sent", "Shielded"],
  };
  const FAILED = ["refunding", "refunded", "expired", "failed"];
  let pollTimer = null;
  let clockTimer = null;
  let lastKey = null;

  function stepOf(s) {
    if (s.state === "complete") return 4;
    if (s.direction === "zec_to_ln") {
      if (s.state === "paying_ln") return 2;
      return s.received_zec ? 1 : 0;
    }
    return { paying_zec: 1, settling_ln: 2, failed: 1 }[s.state] ?? 0;
  }
  const waitingForDeposit = (s) => (s.state === "awaiting_zec" && !s.received_zec) || s.state === "awaiting_ln";

  function leaveSwap(s) {
    clearInterval(pollTimer);
    clearInterval(clockTimer);
    lastKey = null;
    history.replaceState(null, "", location.pathname + location.search);
    if (s.final && s.direction === "zec_to_ln") { payInv.value = ""; renderPay(); }
    show(s.direction === "zec_to_ln" ? "pay" : "receive");
  }

  function buildSwap(s) {
    const root = el("div", "sv");
    const step = stepOf(s);
    const failed = FAILED.includes(s.state);
    const labels = STEPS[s.direction];

    // Leaving is safe while nothing has been paid in, and after the swap has finished.
    const head = el("div", "sv-head");
    if (s.final) head.append(backBtn("New swap", () => leaveSwap(s)));
    else if (waitingForDeposit(s)) head.append(backBtn("Cancel", () => leaveSwap(s)));
    else head.append(el("span"));
    head.append(el("span", "sv-clock"));

    const bar = el("div", `steps${s.state === "complete" ? " complete" : ""}`);
    bar.setAttribute("aria-hidden", "true");
    labels.forEach((_, i) => {
      const seg = el("i");
      if (i < step) seg.classList.add("done");
      if (!s.final && i === step) seg.classList.add("now");
      if (failed && i === Math.min(step, 3)) seg.classList.add("bad");
      bar.append(seg);
    });
    const label = el("p", "step-label");
    const status = s.state === "complete" ? labels[3] : failed ? { refunding: "Refunding", refunded: "Refunded", expired: "Expired", failed: "Failed" }[s.state] : labels[step];
    label.append(el("span", null, status), el("span", null, s.state === "complete" ? "Done" : `Step ${Math.min(step + 1, 4)} of 4`));
    root.append(head, bar, label);

    if (s.direction === "zec_to_ln") buildPay(s, root); else buildReceive(s, root);
    return root;
  }

  // A refund sends back what arrived, minus the network fee of the refund transaction itself.
  const networkFee = () => (info ? info.zec_network_fee_zat : 15000);
  const refundZec = (s) => fmtZec(Math.max(0, Math.round(Number(s.received_zec ?? s.zec) * 1e8) - networkFee()));
  function refundReason(s) {
    const e = s.error ?? "";
    if (e.startsWith("underpaid")) return `You sent ${s.received_zec} ZEC, but the quote was ${s.zec} ZEC, so it was sent back.`;
    if (e.startsWith("payment arrived after")) return "Your payment arrived after the quote expired, so it was sent back.";
    if (e.includes("invoice expired")) return "The Lightning invoice expired before your payment confirmed, so it was sent back.";
    if (e.startsWith("lightning payment failed")) return "The Lightning payment didn't go through, so your ZEC was sent back.";
    return e ? sentence(e) : "The Lightning payment didn't go through, so your ZEC was sent back.";
  }

  function buildPay(s, root) {
    const sats = n(s.amount_sats);
    switch (s.state) {
      case "awaiting_zec":
        if (!s.received_zec) {
          root.append(
            qr(s.payment_uri),
            amount("Send exactly", s.zec, "ZEC"),
            rows([["Amount", `${s.zec} ZEC`, { copy: s.zec }], ["To", short(s.deposit_address), { copy: s.deposit_address }]]),
            actions(walletLink(s.payment_uri)),
            el("p", "sv-note", `Pays ${sats} sats over Lightning once it lands. This address is used for this swap only.`),
          );
        } else {
          root.append(el("div", "sv-wait"));
          root.lastChild.append(amount("Received, shielded", s.received_zec, "ZEC"));
          root.append(el("p", "sv-note", "Seen in a block. As soon as it's confirmed, the invoice gets paid."));
        }
        break;
      case "paying_ln":
        root.append(el("div", "sv-wait"));
        root.lastChild.append(amount("Paying the invoice", sats, "sats"));
        root.append(el("p", "sv-note", "Over Lightning. This usually takes a few seconds."));
        break;
      case "complete": {
        const list = [["Preimage", short(s.preimage ?? "erased"), s.preimage ? { copy: s.preimage } : {}]];
        if (s.deposit_txid) list.push(["Your Zcash tx", `${short(s.deposit_txid, 8, 4)} ↗`, { href: explorer(s.deposit_txid) }]);
        root.append(
          amount("Paid over Lightning", sats, "sats", true),
          rows(list),
          el("p", "sv-note", "The preimage is the payee's proof that this invoice was paid."),
          actions(Object.assign(el("button", "pill pill-ghost pill-block", "New swap"), { type: "button", onclick: () => leaveSwap(s) })),
        );
        break;
      }
      case "refunding":
        root.append(amount("Sending it back", refundZec(s), "ZEC"), el("p", "sv-note", refundReason(s)));
        break;
      case "refunded":
        root.append(
          amount("Refunded to your shielded address", refundZec(s), "ZEC"),
          rows(s.refund_txid ? [["Refund tx", `${short(s.refund_txid, 8, 4)} ↗`, { href: explorer(s.refund_txid) }]] : []),
          el("p", "sv-note", `${refundReason(s)} That's what arrived, minus the ${fmtZec(networkFee())} ZEC network fee for sending it back.`),
        );
        break;
      case "expired":
        root.append(el("div", "sv-wait"));
        root.lastChild.append(amount("Quote expired", "Nothing was charged"));
        root.append(el("p", "sv-note", "No payment arrived in time. Start a new swap for a fresh quote."));
        break;
      default:
        root.append(el("p", "sv-note bad", s.error ? sentence(s.error) : "Something went wrong with this swap."));
    }
  }

  function buildReceive(s, root) {
    switch (s.state) {
      case "awaiting_ln":
        root.append(
          qr(`lightning:${s.invoice}`.toUpperCase()),
          amount("Pay this invoice", n(s.amount_sats), "sats"),
          rows([["Invoice", short(s.invoice, 12, 6), { copy: s.invoice }], ["You receive", `${s.zec} ZEC`]]),
          actions(walletLink(`lightning:${s.invoice}`)),
          el("p", "sv-note", "From any Lightning wallet. The payment is held, not taken, until your shielded ZEC has been sent."),
        );
        break;
      case "paying_zec":
        root.append(el("div", "sv-wait"));
        root.lastChild.append(amount("Payment held", s.zec, "ZEC"));
        root.append(el("p", "sv-note", "The Lightning payment is held, not taken. Your shielded ZEC goes out first; if it can't, the payment is never taken and goes back to the payer when the hold expires."));
        break;
      case "settling_ln":
        root.append(
          amount("ZEC sent", s.zec, "ZEC"),
          rows(s.payout_txid ? [["Zcash tx", `${short(s.payout_txid, 8, 4)} ↗`, { href: explorer(s.payout_txid) }]] : []),
          el("p", "sv-note", "Now taking the held Lightning payment."),
        );
        break;
      case "complete":
        root.append(
          amount("Sent, shielded", `+${s.zec}`, "ZEC", true),
          rows(s.payout_txid ? [["Zcash tx", `${short(s.payout_txid, 8, 4)} ↗`, { href: explorer(s.payout_txid), copy: s.payout_txid }]] : []),
          el("p", "sv-note", "It shows up in your wallet after the next block, in about a minute."),
          actions(Object.assign(el("button", "pill pill-ghost pill-block", "New swap"), { type: "button", onclick: () => leaveSwap(s) })),
        );
        break;
      case "expired":
        root.append(el("div", "sv-wait"));
        root.lastChild.append(amount("Invoice expired", "Nothing was charged"));
        root.append(el("p", "sv-note", "Nobody paid it in time. Create a new one whenever you're ready."));
        break;
      default:
        root.append(el("p", "sv-note bad", s.error ? sentence(s.error) : "Something went wrong with this swap."));
    }
  }

  function startClock(s) {
    clearInterval(clockTimer);
    const clock = views.swap.querySelector(".sv-clock");
    const tick = () => {
      if (!waitingForDeposit(s)) { clock.textContent = ""; return; }
      const left = s.expires_at - Math.floor(Date.now() / 1000);
      clock.textContent = left > 0 ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Expired";
      clock.classList.toggle("soon", left < 120);
    };
    tick();
    clockTimer = setInterval(tick, 1000);
  }

  function renderSwap(s) {
    const key = [s.state, s.received_zec, s.preimage, s.payout_txid, s.refund_txid, s.error].join("|");
    if (key === lastKey) return;
    const first = lastKey === null;
    lastKey = key;
    const content = buildSwap(s);
    if (first) views.swap.replaceChildren(content);
    else resize(() => views.swap.replaceChildren(content), content);
    startClock(s);
  }

  function openSwap(s) {
    history.replaceState(null, "", `#swap=${s.id}`);
    lastKey = null;
    renderSwap(s);
    show("swap");
    clearInterval(pollTimer);
    if (s.final) return;
    pollTimer = setInterval(async () => {
      try {
        const next = await api(`/api/swaps/${s.id}`);
        renderSwap(next);
        if (next.final) { clearInterval(pollTimer); loadInfo(); }
      } catch { /* keep polling */ }
    }, 4000);
  }

  // --- A claimed Lightning address ------------------------------------------------------------

  function showClaimed(res) {
    const root = el("div", "sv");
    const head = el("div", "sv-head");
    head.append(backBtn("Done", () => { lnName.value = ""; renderAddress(); show("address"); }), el("span"));
    root.append(
      head,
      amount("Your Lightning address", res.lightning_address, null, true),
      rows([["Address", res.lightning_address, { copy: res.lightning_address }], ["Manage key", short(res.manage_key, 8, 6), { copy: res.manage_key }]]),
      el("p", "sv-note", "Save the manage key. It's the only way to delete this address later, and it isn't shown again."),
    );
    views.claimed.replaceChildren(root);
    show("claimed");
  }

  // --- Boot ---------------------------------------------------------------------------------------

  // Links from the landing page: /app/?dir=pay|receive&sats=N
  const params = new URLSearchParams(location.search);
  const sats = Number(params.get("sats"));
  if (params.get("dir") === "receive") {
    if (sats > 0) rcvSats.value = Math.floor(sats);
    mode = "receive";
    Object.entries(views).forEach(([k, v]) => { v.hidden = k !== "receive"; });
    tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === "receive")));
  }
  placeThumb();
  document.fonts.ready.then(() => { placeThumb(); requestAnimationFrame(() => tabs.classList.add("ready")); });
  renderPay();
  renderReceive();
  renderAddress();
  loadInfo();
  setInterval(loadInfo, 60000);

  const m = location.hash.match(/swap=([0-9a-f]+)/);
  if (m) api(`/api/swaps/${m[1]}`).then(openSwap).catch(() => history.replaceState(null, "", location.pathname + location.search));

  if (anim) gsap.from(card, { opacity: 0, y: 24, duration: 0.9, ease: "expo.out", clearProps: "opacity,transform" });
})();
