//! Installs and removes the background agent: the app's own binary run as
//! `aperture --agent --data <dir>` every 30 minutes by the operating
//! system's per-user scheduler (no administrator rights, no resident process).
//! macOS: a LaunchAgent; Windows: a Task Scheduler task; Linux: a systemd user timer.
use std::path::{Path, PathBuf};
use std::process::Command;

pub const LABEL: &str = "com.aperture.agent";

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

pub fn launchd_plist(exe: &Path, data_dir: &Path) -> String {
    let log = data_dir.join("agent.log");
    let arg = |s: &str| format!("    <string>{}</string>\n", xml_escape(s));
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key><string>{LABEL}</string>\n  <key>ProgramArguments</key>\n  <array>\n{}{}{}{}  </array>\n  <key>StartInterval</key><integer>1800</integer>\n  <key>RunAtLoad</key><false/>\n  <key>ProcessType</key><string>Background</string>\n  <key>LowPriorityIO</key><true/>\n  <key>StandardOutPath</key><string>{}</string>\n  <key>StandardErrorPath</key><string>{}</string>\n</dict>\n</plist>\n",
        arg(&exe.display().to_string()),
        arg("--agent"),
        arg("--data"),
        arg(&data_dir.display().to_string()),
        xml_escape(&log.display().to_string()),
        xml_escape(&log.display().to_string()),
    )
}

#[allow(dead_code)] // Linux only
pub fn systemd_units(exe: &Path, data_dir: &Path) -> (String, String) {
    let q = |p: &Path| format!("\"{}\"", p.display().to_string().replace('"', "\\\""));
    (
        format!("[Unit]\nDescription=Aperture option-data recorder\n\n[Service]\nType=oneshot\nNice=10\nExecStart={} --agent --data {}\n", q(exe), q(data_dir)),
        "[Unit]\nDescription=Run the Aperture option-data recorder every 30 minutes\n\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=30min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n".to_string(),
    )
}

fn plist_path() -> Option<PathBuf> {
    home().map(|h| h.join("Library/LaunchAgents").join(format!("{LABEL}.plist")))
}
fn systemd_dir() -> Option<PathBuf> {
    home().map(|h| h.join(".config/systemd/user"))
}

fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let mut c = Command::new(cmd);
    c.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let out = c.output().map_err(|e| format!("Could not run {cmd}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect())
    }
}

#[cfg(target_os = "macos")]
fn uid() -> String {
    run("id", &["-u"]).map(|s| s.trim().to_string()).unwrap_or_else(|_| "501".into())
}

pub fn installed() -> bool {
    if cfg!(target_os = "macos") {
        plist_path().is_some_and(|p| p.exists())
    } else if cfg!(windows) {
        run("schtasks", &["/Query", "/TN", "Aperture\\Agent"]).is_ok()
    } else {
        systemd_dir().is_some_and(|d| d.join("aperture-agent.timer").exists())
    }
}

pub fn install(exe: &Path, data_dir: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let path = plist_path().ok_or("No home folder")?;
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let target = format!("gui/{}", uid());
        let _ = run("launchctl", &["bootout", &format!("{target}/{LABEL}")]);
        std::fs::write(&path, launchd_plist(exe, data_dir)).map_err(|e| e.to_string())?;
        run("launchctl", &["bootstrap", &target, &path.display().to_string()])?;
        return Ok(());
    }
    #[cfg(windows)]
    {
        let tr = format!("\"{}\" --agent --data \"{}\"", exe.display(), data_dir.display());
        run("schtasks", &["/Create", "/F", "/SC", "MINUTE", "/MO", "30", "/TN", "Aperture\\Agent", "/TR", &tr])?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = systemd_dir().ok_or("No home folder")?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let (service, timer) = systemd_units(exe, data_dir);
        std::fs::write(dir.join("aperture-agent.service"), service).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("aperture-agent.timer"), timer).map_err(|e| e.to_string())?;
        run("systemctl", &["--user", "daemon-reload"])?;
        run("systemctl", &["--user", "enable", "--now", "aperture-agent.timer"])?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Background recording isn't supported on this system.".into())
}

pub fn remove() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = run("launchctl", &["bootout", &format!("gui/{}/{LABEL}", uid())]);
        if let Some(p) = plist_path() {
            let _ = std::fs::remove_file(p);
        }
        return Ok(());
    }
    #[cfg(windows)]
    {
        let _ = run("schtasks", &["/Delete", "/F", "/TN", "Aperture\\Agent"]);
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = run("systemctl", &["--user", "disable", "--now", "aperture-agent.timer"]);
        if let Some(d) = systemd_dir() {
            let _ = std::fs::remove_file(d.join("aperture-agent.timer"));
            let _ = std::fs::remove_file(d.join("aperture-agent.service"));
        }
        let _ = run("systemctl", &["--user", "daemon-reload"]);
        return Ok(());
    }
    #[allow(unreachable_code)]
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launch_agent_plist_runs_the_app_headless_every_30_minutes() {
        let p = launchd_plist(Path::new("/Applications/Aperture.app/Contents/MacOS/aperture"), Path::new("/Users/me/Library/Application Support/com.aperture.desktop"));
        assert!(p.contains("<string>--agent</string>") && p.contains("<integer>1800</integer>"));
        assert!(p.contains("Application Support/com.aperture.desktop/agent.log"));
        let x = launchd_plist(Path::new("/a&b/<c>"), Path::new("/d"));
        assert!(x.contains("/a&amp;b/&lt;c&gt;"));
        let (svc, timer) = systemd_units(Path::new("/opt/aperture/aperture"), Path::new("/home/me/.local/share/com.aperture.desktop"));
        assert!(svc.contains("ExecStart=\"/opt/aperture/aperture\" --agent --data") && timer.contains("OnUnitActiveSec=30min"));
    }
}
