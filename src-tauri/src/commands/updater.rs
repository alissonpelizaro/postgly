//! Self-update command. Spawns the platform-specific install script in
//! a detached terminal window and exits the app so the installer can
//! replace the binary without file-lock conflicts.

use std::process::Command;

use crate::error::{AppError, AppResult};

#[cfg(any(target_os = "macos", target_os = "linux"))]
const INSTALL_SH_URL: &str =
    "https://raw.githubusercontent.com/alissonpelizaro/postgly/main/scripts/install.sh";
#[cfg(target_os = "windows")]
const INSTALL_PS1_URL: &str =
    "https://raw.githubusercontent.com/alissonpelizaro/postgly/main/scripts/install.ps1";

/// Spawn the updater script in a new terminal window, then quit. The
/// installer always lives in a separate process (Terminal.app /
/// gnome-terminal / cmd.exe) so it survives our exit without extra
/// detach plumbing.
#[tauri::command]
pub fn run_update_and_exit<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> AppResult<()> {
    spawn_installer()?;
    app.exit(0);
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_installer() -> AppResult<()> {
    let script = format!(
        "tell application \"Terminal\"\n\
            activate\n\
            do script \"curl -fsSL {INSTALL_SH_URL} | bash\"\n\
         end tell"
    );
    Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .spawn()
        .map_err(|e| AppError::Other(format!("failed to launch updater: {e}")))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn spawn_installer() -> AppResult<()> {
    // Try common terminal emulators in order; fall back to detached
    // bash (no window, output to ~/.postgly-update.log).
    let bash_cmd = format!(
        "curl -fsSL {INSTALL_SH_URL} | bash; echo; echo 'Pressione Enter para fechar.'; read"
    );
    let candidates: &[(&str, &[&str])] = &[
        ("gnome-terminal", &["--", "bash", "-c"]),
        ("konsole", &["-e", "bash", "-c"]),
        ("xfce4-terminal", &["-e", "bash", "-c"]),
        ("kitty", &["bash", "-c"]),
        ("alacritty", &["-e", "bash", "-c"]),
        ("xterm", &["-e", "bash", "-c"]),
    ];
    for (bin, args) in candidates {
        let mut cmd = Command::new(bin);
        for a in *args {
            cmd.arg(a);
        }
        cmd.arg(&bash_cmd);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }
    // Last resort: detached bash, log redirected to the home dir.
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let log = format!("{home}/.postgly-update.log");
    let bg_cmd =
        format!("nohup bash -c 'curl -fsSL {INSTALL_SH_URL} | bash' > {log} 2>&1 &");
    Command::new("bash")
        .arg("-c")
        .arg(&bg_cmd)
        .spawn()
        .map_err(|e| AppError::Other(format!("failed to launch updater: {e}")))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn spawn_installer() -> AppResult<()> {
    // `start ""` opens a new console window; `-NoExit` keeps it visible
    // so the user sees the installer output after it finishes.
    Command::new("cmd")
        .args([
            "/C",
            "start",
            "",
            "powershell",
            "-NoExit",
            "-Command",
            &format!("irm {INSTALL_PS1_URL} | iex"),
        ])
        .spawn()
        .map_err(|e| AppError::Other(format!("failed to launch updater: {e}")))?;
    Ok(())
}
