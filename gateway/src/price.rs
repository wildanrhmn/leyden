//! ZEC/BTC rate, from the public NEAR Intents token list (cached for a minute).

use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use serde::Deserialize;
use tokio::sync::Mutex;

const TOKENS_URL: &str = "https://1click.chaindefuser.com/v0/tokens";
const ZEC: &str = "nep141:zec.omft.near";
const BTC: &str = "nep141:btc.omft.near";

#[derive(Deserialize)]
struct Token {
    #[serde(rename = "assetId")]
    asset_id: String,
    price: f64,
}

#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct Rate {
    pub zec_usd: f64,
    pub btc_usd: f64,
}

impl Rate {
    /// Zatoshis worth one satoshi.
    pub fn zat_per_sat(&self) -> f64 {
        self.btc_usd / self.zec_usd
    }
}

pub struct PriceFeed {
    http: reqwest::Client,
    cached: Mutex<Option<(Instant, Rate)>>,
}

impl PriceFeed {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("http client"),
            cached: Mutex::new(None),
        }
    }

    pub async fn rate(&self) -> Result<Rate> {
        let mut cached = self.cached.lock().await;
        if let Some((at, rate)) = *cached {
            if at.elapsed() < Duration::from_secs(60) {
                return Ok(rate);
            }
        }
        let tokens: Vec<Token> = self.http.get(TOKENS_URL).send().await?.json().await?;
        let find = |id: &str| {
            tokens
                .iter()
                .find(|t| t.asset_id == id)
                .map(|t| t.price)
                .filter(|p| *p > 0.0)
                .ok_or_else(|| anyhow!("no price for {id}"))
        };
        let rate = Rate { zec_usd: find(ZEC)?, btc_usd: find(BTC)? };
        *cached = Some((Instant::now(), rate));
        Ok(rate)
    }
}
