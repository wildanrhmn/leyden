"use strict";

// A small BOLT11 reader shared by the landing page and the app. It checks the bech32 checksum
// and pulls out what a payer needs to see: amount, payment hash, description and expiry.
// It does not verify the node's signature; the gateway decodes the invoice again before paying.
window.bolt11 = (() => {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  // Millisatoshis per unit of each amount multiplier (no multiplier means whole BTC).
  const MSAT = { "": 1e11, m: 1e8, u: 1e5, n: 1e2, p: 0.1 };

  function polymod(values) {
    const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
    }
    return chk;
  }

  // 5-bit words to bytes, dropping the leftover bits at the end.
  function toBytes(words) {
    const out = [];
    let acc = 0, bits = 0;
    for (const w of words) {
      acc = (acc << 5) | w;
      bits += 5;
      while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
      acc &= (1 << bits) - 1;
    }
    return new Uint8Array(out);
  }
  const toNumber = (words) => words.reduce((n, w) => n * 32 + w, 0);
  const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

  function decode(text) {
    const s = text.trim().toLowerCase().replace(/^lightning:/, "");
    const sep = s.lastIndexOf("1");
    // Timestamp (7 words) + signature (104) + checksum (6) is the shortest possible invoice.
    if (sep < 1 || s.length - sep - 1 < 117) throw new Error("That doesn't look like a Lightning invoice.");
    const hrp = s.slice(0, sep);
    const words = [...s.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
    const m = hrp.match(/^ln(bc|tbs|tb|bcrt)(\d*)([munp]?)$/);
    if (!m || words.includes(-1)) throw new Error("That doesn't look like a Lightning invoice.");
    const codes = [...hrp].map((c) => c.charCodeAt(0));
    if (polymod([...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31), ...words]) !== 1) {
      throw new Error("This invoice is mistyped or cut off.");
    }

    const data = words.slice(0, -6);
    const out = {
      network: m[1] === "bc" ? "mainnet" : "test",
      msat: m[2] ? Number(m[2]) * MSAT[m[3]] : null,
      timestamp: toNumber(data.slice(0, 7)),
      expiry: 3600,
      paymentHash: null,
      description: null,
      descriptionHash: null,
    };
    for (let i = 7; i + 3 <= data.length - 104; ) {
      const type = data[i], len = data[i + 1] * 32 + data[i + 2];
      const field = data.slice(i + 3, i + 3 + len);
      if (type === 1 && len === 52) out.paymentHash = toHex(toBytes(field));
      else if (type === 13) out.description = new TextDecoder().decode(toBytes(field));
      else if (type === 23 && len === 52) out.descriptionHash = toHex(toBytes(field));
      else if (type === 6) out.expiry = toNumber(field);
      i += 3 + len;
    }
    if (!out.paymentHash) throw new Error("This invoice has no payment hash.");
    out.sats = out.msat === null ? null : out.msat / 1000;
    out.expiresAt = out.timestamp + out.expiry;
    return out;
  }

  return { decode };
})();
