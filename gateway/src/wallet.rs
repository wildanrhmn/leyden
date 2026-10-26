//! The gateway's shielded ZEC wallet.
//!
//! A thin layer over `zcash_client_backend` / `zcash_client_sqlite`:
//!
//! - syncs from compact blocks only (trial decryption happens here, so the
//!   lightwalletd server never learns which outputs are ours);
//! - hands out a fresh Orchard-only diversified address per quote, so incoming
//!   payments are matched to quotes by their diversifier. We never fetch a
//!   transaction by txid, which would tell the server which ones are ours;
//! - sends shielded payments, refusing any recipient without a shielded receiver.

use std::{
    collections::BTreeMap,
    num::NonZeroUsize,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, Mutex as StdMutex},
};

use anyhow::{Context, Result, anyhow, bail};
use async_trait::async_trait;
use bip0039::{Count, English, Mnemonic};
use rand::{rand_core::UnwrapErr, rngs::SysRng};
use secrecy::{ExposeSecret, SecretVec};
use tokio::sync::Mutex;
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use zcash_address::ZcashAddress;
use zcash_client_backend::{
    data_api::{
        Account as _, AccountBirthday, WalletRead, WalletWrite,
        chain::{BlockCache, BlockSource, error::Error as ChainError},
        scanning::ScanRange,
        wallet::{
            ConfirmationsPolicy, SpendingKeys, create_proposed_transactions,
            input_selection::{GreedyInputSelector, SpendPolicy},
            propose_transfer,
        },
    },
    fees::{DustOutputPolicy, SplitPolicy, StandardFeeRule, standard::MultiOutputChangeStrategy},
    proto::{
        compact_formats::CompactBlock,
        service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
    },
    wallet::OvkPolicy,
};
use zcash_client_sqlite::{WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedFullViewingKey, UnifiedSpendingKey};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{
    ShieldedPool,
    consensus::{BlockHeight, MainNetwork, Network, Parameters},
    memo::{Memo, MemoBytes},
    value::Zatoshis,
};
use zip32::DiversifierIndex;
use zip321::{Payment, TransactionRequest};

const DATA_DB: &str = "data.sqlite";
const ACCOUNT_NAME: &str = "gateway";
/// Diversifier indices below this are left for the wallet's own use.
const QUOTE_DIVERSIFIER_BASE: u64 = 1 << 32;

pub type Db = WalletDb<rusqlite::Connection, Network, SystemClock, UnwrapErr<SysRng>>;

/// A note the wallet received on one of the per-quote addresses.
#[derive(Clone, Debug)]
pub struct Received {
    pub diversifier: [u8; 11],
    pub value_zat: u64,
    pub txid: String,
    pub mined_height: Option<u32>,
}

pub struct ZecWallet {
    params: Network,
    dir: PathBuf,
    server: String,
    seed: SecretVec<u8>,
    ufvk: UnifiedFullViewingKey,
    account_index: zip32::AccountId,
    /// Serialises database writers (sync and send).
    lock: Mutex<()>,
}

impl ZecWallet {
    /// Opens the wallet in `dir`, creating it (with a birthday near the chain tip)
    /// if it does not exist yet. The mnemonic is read from `mnemonic_file`, which is
    /// created with a fresh 24-word phrase if missing.
    pub async fn open_or_create(dir: &Path, mnemonic_file: &Path, server: &str) -> Result<Self> {
        let params = Network::MainNetwork;
        std::fs::create_dir_all(dir)?;

        let phrase = if mnemonic_file.exists() {
            std::fs::read_to_string(mnemonic_file)?.trim().to_string()
        } else {
            let m = <Mnemonic<English>>::generate(Count::Words24);
            write_secret(mnemonic_file, m.phrase())?;
            m.phrase().to_string()
        };
        let mnemonic = <Mnemonic<English>>::from_phrase(&phrase).context("invalid mnemonic")?;
        let seed = SecretVec::new(mnemonic.to_seed("").to_vec());

        let db_path = dir.join(DATA_DB);
        let fresh = !db_path.exists();
        let mut db = open_db(&db_path, params)?;
        init_wallet_db(&mut db, Some(SecretVec::new(seed.expose_secret().clone())))
            .map_err(|e| anyhow!("wallet db migration failed: {e:?}"))?;

        if fresh || db.get_account_ids()?.is_empty() {
            let mut client = connect(server).await?;
            let tip = client
                .get_latest_block(service::ChainSpec::default())
                .await?
                .into_inner()
                .height;
            // The tree state is for the block before the birthday.
            let birthday_height = tip.saturating_sub(10);
            let treestate = client
                .get_tree_state(service::BlockId {
                    height: birthday_height - 1,
                    ..Default::default()
                })
                .await?
                .into_inner();
            let birthday = AccountBirthday::from_treestate(treestate, None)
                .map_err(|e| anyhow!("bad birthday tree state: {e:?}"))?;
            db.create_account(ACCOUNT_NAME, &seed, &birthday, None)?;
            tracing::info!(birthday_height, "created gateway wallet");
        }

        let account_id = *db
            .get_account_ids()?
            .first()
            .ok_or_else(|| anyhow!("wallet has no account"))?;
        let account = db
            .get_account(account_id)?
            .ok_or_else(|| anyhow!("account vanished"))?;
        let ufvk = account
            .ufvk()
            .cloned()
            .ok_or_else(|| anyhow!("account has no UFVK"))?;
        let account_index = account
            .source()
            .key_derivation()
            .ok_or_else(|| anyhow!("account is not derived from the seed"))?
            .account_index();

        Ok(Self {
            params,
            dir: dir.to_path_buf(),
            server: server.to_string(),
            seed,
            ufvk,
            account_index,
            lock: Mutex::new(()),
        })
    }

    fn db(&self) -> Result<Db> {
        open_db(&self.dir.join(DATA_DB), self.params)
    }

    /// Scans new compact blocks until the wallet is at the chain tip.
    pub async fn sync(&self) -> Result<()> {
        let _guard = self.lock.lock().await;
        let mut client = connect(&self.server).await?;
        let mut db = self.db()?;
        let cache = MemBlockCache::default();
        zcash_client_backend::sync::run(&mut client, &self.params, &cache, &mut db, 1000)
            .await
            .map_err(|e| anyhow!("sync failed: {e}"))?;
        Ok(())
    }

    /// The Orchard-only address for a quote, and the diversifier that identifies
    /// notes paid to it. Addresses for different quotes are unlinkable to anyone
    /// without our viewing key.
    pub fn quote_address(&self, quote_seq: u64) -> Result<(String, [u8; 11])> {
        let j = DiversifierIndex::from(QUOTE_DIVERSIFIER_BASE + quote_seq);
        let ua = self
            .ufvk
            .address(j, UnifiedAddressRequest::ORCHARD)
            .map_err(|e| anyhow!("address generation failed: {e:?}"))?;
        let d = *ua
            .orchard()
            .ok_or_else(|| anyhow!("no orchard receiver"))?
            .diversifier()
            .as_array();
        Ok((ua.encode(&self.params), d))
    }

    /// The operator's own funding address: Orchard-only, at diversifier index 0. Quote
    /// addresses start at 2^32, so ZEC sent here only adds liquidity and is never
    /// mistaken for a swap deposit.
    pub fn funding_address(&self) -> Result<String> {
        let ua = self
            .ufvk
            .address(DiversifierIndex::from(0u64), UnifiedAddressRequest::ORCHARD)
            .map_err(|e| anyhow!("address generation failed: {e:?}"))?;
        Ok(ua.encode(&self.params))
    }

    /// The last height the wallet has scanned up to (the chain tip as of last sync).
    pub fn chain_height(&self) -> Result<Option<u32>> {
        Ok(self.db()?.chain_height()?.map(u32::from))
    }

    /// Every non-change note the wallet has received, in either Orchard-family pool.
    pub fn received_notes(&self) -> Result<Vec<Received>> {
        let conn = rusqlite::Connection::open(self.dir.join(DATA_DB))?;
        let mut out = vec![];
        for table in ["ironwood_received_notes", "orchard_received_notes"] {
            let sql = format!(
                "SELECT n.diversifier, n.value, t.txid, t.mined_height
                 FROM {table} n JOIN transactions t ON t.id_tx = n.transaction_id
                 WHERE n.is_change = 0"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map([], |row| {
                let d: Vec<u8> = row.get(0)?;
                let value: i64 = row.get(1)?;
                let mut txid: Vec<u8> = row.get(2)?;
                let mined: Option<u32> = row.get(3)?;
                txid.reverse(); // display order
                Ok((d, value, hex::encode(txid), mined))
            })?;
            for r in rows {
                let (d, value, txid, mined_height) = r?;
                let Ok(diversifier) = <[u8; 11]>::try_from(d.as_slice()) else {
                    continue;
                };
                out.push(Received {
                    diversifier,
                    value_zat: value as u64,
                    txid,
                    mined_height,
                });
            }
        }
        Ok(out)
    }

    /// Spendable balance in zatoshis under the confirmation policy we send with.
    pub fn spendable_zat(&self) -> Result<u64> {
        let db = self.db()?;
        let summary = db
            .get_wallet_summary(send_policy())?
            .ok_or_else(|| anyhow!("wallet not synced yet"))?;
        Ok(summary
            .account_balances()
            .values()
            .map(|b| u64::from(b.spendable_value()))
            .sum())
    }

    /// Sends `value_zat` to a shielded recipient, returning the txid.
    pub async fn send(&self, to: &str, value_zat: u64, memo: Option<&str>) -> Result<String> {
        let recipient = parse_shielded_recipient(to, &self.params)?;
        let payment = Payment::new(
            recipient,
            Some(Zatoshis::from_u64(value_zat).map_err(|_| anyhow!("bad amount"))?),
            memo.map(Memo::from_str)
                .transpose()
                .map_err(|_| anyhow!("memo too long"))?
                .map(MemoBytes::from),
            None,
            None,
            vec![],
        )
        .map_err(|e| anyhow!("bad payment: {e:?}"))?;
        let request =
            TransactionRequest::new(vec![payment]).map_err(|e| anyhow!("bad request: {e:?}"))?;

        let _guard = self.lock.lock().await;
        let mut db = self.db()?;
        let account_id = *db.get_account_ids()?.first().ok_or_else(|| anyhow!("no account"))?;
        let usk = UnifiedSpendingKey::from_seed(&self.params, self.seed.expose_secret(), self.account_index)
            .map_err(|e| anyhow!("key derivation failed: {e:?}"))?;

        let change_strategy = MultiOutputChangeStrategy::new(
            StandardFeeRule::Zip317,
            None,
            ShieldedPool::Orchard,
            DustOutputPolicy::default(),
            SplitPolicy::with_min_output_value(
                NonZeroUsize::new(4).unwrap(),
                Zatoshis::const_from_u64(100_000),
            ),
        );
        let proposal = propose_transfer::<_, _, _, _, std::convert::Infallible>(
            &mut db,
            &self.params,
            account_id,
            &GreedyInputSelector::new(),
            &change_strategy,
            request,
            send_policy(),
            &SpendPolicy::default(),
            None,
            None,
        )
        .map_err(|e| anyhow!("could not build payment: {e}"))?;

        let prover = LocalTxProver::bundled();
        let txids = create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
            &mut db,
            &self.params,
            &SystemClock,
            &mut UnwrapErr(SysRng),
            &prover,
            &prover,
            &SpendingKeys::from_unified_spending_key(usk),
            OvkPolicy::Sender,
            &proposal,
            None,
        )
        .map_err(|e| anyhow!("could not create transaction: {e}"))?;
        if txids.len() != 1 {
            bail!("multi-transaction proposals are not supported");
        }
        let txid = *txids.first();
        let tx = db
            .get_transaction(txid)?
            .ok_or_else(|| anyhow!("created transaction not found"))?;
        let mut raw = service::RawTransaction::default();
        tx.write(&mut raw.data)?;

        let mut client = connect(&self.server).await?;
        let resp = client.send_transaction(raw).await?.into_inner();
        if resp.error_code != 0 {
            bail!("broadcast rejected ({}): {}", resp.error_code, resp.error_message);
        }
        Ok(tx.txid().to_string())
    }
}

/// Notes received from strangers are spendable after 3 confirmations; our own
/// change after 1. Low enough for a responsive gateway, without dropping to zero-conf.
fn send_policy() -> ConfirmationsPolicy {
    ConfirmationsPolicy::new(
        std::num::NonZeroU32::new(1).unwrap(),
        std::num::NonZeroU32::new(3).unwrap(),
    )
    .expect("valid policy")
}

/// Accepts only addresses that carry a shielded receiver, and only on mainnet.
/// Transparent and TEX addresses are rejected: the gateway never pays out in the clear.
pub fn parse_shielded_recipient(addr: &str, params: &Network) -> Result<ZcashAddress> {
    let parsed = ZcashAddress::from_str(addr.trim()).map_err(|_| anyhow!("not a Zcash address"))?;
    let ok = parsed.can_receive_as(zcash_protocol::PoolType::Shielded(ShieldedPool::Orchard))
        || parsed.can_receive_as(zcash_protocol::PoolType::Shielded(ShieldedPool::Sapling));
    if !ok {
        bail!("address has no shielded receiver; Leyden only pays shielded addresses");
    }
    // Re-encode through the network check: errors if the address is for another network.
    parsed
        .clone()
        .convert_if_network::<zcash_keys::address::Address>(params.network_type())
        .map_err(|_| anyhow!("address is not a mainnet address"))?;
    Ok(parsed)
}

fn open_db(path: &Path, params: Network) -> Result<Db> {
    Ok(WalletDb::for_path(path, params, SystemClock, UnwrapErr(SysRng))?)
}

pub async fn connect(server: &str) -> Result<CompactTxStreamerClient<Channel>> {
    let channel = Endpoint::from_shared(server.to_string())?
        .tls_config(ClientTlsConfig::new().with_webpki_roots())?
        .connect()
        .await
        .with_context(|| format!("connecting to {server}"))?;
    Ok(CompactTxStreamerClient::new(channel)
        .max_decoding_message_size(64 * 1024 * 1024))
}

pub fn write_secret(path: &Path, contents: &str) -> Result<()> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    opts.mode(0o600);
    let mut f = opts.open(path)?;
    writeln!(f, "{contents}")?;
    Ok(())
}

#[allow(dead_code)]
fn _assert_mainnet_params() -> MainNetwork {
    MainNetwork
}

// --- In-memory compact block cache used during sync -----------------------------

#[derive(Debug)]
pub struct CacheError(String);
impl std::fmt::Display for CacheError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for CacheError {}

#[derive(Default)]
pub struct MemBlockCache {
    blocks: Arc<StdMutex<BTreeMap<u32, CompactBlock>>>,
}

impl BlockSource for MemBlockCache {
    type Error = CacheError;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), ChainError<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), ChainError<WalletErrT, Self::Error>>,
    {
        let blocks: Vec<CompactBlock> = {
            let guard = self.blocks.lock().unwrap();
            let start = from_height.map(u32::from).unwrap_or(0);
            guard
                .range(start..)
                .take(limit.unwrap_or(usize::MAX))
                .map(|(_, b)| b.clone())
                .collect()
        };
        for b in blocks {
            with_block(b)?;
        }
        Ok(())
    }
}

#[async_trait]
impl BlockCache for MemBlockCache {
    fn get_tip_height(&self, range: Option<&ScanRange>) -> Result<Option<BlockHeight>, Self::Error> {
        let guard = self.blocks.lock().unwrap();
        let tip = match range {
            Some(r) => {
                let (s, e) = (u32::from(r.block_range().start), u32::from(r.block_range().end));
                guard.range(s..e).next_back().map(|(h, _)| *h)
            }
            None => guard.keys().next_back().copied(),
        };
        Ok(tip.map(BlockHeight::from_u32))
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let guard = self.blocks.lock().unwrap();
        let (s, e) = (u32::from(range.block_range().start), u32::from(range.block_range().end));
        Ok(guard.range(s..e).map(|(_, b)| b.clone()).collect())
    }

    async fn insert(&self, compact_blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        let mut guard = self.blocks.lock().unwrap();
        for b in compact_blocks {
            guard.insert(b.height as u32, b);
        }
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        let mut guard = self.blocks.lock().unwrap();
        let (s, e) = (u32::from(range.block_range().start), u32::from(range.block_range().end));
        let doomed: Vec<u32> = guard.range(s..e).map(|(h, _)| *h).collect();
        for h in doomed {
            guard.remove(&h);
        }
        Ok(())
    }
}
