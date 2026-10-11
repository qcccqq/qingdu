// 轻读 — Tauri 原生壳
// 命令：按路径读取文档、写回原文件（自动 .bak）、检查更新、执行更新
//
// 更新安全模型（借鉴 Tauri 官方更新器"更新器是最高价值攻击面"的原则，
// 采用其弱化版：URL 由 Rust 侧硬编码构造（不信任前端），安装包经
// SHA-256 清单校验（清单与安装包同源自 Release 下载）；后续可升级
// 为 minisign 签名校验。

const UPDATE_BASE: &str = "https://github.com/qcccqq/qingdu/releases/latest/download";

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

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

#[derive(serde::Serialize)]
struct UpdateInfo {
    has_update: bool,
    version: String,
}

/// 检查更新：读取仓库最新 Release 的 version.json，与当前版本比较
#[tauri::command]
fn check_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let resp = ureq::get(&format!("{}/version.json", UPDATE_BASE))
        .timeout(std::time::Duration::from_secs(20))
        .call();
    let body = match resp {
        Ok(r) => r.into_string().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(404, _)) => {
            return Err("更新通道尚未就绪（云端还没有已发布的版本），请稍后再试".into())
        }
        Err(ureq::Error::Status(code, _)) => {
            return Err(format!("更新服务器返回错误（{}）", code))
        }
        Err(e) => return Err(format!("无法连接更新服务器: {}", e)),
    };
    // 容错：剥掉可能存在的 UTF-8 BOM（serde_json 不接受 BOM）
    let body = body.trim_start_matches('\u{feff}');
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    let latest = v["version"].as_str().unwrap_or("").to_string();
    if latest.is_empty() {
        return Err("更新信息格式异常".into());
    }
    Ok(UpdateInfo {
        has_update: version_gt(&latest, &current),
        version: latest,
    })
}

/// 执行更新：下载安装包与校验清单，SHA-256 一致才启动安装器
#[tauri::command]
fn perform_update() -> Result<(), String> {
    let dl = |name: &str| -> Result<Vec<u8>, String> {
        let resp = ureq::get(&format!("{}/{}", UPDATE_BASE, name))
            .timeout(std::time::Duration::from_secs(600))
            .call();
        match resp {
            Ok(r) => {
                let mut reader = r.into_reader();
                let mut buf = Vec::new();
                std::io::copy(&mut reader, &mut buf)
                    .map_err(|e| format!("读取 {} 失败: {}", name, e))?;
                Ok(buf)
            }
            Err(ureq::Error::Status(404, _)) => Err("更新通道尚未就绪（云端还没有已发布的版本）".into()),
            Err(ureq::Error::Status(code, _)) => Err(format!("更新服务器返回错误（{}）", code)),
            Err(e) => Err(format!("下载 {} 失败: {}", name, e)),
        }
    };
    let manifest = dl("version.json")?;
    let manifest = String::from_utf8_lossy(&manifest);
    let manifest = manifest.trim_start_matches('\u{feff}');
    let v: serde_json::Value = serde_json::from_str(manifest).map_err(|e| format!("更新信息格式异常: {}", e))?;
    let expect = v["sha256"].as_str().unwrap_or("").to_lowercase();
    if expect.len() != 64 {
        return Err("更新清单缺少校验值，已取消更新".into());
    }
    let exe = dl("qingdu-Setup.exe")?;
    if sha256_hex(&exe) != expect {
        return Err("安装包校验不一致（可能下载不完整），已取消更新".into());
    }
    let path = std::env::temp_dir().join("qingdu-Setup.exe");
    std::fs::write(&path, &exe).map_err(|e| format!("保存失败: {}", e))?;
    std::process::Command::new(&path)
        .spawn()
        .map_err(|e| format!("启动安装器失败: {}", e))?;
    std::process::exit(0);
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
