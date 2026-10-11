// 轻读 — Tauri 原生壳
// 命令：按路径读取文档、写回原文件（自动 .bak）、检查更新、执行更新

/// 按路径读取文件（用于双击 .docx 关联打开、最近文件重开）
#[tauri::command]
fn read_file_by_path(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("读取失败: {}", e))
}

/// 把字节写回原路径；写前自动留同名 .bak 备份
#[tauri::command]
fn write_file_with_backup(path: String, data: Vec<u8>) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        let bak = p.with_extension("bak");
        std::fs::copy(p, &bak).map_err(|e| format!("备份失败: {}", e))?;
    }
    std::fs::write(p, data).map_err(|e| format!("写入失败: {}", e))
}

/// 简单三段版本号比较：a 是否大于 b
fn version_gt(a: &str, b: &str) -> bool {
    let pa: Vec<u32> = a.split('.').filter_map(|s| s.parse().ok()).collect();
    let pb: Vec<u32> = b.split('.').filter_map(|s| s.parse().ok()).collect();
    for i in 0..3 {
        let x = pa.get(i).unwrap_or(&0);
        let y = pb.get(i).unwrap_or(&0);
        if x > y { return true; }
        if x < y { return false; }
    }
    false
}

#[derive(serde::Serialize)]
struct UpdateInfo {
    has_update: bool,
    version: String,
    url: String,
}

/// 检查更新：读取仓库最新 Release 的 version.json，与当前版本（Rust 侧自读）比较
#[tauri::command]
fn check_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let body = ureq::get("https://github.com/qcccqq/qingdu/releases/latest/download/version.json")
        .timeout(std::time::Duration::from_secs(30))
        .call()
        .map_err(|e| format!("无法连接更新服务器: {}", e))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let latest = v["version"].as_str().unwrap_or("").to_string();
    if latest.is_empty() {
        return Err("更新信息格式异常".into());
    }
    Ok(UpdateInfo {
        has_update: version_gt(&latest, &current),
        version: latest.clone(),
        url: "https://github.com/qcccqq/qingdu/releases/latest/download/qingdu-Setup.exe".into(),
    })
}

/// 执行更新：下载安装包到临时目录，启动安装器后退出本应用
#[tauri::command]
fn perform_update(url: String, app: tauri::AppHandle) -> Result<(), String> {
    let path = std::env::temp_dir().join("qingdu-Setup.exe");
    let resp = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(600))
        .call()
        .map_err(|e| format!("下载失败: {}", e))?;
    let mut reader = resp.into_reader();
    let mut f = std::fs::File::create(&path).map_err(|e| format!("创建文件失败: {}", e))?;
    std::io::copy(&mut reader, &mut f).map_err(|e| format!("保存失败: {}", e))?;
    drop(f);
    // 校验文件头：必须是 PE 可执行文件（MZ），防止下到错误内容
    let mut head = [0u8; 2];
    use std::io::Read;
    std::fs::File::open(&path)
        .and_then(|mut h| h.read_exact(&mut head))
        .map_err(|e| e.to_string())?;
    if &head != b"MZ" {
        let _ = std::fs::remove_file(&path);
        return Err("下载内容异常，已取消更新".into());
    }
    std::process::Command::new(&path)
        .spawn()
        .map_err(|e| format!("启动安装器失败: {}", e))?;
    app.exit(0);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 双击 .docx 关联启动时，Windows 会把文件路径作为命令行参数传入；
            // 等界面就绪后把路径发给前端。
            let doc_path: Option<String> = std::env::args().skip(1).find(|a| {
                a.to_lowercase().ends_with(".docx") && std::path::Path::new(a).exists()
            });
            if let Some(p) = doc_path {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(900));
                    use tauri::Emitter;
                    let _ = handle.emit("open-file", p);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file_by_path,
            write_file_with_backup,
            check_update,
            perform_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
