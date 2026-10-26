//! HTTP API, LNURL-pay (Lightning addresses), and the static web app.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower_http::services::ServeDir;

use crate::{
    engine::{App, format_zec, now, zip321_uri},
    store::{Direction, Swap, state},
};

pub struct Web {
    pub app: Arc<App>,
    /// e.g. "https://leyden.example"
    pub public_url: String,
}

type AppState = Arc<Web>;

pub fn router(web: Arc<Web>, static_dir: &str) -> Router {
    Router::new()
        .route("/api/info", get(info))
        .route("/api/swaps/pay", post(create_pay))
        .route("/api/swaps/receive", post(create_receive))
        .route("/api/swaps/{id}", get(get_swap))
        .route("/api/ln-address", post(create_ln_address).delete(delete_ln_address))
        .route("/.well-known/lnurlp/{name}", get(lnurlp))
        .route("/lnurlp/{name}/callback", get(lnurlp_callback))
        .fallback_service(ServeDir::new(static_dir))
        .with_state(web)
}

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError(StatusCode::BAD_REQUEST, format!("{e:#}"))
    }
}

/// The public view of a swap: what the user needs to pay, and what happened.
fn view(s: &Swap) -> Value {
    let mut v = json!({
        "id": s.id,
        "direction": s.direction,
        "state": s.state,
        "final": state::is_final(&s.state),
        "created_at": s.created_at,
        "expires_at": s.expires_at,
        "amount_sats": s.amount_sats,
        "zec": format_zec(s.zec_zat),
        "zec_zat": s.zec_zat,
        "error": s.error,
    });
    match s.direction {
        Some(Direction::ZecToLn) => {
            if let Some(addr) = &s.deposit_address {
                v["deposit_address"] = json!(addr);
                v["payment_uri"] = json!(zip321_uri(addr, s.zec_zat));
            }
            v["received_zec"] = json!(s.received_zat.map(format_zec));
            v["deposit_txid"] = json!(s.deposit_txid);
            v["preimage"] = json!(s.preimage);
            v["refund_txid"] = json!(s.refund_txid);
        }
        Some(Direction::LnToZec) => {
            v["invoice"] = json!(s.ln_invoice);
            v["payout_txid"] = json!(s.payout_txid);
        }
        None => {}
    }
    v
}

async fn info(State(w): State<AppState>) -> Result<Json<Value>, ApiError> {
    let app = &w.app;
    let rate = app.price.rate().await?;
    let ln_sats = app.ln.balance_sats().await.unwrap_or(0);
    let zec_zat = app.wallet.spendable_zat().unwrap_or(0);
    Ok(Json(json!({
        "rate": { "zec_usd": rate.zec_usd, "btc_usd": rate.btc_usd, "zat_per_sat": rate.zat_per_sat() },
        "fee_bps": app.cfg.fee_bps,
        "min_sats": app.cfg.min_sats,
        "max_sats": app.cfg.max_sats,
        "quote_ttl_secs": app.cfg.quote_ttl_secs,
        "zec_network_fee_zat": app.cfg.zec_network_fee_zat,
        "min_conf": app.cfg.min_conf,
        "retain_secs": app.cfg.retain_secs,
        "liquidity": { "lightning_sats": ln_sats, "zec_zat": zec_zat },
        "lightning_address_domain": domain(&w.public_url),
    })))
}

#[derive(Deserialize)]
struct PayReq {
    invoice: String,
    refund_address: String,
}

async fn create_pay(State(w): State<AppState>, Json(r): Json<PayReq>) -> Result<Json<Value>, ApiError> {
    let swap = w.app.quote_pay(&r.invoice, &r.refund_address).await?;
    Ok(Json(view(&swap)))
}

#[derive(Deserialize)]
struct ReceiveReq {
    payout_address: String,
    amount_sats: u64,
    memo: Option<String>,
}

async fn create_receive(State(w): State<AppState>, Json(r): Json<ReceiveReq>) -> Result<Json<Value>, ApiError> {
    let swap = w.app.quote_receive(&r.payout_address, r.amount_sats, r.memo).await?;
    Ok(Json(view(&swap)))
}

async fn get_swap(State(w): State<AppState>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    match w.app.store.get(&id)? {
        Some(s) => Ok(Json(view(&s))),
        None => Err(ApiError(StatusCode::NOT_FOUND, "unknown swap".into())),
    }
}

// --- Lightning addresses ---------------------------------------------------------

#[derive(Deserialize)]
struct LnAddressReq {
    name: String,
    payout_address: Option<String>,
    manage_key: Option<String>,
}

fn valid_name(name: &str) -> bool {
    (3..=32).contains(&name.len())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn hash_key(k: &str) -> String {
    hex::encode(Sha256::digest(k.as_bytes()))
}

async fn create_ln_address(State(w): State<AppState>, Json(r): Json<LnAddressReq>) -> Result<Json<Value>, ApiError> {
    let name = r.name.trim().to_lowercase();
    if !valid_name(&name) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "name must be 3-32 characters: a-z, 0-9, - or _".into()));
    }
    let payout = r.payout_address.unwrap_or_default();
    crate::wallet::parse_shielded_recipient(&payout, &zcash_protocol::consensus::Network::MainNetwork)?;
    let manage_key = uuid::Uuid::new_v4().simple().to_string();
    if !w.app.store.add_ln_address(&name, payout.trim(), &hash_key(&manage_key), now())? {
        return Err(ApiError(StatusCode::CONFLICT, "that name is taken".into()));
    }
    Ok(Json(json!({
        "lightning_address": format!("{name}@{}", domain(&w.public_url)),
        "manage_key": manage_key,
    })))
}

async fn delete_ln_address(State(w): State<AppState>, Json(r): Json<LnAddressReq>) -> Result<Json<Value>, ApiError> {
    let deleted = w
        .app
        .store
        .delete_ln_address(&r.name.trim().to_lowercase(), &hash_key(r.manage_key.as_deref().unwrap_or("")))?;
    if deleted {
        Ok(Json(json!({ "deleted": true })))
    } else {
        Err(ApiError(StatusCode::NOT_FOUND, "no such address or wrong manage key".into()))
    }
}

fn domain(public_url: &str) -> String {
    public_url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string()
}

fn lnurl_metadata(name: &str, domain: &str) -> String {
    json!([
        ["text/plain", format!("Pay {name}@{domain}. Arrives as shielded ZEC.")],
        ["text/identifier", format!("{name}@{domain}")]
    ])
    .to_string()
}

fn lnurl_error(reason: impl Into<String>) -> Json<Value> {
    Json(json!({ "status": "ERROR", "reason": reason.into() }))
}

async fn lnurlp(State(w): State<AppState>, Path(name): Path<String>) -> Json<Value> {
    let name = name.to_lowercase();
    match w.app.store.ln_address(&name) {
        Ok(Some(_)) => {}
        _ => return lnurl_error("unknown Lightning address"),
    }
    let d = domain(&w.public_url);
    Json(json!({
        "tag": "payRequest",
        "callback": format!("{}/lnurlp/{name}/callback", w.public_url.trim_end_matches('/')),
        "minSendable": w.app.cfg.min_sats * 1000,
        "maxSendable": w.app.cfg.max_sats * 1000,
        "metadata": lnurl_metadata(&name, &d),
        "commentAllowed": 200,
    }))
}

#[derive(Deserialize)]
struct CallbackQuery {
    amount: u64,
    comment: Option<String>,
}

async fn lnurlp_callback(
    State(w): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<CallbackQuery>,
) -> Json<Value> {
    let name = name.to_lowercase();
    let Ok(Some(payout)) = w.app.store.ln_address(&name) else {
        return lnurl_error("unknown Lightning address");
    };
    if q.amount % 1000 != 0 {
        return lnurl_error("amount must be a whole number of sats");
    }
    let d = domain(&w.public_url);
    let description_hash = hex::encode(Sha256::digest(lnurl_metadata(&name, &d).as_bytes()));
    match w
        .app
        .quote_receive_inner(&payout, q.amount / 1000, q.comment.filter(|c| !c.is_empty()), Some(&description_hash))
        .await
    {
        Ok(swap) => Json(json!({ "pr": swap.ln_invoice, "routes": [] })),
        Err(e) => lnurl_error(format!("{e:#}")),
    }
}
