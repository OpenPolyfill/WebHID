//! Library surface of `webhid-mock`, shared between the CLI binary and
//! cross-crate tests (the daemon's uhid identity regression tests create
//! virtual devices directly through the platform backends).

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(not(target_os = "windows"))]
use anyhow::Context as _;

/// Options for spawning one virtual HID device.
#[cfg(not(target_os = "windows"))]
pub struct SpawnOpts {
    pub vid: u16,
    pub pid: u16,
    pub name: String,
    pub descriptor_path: String,
    pub usage_page: Option<u16>,
    pub usage: Option<u16>,
    pub bus: u16,
    pub version: u16,
    pub country: u8,
}

/// A spawned virtual HID device. Platform backends implement this in
/// `linux.rs` / `macos.rs`; the JSON command handler only needs input
/// injection, everything else (event echoing) is backend-specific.
#[cfg(not(target_os = "windows"))]
pub trait MockDevice {
    /// Inject an input report into the host. `payload` must already include
    /// the report ID as its first byte for numbered-report devices.
    fn send_input(&self, payload: &[u8]) -> anyhow::Result<()>;
}

#[cfg(not(target_os = "windows"))]
#[derive(PartialEq)]
pub enum LoopAction {
    Continue,
    Exit,
}

/// Handle one JSON command line. Shared by all platform event loops.
#[cfg(not(target_os = "windows"))]
pub fn handle_command(dev: &dyn MockDevice, line: &str) -> anyhow::Result<LoopAction> {
    #[derive(serde::Deserialize)]
    #[serde(tag = "cmd")]
    enum Cmd {
        #[serde(rename = "input")]
        Input {
            #[serde(rename = "reportId")]
            report_id: Option<u8>,
            data: Option<Vec<u8>>,
        },
        #[serde(rename = "destroy")]
        Destroy,
        #[serde(rename = "ping")]
        Ping,
    }

    let cmd: Cmd = serde_json::from_str(line).context("failed to parse JSON command")?;
    match cmd {
        Cmd::Input { report_id, data } => {
            let payload = match (report_id, data) {
                (Some(rid), Some(mut d)) => {
                    let mut buf = Vec::with_capacity(1 + d.len());
                    buf.push(rid);
                    buf.append(&mut d);
                    buf
                }
                (Some(rid), None) => vec![rid],
                (None, Some(d)) => d,
                (None, None) => Vec::new(),
            };
            if payload.is_empty() {
                anyhow::bail!("input command requires either reportId or data");
            }
            dev.send_input(&payload)?;
            emit_stdout(&serde_json::json!({
                "event": "input_sent",
                "reportId": report_id.unwrap_or(0),
                "size": payload.len(),
            }));
        }
        Cmd::Destroy => {
            return Ok(LoopAction::Exit);
        }
        Cmd::Ping => {
            emit_stdout(&serde_json::json!({"event": "pong"}));
        }
    }
    Ok(LoopAction::Continue)
}

/// Emit one JSON event line on stdout. Safe to call from multiple threads
/// (each call takes the stdout lock for the whole line).
#[cfg(not(target_os = "windows"))]
pub fn emit_stdout(value: &serde_json::Value) {
    use std::io::Write as _;
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{}", value);
    let _ = stdout.flush();
}
