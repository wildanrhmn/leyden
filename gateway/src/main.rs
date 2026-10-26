mod api;
mod engine;
mod ln;
mod price;
mod store;
mod wallet;

use std::{path::PathBuf, sync::Arc};

use anyhow::Result;
use clap::{Args, Parser, Subcommand};

#[derive(Parser)]
#[command(name = "shieldbolt", about = "Shielded ZEC <-> Lightning gateway")]
struct Cli {
    /// Directory holding the gateway's databases.
    #[arg(long, env = "SHIELDBOLT_DATA", default_value = "./data")]
    data: PathBuf,
    /// File holding the gateway wallet's 24-word mnemonic (created if missing).
    #[arg(long, env = "SHIELDBOLT_ZEC_MNEMONIC")]
    zec_mnemonic: PathBuf,
    /// lightwalletd endpoint.
    #[arg(long, env = "SHIELDBOLT_LWD", default_value = "https://zec.rocks:443")]
    lwd: String,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the gateway.
    Serve(ServeArgs),
    /// Sync the wallet and print its state.
    Status,
    /// Send shielded ZEC from the gateway wallet (operator use).
    Send {
        to: String,
        zat: u64,
        #[arg(long)]
        memo: Option<String>,
    },
}

#[derive(Args)]
struct ServeArgs {
    #[arg(long, env = "SHIELDBOLT_LISTEN", default_value = "127.0.0.1:8080")]
    listen: String,
    /// Public base URL, used for Lightning addresses (name@host).
    #[arg(long, env = "SHIELDBOLT_PUBLIC_URL", default_value = "http://localhost:8080")]
    public_url: String,
    #[arg(long, env = "SHIELDBOLT_WEB", default_value = "./web")]
    web: String,
    #[arg(long, env = "SHIELDBOLT_LN_URL", default_value = "http://127.0.0.1:9737")]
    ln_url: String,
    #[arg(long, env = "SHIELDBOLT_LN_TOKEN")]
    ln_token: String,
    #[arg(long, env = "SHIELDBOLT_FEE_BPS", default_value_t = 100)]
    fee_bps: u64,
    #[arg(long, env = "SHIELDBOLT_MIN_SATS", default_value_t = 100)]
    min_sats: u64,
    #[arg(long, env = "SHIELDBOLT_MAX_SATS", default_value_t = 20_000)]
    max_sats: u64,
    #[arg(long, env = "SHIELDBOLT_QUOTE_TTL", default_value_t = 20 * 60)]
    quote_ttl_secs: i64,
    #[arg(long, env = "SHIELDBOLT_ZEC_FEE_ZAT", default_value_t = 15_000)]
    zec_network_fee_zat: u64,
    #[arg(long, env = "SHIELDBOLT_MIN_CONF", default_value_t = 1)]
    min_conf: u32,
    /// Seconds to keep linking data of finished swaps (default 24 h).
    #[arg(long, env = "SHIELDBOLT_RETAIN_SECS", default_value_t = 24 * 3600)]
    retain_secs: i64,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,zcash_client_backend=warn,zcash_client_sqlite=warn,schemerz=warn".into()),
        )
        .init();
    let cli = Cli::parse();
    std::fs::create_dir_all(&cli.data)?;
    let wallet = wallet::ZecWallet::open_or_create(&cli.data.join("zec"), &cli.zec_mnemonic, &cli.lwd).await?;

    match cli.cmd {
        Cmd::Serve(a) => {
            let app = Arc::new(engine::App {
                wallet,
                ln: ln::Lightning::new(&a.ln_url, &a.ln_token),
                store: store::Store::open(&cli.data.join("swaps.sqlite"))?,
                price: price::PriceFeed::new(),
                cfg: engine::Config {
                    fee_bps: a.fee_bps,
                    min_sats: a.min_sats,
                    max_sats: a.max_sats,
                    quote_ttl_secs: a.quote_ttl_secs,
                    zec_network_fee_zat: a.zec_network_fee_zat,
                    min_conf: a.min_conf,
                    retain_secs: a.retain_secs,
                },
            });
            tokio::spawn(engine::run(app.clone()));
            let web = Arc::new(api::Web { app, public_url: a.public_url });
            let listener = tokio::net::TcpListener::bind(&a.listen).await?;
            tracing::info!("listening on {}", a.listen);
            axum::serve(listener, api::router(web, &a.web)).await?;
        }
        Cmd::Status => {
            wallet.sync().await?;
            println!("height: {:?}", wallet.chain_height()?);
            println!("spendable: {} zat", wallet.spendable_zat()?);
            for r in wallet.received_notes()? {
                println!(
                    "received {} zat d={} tx={} mined={:?}",
                    r.value_zat,
                    hex::encode(r.diversifier),
                    r.txid,
                    r.mined_height
                );
            }
        }
        Cmd::Send { to, zat, memo } => {
            wallet.sync().await?;
            println!("{}", wallet.send(&to, zat, memo.as_deref()).await?);
        }
    }
    Ok(())
}
