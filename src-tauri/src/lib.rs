// 轻读 — Tauri 原生壳
// 两条命令：按路径读取文档、写回原文件（自动留 .bak 备份）

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
        .invoke_handler(tauri::generate_handler![read_file_by_path, write_file_with_backup])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
