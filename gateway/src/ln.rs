//! Client for the Lightning sidecar (see `lightning/server.mjs`).

use anyhow::{Result, anyhow};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

#[derive(Clone)]
pub struct Lightning {
    base: String,
    token: String,
    http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decoded {
    pub amount_msat: Option<u64>,
    pub expires_at: i64,
    pub network: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invoice {
    pub id: String,
    pub bolt11: String,
}

#[derive(Debug, Deserialize)]
pub struct InvoiceStatus {
    pub paid: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayStatus {
    pub status: String,
    pub done: bool,
    pub failed: bool,
    pub preimage: Option<String>,
}

impl Lightning {
    pub fn new(base: &str, token: &str) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            token: token.to_string(),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .expect("http client"),
        }
    }

    async fn call<T: DeserializeOwned>(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<T> {
        let mut req = self
            .http
            .request(method, format!("{}{}", self.base, path))
            .bearer_auth(&self.token);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await?;
        let status = resp.status();
        let v: Value = resp.json().await?;
        if !status.is_success() {
            return Err(anyhow!(
                "lightning backend: {}",
                v.get("error").and_then(Value::as_str).unwrap_or("request failed")
            ));
        }
        Ok(serde_json::from_value(v)?)
    }

    pub async fn decode(&self, bolt11: &str) -> Result<Decoded> {
        self.call(reqwest::Method::POST, "/decode", Some(json!({ "bolt11": bolt11 }))).await
    }

    pub async fn fee_estimate(&self, bolt11: &str) -> Result<u64> {
        let v: Value = self.call(reqwest::Method::POST, "/fee", Some(json!({ "bolt11": bolt11 }))).await?;
        Ok(v["feeSats"].as_f64().unwrap_or(0.0).ceil() as u64)
    }

    pub async fn create_invoice(&self, amount_sats: u64, memo: Option<&str>, description_hash: Option<&str>, expiry_secs: u64) -> Result<Invoice> {
        self.call(
            reqwest::Method::POST,
            "/invoice",
            Some(json!({
                "amountSats": amount_sats,
                "memo": memo,
                "descriptionHash": description_hash,
                "expirySecs": expiry_secs,
            })),
        )
        .await
    }

    pub async fn invoice_status(&self, id: &str) -> Result<InvoiceStatus> {
        self.call(reqwest::Method::GET, &format!("/invoice/{id}"), None).await
    }

    pub async fn pay(&self, bolt11: &str, max_fee_sats: u64) -> Result<String> {
        let v: Value = self
            .call(reqwest::Method::POST, "/pay", Some(json!({ "bolt11": bolt11, "maxFeeSats": max_fee_sats })))
            .await?;
        v["id"].as_str().map(str::to_string).ok_or_else(|| anyhow!("no payment id"))
    }

    pub async fn pay_status(&self, id: &str) -> Result<PayStatus> {
        self.call(reqwest::Method::GET, &format!("/pay/{id}"), None).await
    }

    pub async fn balance_sats(&self) -> Result<u64> {
        let v: Value = self.call(reqwest::Method::GET, "/balance", None).await?;
        Ok(v["sats"].as_u64().unwrap_or(0))
    }
}
