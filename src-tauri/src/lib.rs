#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(BackendState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            ensure_backend,
            minimize_window,
            open_about_url,
            pick_acp_package_directory,
            pick_workspace_directory,
            shutdown_app,
            toggle_maximize_window
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(state) = window.try_state::<BackendState>() {
                    state.stop_backend();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running Code Lite");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            if let Some(state) = app_handle.try_state::<BackendState>() {
                state.stop_backend();
            }
        }
    });
}

use serde::Serialize;
use std::{
    fs::{File, OpenOptions},
    io::{BufWriter, Write},
    net::{TcpListener, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const BACKEND_HOST: &str = "127.0.0.1";
const BACKEND_PORT_RANGE_START: u16 = 50000;
const BACKEND_PORT_RANGE_END: u16 = 60000;
const BACKEND_SIDECAR: &str = "code-lite-backend";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const CREATE_NO_WINDOW: u32 = 0x08000000;
const REPOSITORY_URL: &str = "https://github.com/Savlgoodman/code-lite";
const AUTHOR_URL: &str = "https://github.com/Savlgoodman";

#[derive(Default)]
struct BackendState {
    child: Mutex<Option<BackendChild>>,
    port: Mutex<Option<u16>>,
}

enum BackendChild {
    Dev(Child),
    Sidecar(tauri_plugin_shell::process::CommandChild),
}

impl BackendChild {
    fn pid(&self) -> u32 {
        match self {
            Self::Dev(child) => child.id(),
            Self::Sidecar(child) => child.pid(),
        }
    }

    fn stop(self) {
        let pid = self.pid();

        #[cfg(windows)]
        if terminate_process_tree(pid) {
            return;
        }

        match self {
            Self::Dev(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            Self::Sidecar(child) => {
                let _ = child.kill();
            }
        }
    }
}

#[cfg(windows)]
fn terminate_process_tree(pid: u32) -> bool {
    let mut command = Command::new("taskkill");
    command
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);

    command.status().is_ok_and(|status| status.success())
}

impl BackendState {
    fn stop_backend(&self) {
        let child = self.child.lock().ok().and_then(|mut guard| guard.take());
        if let Some(child) = child {
            child.stop();
        }
    }
}

#[derive(Serialize)]
struct BackendStatus {
    base_url: String,
    reused: bool,
}

#[tauri::command]
fn ensure_backend(
    app: tauri::AppHandle,
    state: tauri::State<'_, BackendState>,
) -> Result<BackendStatus, String> {
    // 复用已解析的端口（同一会话内保持稳定）；首次调用才解析。
    let existing_port = state
        .port
        .lock()
        .map_err(|_| "backend state lock poisoned".to_string())?
        .clone();

    if let Some(port) = existing_port {
        if is_backend_listening(port) {
            return Ok(BackendStatus {
                base_url: format!("http://{}:{}", BACKEND_HOST, port),
                reused: true,
            });
        }
    }

    // 环境变量指定了端口时，说明后端由外部脚本负责启动（dev 双终端场景）。
    // 桌面壳不再自行拉起后端，只等待该端口就绪并复用，避免端口冲突。
    let env_port = std::env::var("CODE_LITE_BACKEND_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port != 0);
    if let Some(port) = env_port {
        let base_url = format!("http://{}:{}", BACKEND_HOST, port);
        // 最长等待 30s 让脚本侧后端完成启动。
        for _ in 0..120 {
            if is_backend_listening(port) {
                let mut guard = state
                    .port
                    .lock()
                    .map_err(|_| "backend state lock poisoned".to_string())?;
                *guard = Some(port);
                return Ok(BackendStatus {
                    base_url,
                    reused: true,
                });
            }
            thread::sleep(Duration::from_millis(250));
        }
        return Err(format!(
            "backend did not start on env port {port} within 30 seconds"
        ));
    }

    let port = resolve_backend_port();
    let base_url = format!("http://{}:{}", BACKEND_HOST, port);

    if std::env::var("CODE_LITE_SKIP_BACKEND_AUTOSTART").is_ok() {
        return Err(format!(
            "backend is not listening at {base_url}; autostart is disabled"
        ));
    }

    let child = start_backend(&app, port)?;
    let _pid = child.pid();

    {
        let mut guard = state
            .child
            .lock()
            .map_err(|_| "backend state lock poisoned".to_string())?;
        *guard = Some(child);
    }
    {
        let mut guard = state
            .port
            .lock()
            .map_err(|_| "backend state lock poisoned".to_string())?;
        *guard = Some(port);
    }

    for _ in 0..60 {
        if is_backend_listening(port) {
            return Ok(BackendStatus {
                base_url,
                reused: false,
            });
        }
        thread::sleep(Duration::from_millis(250));
    }

    Err("backend did not start within 15 seconds".to_string())
}

#[tauri::command]
fn minimize_window(window: tauri::Window) -> Result<(), String> {
    window
        .minimize()
        .map_err(|error| format!("failed to minimize window: {error}"))
}

#[tauri::command]
fn toggle_maximize_window(window: tauri::Window) -> Result<(), String> {
    let is_maximized = window
        .is_maximized()
        .map_err(|error| format!("failed to read window state: {error}"))?;

    if is_maximized {
        window
            .unmaximize()
            .map_err(|error| format!("failed to unmaximize window: {error}"))
    } else {
        window
            .maximize()
            .map_err(|error| format!("failed to maximize window: {error}"))
    }
}

#[tauri::command]
fn open_about_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    match url.as_str() {
        REPOSITORY_URL | AUTHOR_URL => {
            #[allow(deprecated)]
            app.shell()
                .open(url, None)
                .map_err(|error| format!("failed to open url: {error}"))
        }
        _ => Err("url is not allowed".to_string()),
    }
}

#[tauri::command]
async fn pick_workspace_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let folder = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| path.to_string());

    Ok(folder)
}

#[tauri::command]
async fn pick_acp_package_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let folder = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| path.to_string());

    Ok(folder)
}

#[tauri::command]
fn shutdown_app(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<BackendState>() {
        state.stop_backend();
    }
    app.exit(0);
    Ok(())
}

fn start_backend(app: &tauri::AppHandle, port: u16) -> Result<BackendChild, String> {
    if should_try_sidecar() {
        return start_sidecar_backend(app, port).or_else(|sidecar_error| {
            start_dev_backend(port).map_err(|dev_error| {
                format!(
                    "failed to start bundled backend: {sidecar_error}; failed to start backend with uv: {dev_error}"
                )
            })
        });
    }

    start_dev_backend(port)
}

fn should_try_sidecar() -> bool {
    !cfg!(debug_assertions) || std::env::var("CODE_LITE_USE_BACKEND_SIDECAR").is_ok()
}

fn start_sidecar_backend(app: &tauri::AppHandle, port: u16) -> Result<BackendChild, String> {
    let workspace = production_workspace()?;
    let data_dir = production_data_dir()?;
    let log_path = create_backend_log_path(&data_dir)?;
    let (mut rx, child) = app
        .shell()
        .sidecar(BACKEND_SIDECAR)
        .map_err(|error| format!("failed to prepare backend sidecar: {error}"))?
        .arg("--host")
        .arg(BACKEND_HOST)
        .arg("--port")
        .arg(port.to_string())
        .arg("--workspace")
        .arg(workspace.as_os_str())
        .arg("--data-dir")
        .arg(data_dir.as_os_str())
        .arg("--log-file")
        .arg(log_path.as_os_str())
        .arg("--role")
        .arg("prod")
        .env("PYTHONUTF8", "1")
        .env("CODE_LITE_APP_VERSION", APP_VERSION)
        .env("CODE_LITE_BACKEND_VERSION", APP_VERSION)
        .spawn()
        .map_err(|error| format!("failed to spawn backend sidecar: {error}"))?;

    tauri::async_runtime::spawn(async move {
        let mut log_writer = open_append_log(&log_path).ok().map(BufWriter::new);
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    write_backend_event(&mut log_writer, "stdout", &line);
                }
                CommandEvent::Stderr(line) => {
                    write_backend_event(&mut log_writer, "stderr", &line);
                }
                CommandEvent::Error(error) => {
                    write_backend_text(&mut log_writer, "error", &error);
                }
                CommandEvent::Terminated(payload) => {
                    write_backend_text(
                        &mut log_writer,
                        "terminated",
                        &format!("code={:?}, signal={:?}", payload.code, payload.signal),
                    );
                }
                _ => {}
            }
        }
    });

    Ok(BackendChild::Sidecar(child))
}

fn start_dev_backend(port: u16) -> Result<BackendChild, String> {
    let repo_root = repo_root()?;
    let backend_dir = repo_root.join("backend");
    let data_dir = repo_root.join("data");
    let log_path = create_backend_log_path(&data_dir)?;
    if !backend_dir.is_dir() {
        return Err(format!(
            "backend directory not found: {}",
            backend_dir.display()
        ));
    }

    let mut command = Command::new("uv");
    command
        .arg("run")
        .arg("python")
        .arg("-m")
        .arg("code_lite_backend.main")
        .arg("--host")
        .arg(BACKEND_HOST)
        .arg("--port")
        .arg(port.to_string())
        .arg("--workspace")
        .arg(&repo_root)
        .arg("--data-dir")
        .arg(&data_dir)
        .arg("--log-file")
        .arg(&log_path)
        .arg("--role")
        .arg("dev")
        .current_dir(&backend_dir)
        .env("PYTHONUTF8", "1")
        .env("CODE_LITE_APP_VERSION", APP_VERSION)
        .env("CODE_LITE_BACKEND_VERSION", APP_VERSION)
        .stdin(Stdio::null())
        .stdout(
            open_append_log(&log_path)
                .map(Stdio::from)
                .unwrap_or_else(|_| Stdio::null()),
        )
        .stderr(
            open_append_log(&log_path)
                .map(Stdio::from)
                .unwrap_or_else(|_| Stdio::null()),
        );

    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .map_err(|error| format!("failed to start backend with uv: {error}"))?;

    Ok(BackendChild::Dev(child))
}

fn is_backend_listening(port: u16) -> bool {
    let address = format!("{}:{}", BACKEND_HOST, port);
    let Ok(mut addresses) = address.to_socket_addrs() else {
        return false;
    };
    let Some(address) = addresses.next() else {
        return false;
    };
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

/// 判断端口当前是否空闲（可被本机绑定）。
fn is_port_free(port: u16) -> bool {
    TcpListener::bind((BACKEND_HOST, port)).is_ok()
}

/// 选择后端端口：优先复用环境变量 CODE_LITE_BACKEND_PORT（由 dev 脚本注入，
/// 保证脚本单独启动的后端与桌面壳一致）；否则在 50000-60000 内随机探测一个空闲端口。
fn resolve_backend_port() -> u16 {
    if let Ok(value) = std::env::var("CODE_LITE_BACKEND_PORT") {
        if let Ok(port) = value.trim().parse::<u16>() {
            if port != 0 {
                return port;
            }
        }
    }
    pick_free_port()
}

/// 在 50000-60000 范围内随机起点线性探测一个空闲端口；全部占用时回退到 OS 分配。
fn pick_free_port() -> u16 {
    let span = BACKEND_PORT_RANGE_END - BACKEND_PORT_RANGE_START;
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let offset = (seed % span as u32) as u16;
    for i in 0..span {
        let port = BACKEND_PORT_RANGE_START + ((offset + i) % span);
        if is_port_free(port) {
            return port;
        }
    }
    // 兜底：让操作系统分配一个临时端口。
    TcpListener::bind((BACKEND_HOST, 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
        .unwrap_or(BACKEND_PORT_RANGE_START)
}

fn repo_root() -> Result<PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|error| format!("failed to read cwd: {error}"))?;
    if cwd.file_name().and_then(|name| name.to_str()) == Some("src-tauri") {
        return cwd
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| format!("failed to derive repo root from {}", cwd.display()));
    }
    Ok(cwd)
}

fn production_data_dir() -> Result<PathBuf, String> {
    let home = user_home_dir()?;
    Ok(home.join(".code-lite"))
}

fn production_workspace() -> Result<PathBuf, String> {
    let home = user_home_dir()?;
    let workspace = home.join(".code-lite").join("workspace");
    std::fs::create_dir_all(&workspace)
        .map_err(|error| format!("failed to create backend workspace: {error}"))?;
    Ok(workspace)
}

fn user_home_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "failed to resolve user home directory".to_string())
}

fn create_backend_log_path(data_dir: &Path) -> Result<PathBuf, String> {
    let logs_dir = data_dir.join("logs");
    std::fs::create_dir_all(&logs_dir)
        .map_err(|error| format!("failed to create backend logs directory: {error}"))?;
    Ok(logs_dir.join(format!("backend-{}.log", timestamp_millis())))
}

fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn open_append_log(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

fn write_backend_event(writer: &mut Option<BufWriter<File>>, stream: &str, bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    write_backend_text(writer, stream, text.trim_end());
}

fn write_backend_text(writer: &mut Option<BufWriter<File>>, stream: &str, text: &str) {
    let Some(writer) = writer.as_mut() else {
        return;
    };
    let _ = writeln!(writer, "[{stream}] {text}");
    let _ = writer.flush();
}
