//! Quoting and the swap state machine.

use std::{collections::HashMap, sync::Arc, time::Duration};

use anyhow::{Result, anyhow, bail};

use crate::{
    ln::Lightning,
    price::PriceFeed,
    store::{Direction, Store, Swap, state},
    wallet::{Received, ZecWallet, parse_shielded_recipient},
};

#[derive(Clone, Debug, serde::Serialize)]
pub struct Config {
    /// Gateway margin on both directions, in basis points.
    pub fee_bps: u64,
    pub min_sats: u64,
    pub max_sats: u64,
    pub quote_ttl_secs: i64,
    /// Zatoshis reserved for the network fee of a payout or refund the gateway sends.
    pub zec_network_fee_zat: u64,
    /// Confirmations before an incoming ZEC payment is acted on.
    pub min_conf: u32,
    /// How long linking data of finished swaps is kept before being erased.
    pub retain_secs: i64,
}

pub struct App {
    pub wallet: ZecWallet,
    pub ln: Lightning,
    pub store: Store,
    pub price: PriceFeed,
    pub cfg: Config,
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// Extra time after quote expiry during which a payment that was broadcast in time
/// may still be mined and honoured.
const MINING_GRACE_SECS: i64 = 15 * 60;

impl App {
    /// ZEC → Lightning: quote paying `bolt11`, with refunds to `refund_address`.
    pub async fn quote_pay(&self, bolt11: &str, refund_address: &str) -> Result<Swap> {
        parse_shielded_recipient(refund_address, &zcash_protocol::consensus::Network::MainNetwork)?;
        let bolt11 = bolt11.trim().trim_start_matches("lightning:").trim_start_matches("LIGHTNING:").to_string();
        let inv = self.ln.decode(&bolt11).await?;
        if inv.network.as_deref().is_some_and(|n| n != "bc") {
            bail!("invoice is not for Bitcoin mainnet");
        }
        let amount_msat = inv
            .amount_msat
            .ok_or_else(|| anyhow!("invoice has no amount; ask the payee for an invoice with an amount"))?;
        let amount_sats = amount_msat.div_ceil(1000);
        self.check_limits(amount_sats)?;
        let now = now();
        let expires_at = now + self.cfg.quote_ttl_secs;
        if inv.expires_at < expires_at + MINING_GRACE_SECS {
            bail!("invoice expires too soon; it must stay valid for at least {} minutes", (self.cfg.quote_ttl_secs + MINING_GRACE_SECS) / 60);
        }

        let fee_est = self.ln.fee_estimate(&bolt11).await.unwrap_or(0);
        let max_fee_sats = fee_est + (amount_sats / 200).max(3);
        let ln_balance = self.ln.balance_sats().await?;
        if ln_balance < amount_sats + max_fee_sats {
            bail!("gateway Lightning liquidity is too low for this amount right now (max {} sats)", ln_balance.saturating_sub(max_fee_sats));
        }

        let rate = self.price.rate().await?;
        let zec_zat = ((amount_sats + max_fee_sats) as f64
            * rate.zat_per_sat()
            * (1.0 + self.cfg.fee_bps as f64 / 10_000.0))
            .ceil() as i64;

        let seq = self.store.next_seq()?;
        let (deposit_address, diversifier) = self.wallet.quote_address(seq as u64)?;
        let swap = Swap {
            id: uuid::Uuid::new_v4().simple().to_string(),
            seq,
            direction: Some(Direction::ZecToLn),
            state: state::AWAITING_ZEC.into(),
            created_at: now,
            expires_at,
            amount_sats: amount_sats as i64,
            zec_zat,
            deposit_address: Some(deposit_address),
            deposit_diversifier: Some(hex::encode(diversifier)),
            bolt11: Some(bolt11),
            max_fee_sats: Some(max_fee_sats as i64),
            refund_address: Some(refund_address.trim().to_string()),
            ..Default::default()
        };
        self.store.insert(&swap)?;
        Ok(swap)
    }

    /// Lightning → ZEC: invoice for `amount_sats`, paying out shielded ZEC to `payout_address`.
    pub async fn quote_receive(&self, payout_address: &str, amount_sats: u64, memo: Option<String>) -> Result<Swap> {
        self.quote_receive_inner(payout_address, amount_sats, memo, None).await
    }

    pub async fn quote_receive_inner(
        &self,
        payout_address: &str,
        amount_sats: u64,
        memo: Option<String>,
        description_hash: Option<&str>,
    ) -> Result<Swap> {
        parse_shielded_recipient(payout_address, &zcash_protocol::consensus::Network::MainNetwork)?;
        self.check_limits(amount_sats)?;
        if let Some(m) = &memo {
            if m.len() > 400 {
                bail!("memo too long");
            }
        }
        let rate = self.price.rate().await?;
        let gross = (amount_sats as f64 * rate.zat_per_sat() * (1.0 - self.cfg.fee_bps as f64 / 10_000.0)).floor() as i64;
        let zec_zat = gross - self.cfg.zec_network_fee_zat as i64;
        if zec_zat < 10_000 {
            bail!("amount too small to cover the Zcash network fee");
        }
        let spendable = self.wallet.spendable_zat().unwrap_or(0) as i64;
        if spendable < zec_zat + self.cfg.zec_network_fee_zat as i64 {
            bail!("gateway ZEC liquidity is too low for this amount right now");
        }

        let now = now();
        let invoice = self
            .ln
            .create_invoice(amount_sats, Some("Leyden: Lightning to shielded ZEC"), description_hash, self.cfg.quote_ttl_secs as u64)
            .await?;
        let swap = Swap {
            id: uuid::Uuid::new_v4().simple().to_string(),
            seq: self.store.next_seq()?,
            direction: Some(Direction::LnToZec),
            state: state::AWAITING_LN.into(),
            created_at: now,
            expires_at: now + self.cfg.quote_ttl_secs,
            amount_sats: amount_sats as i64,
            zec_zat,
            ln_invoice: Some(invoice.bolt11),
            ln_invoice_id: Some(invoice.id),
            payout_address: Some(payout_address.trim().to_string()),
            payout_memo: memo,
            ..Default::default()
        };
        self.store.insert(&swap)?;
        Ok(swap)
    }

    fn check_limits(&self, sats: u64) -> Result<()> {
        if sats < self.cfg.min_sats || sats > self.cfg.max_sats {
            bail!("amount must be between {} and {} sats", self.cfg.min_sats, self.cfg.max_sats);
        }
        Ok(())
    }

    /// One pass of the state machine over every active swap.
    pub async fn tick(&self) -> Result<()> {
        if let Err(e) = self.wallet.sync().await {
            tracing::warn!("sync: {e:#}");
        }
        let tip = self.wallet.chain_height()?.unwrap_or(0);
        let mut by_d: HashMap<String, Vec<Received>> = HashMap::new();
        for r in self.wallet.received_notes()? {
            by_d.entry(hex::encode(r.diversifier)).or_default().push(r);
        }

        // Late payments to swaps that already expired: refund them.
        for (id, d, st) in self.store.known_diversifiers()? {
            if st == state::EXPIRED && by_d.contains_key(&d) {
                if let Some(mut s) = self.store.get(&id)? {
                    let notes = &by_d[&d];
                    s.received_zat = Some(notes.iter().map(|n| n.value_zat as i64).sum());
                    s.deposit_txid = notes.first().map(|n| n.txid.clone());
                    s.error = Some("payment arrived after the quote expired".into());
                    s.state = state::REFUNDING.into();
                    s.finished_at = None;
                    self.store.update(&s)?;
                }
            }
        }

        for mut s in self.store.active()? {
            let before = s.state.clone();
            if let Err(e) = self.step(&mut s, tip, &by_d).await {
                tracing::warn!(swap = %s.id, "step failed: {e:#}");
                s.error = Some(format!("{e:#}"));
            }
            if state::is_final(&s.state) && s.finished_at.is_none() {
                s.finished_at = Some(now());
            }
            if s.state != before {
                tracing::info!(swap = %s.id, from = %before, to = %s.state, "swap state");
            }
            self.store.update(&s)?;
        }

        let purged = self.store.purge_finished(now(), self.cfg.retain_secs)?;
        if purged > 0 {
            tracing::info!(purged, "erased linking data of finished swaps");
        }
        Ok(())
    }

    async fn step(&self, s: &mut Swap, tip: u32, by_d: &HashMap<String, Vec<Received>>) -> Result<()> {
        let now = now();
        match s.state.as_str() {
            state::AWAITING_ZEC => {
                let notes = s.deposit_diversifier.as_ref().and_then(|d| by_d.get(d));
                let Some(notes) = notes else {
                    if now > s.expires_at + MINING_GRACE_SECS {
                        s.state = state::EXPIRED.into();
                    }
                    return Ok(());
                };
                let received: i64 = notes.iter().map(|n| n.value_zat as i64).sum();
                s.received_zat = Some(received);
                s.deposit_txid = notes.first().map(|n| n.txid.clone());
                let confirmed = notes.iter().all(|n| n.mined_height.is_some_and(|h| tip + 1 >= h + self.cfg.min_conf));
                if !confirmed {
                    return Ok(());
                }
                if received < s.zec_zat {
                    s.error = Some(format!("underpaid: received {received} zat, quote was {} zat", s.zec_zat));
                    s.state = state::REFUNDING.into();
                    return Ok(());
                }
                let bolt11 = s.bolt11.clone().unwrap_or_default();
                let inv = self.ln.decode(&bolt11).await?;
                if inv.expires_at < now + 60 {
                    s.error = Some("the Lightning invoice expired before the payment confirmed".into());
                    s.state = state::REFUNDING.into();
                    return Ok(());
                }
                // Persist the state change before paying, so a crash can never pay twice.
                s.state = state::PAYING_LN.into();
                self.store.update(s)?;
                match self.ln.pay(&bolt11, s.max_fee_sats.unwrap_or(10) as u64).await {
                    Ok(id) => s.ln_payment_id = Some(id),
                    Err(e) => {
                        s.state = state::FAILED.into();
                        s.error = Some(format!("lightning payment could not be started ({e:#}); held for manual review"));
                    }
                }
            }
            state::PAYING_LN => {
                let Some(id) = s.ln_payment_id.clone() else {
                    s.state = state::FAILED.into();
                    s.error = Some("lightning payment state unknown; held for manual review".into());
                    return Ok(());
                };
                let st = self.ln.pay_status(&id).await?;
                if st.done {
                    s.preimage = st.preimage;
                    s.state = state::COMPLETE.into();
                } else if st.failed {
                    s.error = Some(format!("lightning payment failed ({})", st.status));
                    s.state = state::REFUNDING.into();
                }
            }
            state::REFUNDING => {
                let received = s.received_zat.unwrap_or(0);
                let amount = received - self.cfg.zec_network_fee_zat as i64;
                if amount < 10_000 {
                    s.state = state::FAILED.into();
                    s.error = Some(format!("{} (too small to refund after the network fee)", s.error.clone().unwrap_or_default()));
                    return Ok(());
                }
                let to = s.refund_address.clone().ok_or_else(|| anyhow!("no refund address"))?;
                let memo = format!("Leyden refund, swap {}", &s.id[..8]);
                let txid = self.wallet.send(&to, amount as u64, Some(&memo)).await?;
                s.refund_txid = Some(txid);
                s.state = state::REFUNDED.into();
            }
            state::AWAITING_LN => {
                let id = s.ln_invoice_id.clone().unwrap_or_default();
                let st = self.ln.invoice_status(&id).await?;
                if st.paid {
                    s.state = state::PAYING_ZEC.into();
                    self.store.update(s)?;
                    self.pay_out(s).await?;
                } else if now > s.expires_at + 60 {
                    s.state = state::EXPIRED.into();
                }
            }
            state::PAYING_ZEC => self.pay_out(s).await?,
            _ => {}
        }
        Ok(())
    }

    async fn pay_out(&self, s: &mut Swap) -> Result<()> {
        let to = s.payout_address.clone().ok_or_else(|| anyhow!("no payout address"))?;
        let memo = match &s.payout_memo {
            Some(m) if !m.is_empty() => format!("{m}\n— via Leyden ⚡"),
            _ => "Received over Lightning via Leyden ⚡".to_string(),
        };
        let txid = self.wallet.send(&to, s.zec_zat as u64, Some(&memo)).await?;
        s.payout_txid = Some(txid);
        s.error = None;
        s.state = state::COMPLETE.into();
        Ok(())
    }
}

pub async fn run(app: Arc<App>) {
    loop {
        if let Err(e) = app.tick().await {
            tracing::warn!("tick: {e:#}");
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

/// `zcash:` payment URI (ZIP 321) for a deposit.
pub fn zip321_uri(address: &str, zat: i64) -> String {
    format!("zcash:{address}?amount={}", format_zec(zat))
}

pub fn format_zec(zat: i64) -> String {
    let s = format!("{}.{:08}", zat / 100_000_000, zat % 100_000_000);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}
