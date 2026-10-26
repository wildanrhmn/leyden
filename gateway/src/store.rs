//! Swap records.
//!
//! The store holds only what a swap needs while it is in flight. Once a swap reaches a
//! final state, `purge_finished` erases every field that could link the two sides
//! (Lightning invoice, Zcash addresses, txids, preimage) after the retention window.

use std::{path::Path, sync::Mutex};

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    /// User pays shielded ZEC, gateway pays a Lightning invoice.
    ZecToLn,
    /// User pays a Lightning invoice, gateway pays shielded ZEC.
    LnToZec,
}

impl Direction {
    fn as_str(self) -> &'static str {
        match self {
            Direction::ZecToLn => "zec_to_ln",
            Direction::LnToZec => "ln_to_zec",
        }
    }
    fn parse(s: &str) -> Self {
        if s == "ln_to_zec" { Direction::LnToZec } else { Direction::ZecToLn }
    }
}

/// Swap states. ZEC→LN: awaiting_zec → paying_ln → complete | refunding → refunded.
/// LN→ZEC: awaiting_ln → paying_zec → complete. Either may end `expired` or `failed`.
pub mod state {
    pub const AWAITING_ZEC: &str = "awaiting_zec";
    pub const PAYING_LN: &str = "paying_ln";
    pub const REFUNDING: &str = "refunding";
    pub const REFUNDED: &str = "refunded";
    pub const AWAITING_LN: &str = "awaiting_ln";
    pub const PAYING_ZEC: &str = "paying_zec";
    pub const COMPLETE: &str = "complete";
    pub const EXPIRED: &str = "expired";
    pub const FAILED: &str = "failed";

    pub fn is_final(s: &str) -> bool {
        matches!(s, COMPLETE | REFUNDED | EXPIRED | FAILED)
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Swap {
    pub id: String,
    #[serde(skip)]
    pub seq: i64,
    pub direction: Option<Direction>,
    pub state: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub amount_sats: i64,
    /// ZEC the user must pay (zec_to_ln) or will receive (ln_to_zec), in zatoshis.
    pub zec_zat: i64,
    /// zec_to_ln: the per-swap shielded deposit address.
    pub deposit_address: Option<String>,
    #[serde(skip)]
    pub deposit_diversifier: Option<String>,
    pub received_zat: Option<i64>,
    pub deposit_txid: Option<String>,
    /// zec_to_ln: the invoice being paid.
    pub bolt11: Option<String>,
    pub max_fee_sats: Option<i64>,
    #[serde(skip)]
    pub ln_payment_id: Option<String>,
    pub preimage: Option<String>,
    pub refund_address: Option<String>,
    pub refund_txid: Option<String>,
    /// ln_to_zec: the invoice the user pays, and where the ZEC goes.
    pub ln_invoice: Option<String>,
    #[serde(skip)]
    pub ln_invoice_id: Option<String>,
    pub payout_address: Option<String>,
    #[serde(skip)]
    pub payout_memo: Option<String>,
    pub payout_txid: Option<String>,
    pub error: Option<String>,
    #[serde(skip)]
    pub finished_at: Option<i64>,
}

pub struct Store {
    conn: Mutex<Connection>,
}

const COLUMNS: &str = "id, seq, direction, state, created_at, expires_at, amount_sats, zec_zat,
    deposit_address, deposit_diversifier, received_zat, deposit_txid, bolt11, max_fee_sats,
    ln_payment_id, preimage, refund_address, refund_txid, ln_invoice, ln_invoice_id,
    payout_address, payout_memo, payout_txid, error, finished_at";

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS swaps (
                 id TEXT PRIMARY KEY,
                 seq INTEGER NOT NULL UNIQUE,
                 direction TEXT NOT NULL,
                 state TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 expires_at INTEGER NOT NULL,
                 amount_sats INTEGER NOT NULL,
                 zec_zat INTEGER NOT NULL,
                 deposit_address TEXT,
                 deposit_diversifier TEXT,
                 received_zat INTEGER,
                 deposit_txid TEXT,
                 bolt11 TEXT,
                 max_fee_sats INTEGER,
                 ln_payment_id TEXT,
                 preimage TEXT,
                 refund_address TEXT,
                 refund_txid TEXT,
                 ln_invoice TEXT,
                 ln_invoice_id TEXT,
                 payout_address TEXT,
                 payout_memo TEXT,
                 payout_txid TEXT,
                 error TEXT,
                 finished_at INTEGER
             );
             CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS ln_addresses (
                 name TEXT PRIMARY KEY,
                 payout_address TEXT NOT NULL,
                 manage_key_hash TEXT NOT NULL,
                 created_at INTEGER NOT NULL
             );
             INSERT OR IGNORE INTO counters VALUES ('seq', 0);",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Reserves the next sequence number (one diversified address per swap, never reused,
    /// even after the swap row itself has been purged).
    pub fn next_seq(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE counters SET value = value + 1 WHERE name = 'seq'", [])?;
        Ok(conn.query_row("SELECT value FROM counters WHERE name = 'seq'", [], |r| r.get(0))?)
    }

    pub fn insert(&self, s: &Swap) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            &format!("INSERT INTO swaps ({COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)"),
            params![
                s.id, s.seq, s.direction.unwrap_or(Direction::ZecToLn).as_str(), s.state,
                s.created_at, s.expires_at, s.amount_sats, s.zec_zat, s.deposit_address,
                s.deposit_diversifier, s.received_zat, s.deposit_txid, s.bolt11, s.max_fee_sats,
                s.ln_payment_id, s.preimage, s.refund_address, s.refund_txid, s.ln_invoice,
                s.ln_invoice_id, s.payout_address, s.payout_memo, s.payout_txid, s.error, s.finished_at
            ],
        )?;
        Ok(())
    }

    pub fn update(&self, s: &Swap) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE swaps SET state=?2, received_zat=?3, deposit_txid=?4, ln_payment_id=?5,
                preimage=?6, refund_txid=?7, payout_txid=?8, error=?9, finished_at=?10
             WHERE id=?1",
            params![
                s.id, s.state, s.received_zat, s.deposit_txid, s.ln_payment_id, s.preimage,
                s.refund_txid, s.payout_txid, s.error, s.finished_at
            ],
        )?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<Swap>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row(&format!("SELECT {COLUMNS} FROM swaps WHERE id = ?1"), [id], from_row)
            .optional()?)
    }

    pub fn active(&self) -> Result<Vec<Swap>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM swaps WHERE state NOT IN ('complete','refunded','expired','failed') ORDER BY seq"
        ))?;
        let rows = stmt.query_map([], from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Diversifiers of every swap that still has a deposit address on record, including
    /// finished ones, so a late payment to an old address is still recognised.
    pub fn known_diversifiers(&self) -> Result<Vec<(String, String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, deposit_diversifier, state FROM swaps WHERE deposit_diversifier IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Erases linking data from swaps that finished more than `retain_secs` ago. The row
    /// keeps only id, direction, state, amounts and timestamps, so the status page still
    /// answers, but nothing ties a Zcash payment to a Lightning payment any more.
    pub fn purge_finished(&self, now: i64, retain_secs: i64) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            "UPDATE swaps SET deposit_address=NULL, deposit_diversifier=NULL, deposit_txid=NULL,
                bolt11=NULL, ln_payment_id=NULL, preimage=NULL, refund_address=NULL, refund_txid=NULL,
                ln_invoice=NULL, ln_invoice_id=NULL, payout_address=NULL, payout_memo=NULL,
                payout_txid=NULL, error=NULL
             WHERE finished_at IS NOT NULL AND finished_at < ?1
               AND (deposit_address IS NOT NULL OR bolt11 IS NOT NULL OR ln_invoice IS NOT NULL
                    OR payout_address IS NOT NULL)",
            [now - retain_secs],
        )?)
    }
}

impl Store {
    /// Registers `name@domain`. Fails if the name is taken.
    pub fn add_ln_address(&self, name: &str, payout_address: &str, manage_key_hash: &str, now: i64) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            "INSERT OR IGNORE INTO ln_addresses (name, payout_address, manage_key_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![name, payout_address, manage_key_hash, now],
        )? == 1)
    }

    pub fn ln_address(&self, name: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row("SELECT payout_address FROM ln_addresses WHERE name = ?1", [name], |r| r.get(0))
            .optional()?)
    }

    /// Deletes a Lightning address, given the manage key returned when it was created.
    pub fn delete_ln_address(&self, name: &str, manage_key_hash: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            "DELETE FROM ln_addresses WHERE name = ?1 AND manage_key_hash = ?2",
            params![name, manage_key_hash],
        )? == 1)
    }
}

fn from_row(r: &Row<'_>) -> rusqlite::Result<Swap> {
    Ok(Swap {
        id: r.get(0)?,
        seq: r.get(1)?,
        direction: Some(Direction::parse(&r.get::<_, String>(2)?)),
        state: r.get(3)?,
        created_at: r.get(4)?,
        expires_at: r.get(5)?,
        amount_sats: r.get(6)?,
        zec_zat: r.get(7)?,
        deposit_address: r.get(8)?,
        deposit_diversifier: r.get(9)?,
        received_zat: r.get(10)?,
        deposit_txid: r.get(11)?,
        bolt11: r.get(12)?,
        max_fee_sats: r.get(13)?,
        ln_payment_id: r.get(14)?,
        preimage: r.get(15)?,
        refund_address: r.get(16)?,
        refund_txid: r.get(17)?,
        ln_invoice: r.get(18)?,
        ln_invoice_id: r.get(19)?,
        payout_address: r.get(20)?,
        payout_memo: r.get(21)?,
        payout_txid: r.get(22)?,
        error: r.get(23)?,
        finished_at: r.get(24)?,
    })
}
