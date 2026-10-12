# 轻读 · Word 快速阅读器

小体量、秒级打开的 Word（.docx）阅读器，阅读编辑一体。

- 界面：HTML/JS（docx-preview 渲染，Apache-2.0；jszip/fflate，MIT）
- 外壳：Tauri 2（Rust，系统 WebView2，安装包约 10 MB）
- 阅读：分页阅读、缩放、全文搜索、页码导航、最近文件、`.docx` 双击直开
- 编辑：打开即编（单击段落落光标，WPS 式体验）——改文本、选区/段落加粗倾斜、
  字号颜色、Enter 分段、段首退格合并、撤销重做；保存原位写回（自动 `.bak`），
  未动内容字节级保真（经 Word 解析器双重验证）
- 文件关联：双击/右键/QQ 转发打开直达文档；重复启动合并到已开窗口并聚焦
- 隐私：全部本地处理，无网络请求（仅应用内更新检查），无遥测

## 构建

本仓库配置了 GitHub Actions（`.github/workflows/build.yml`）：
推送到 `main` 分支即自动在云端编译，完成后在 Actions 页面的
Artifacts 中下载 `qingdu-setup-x64`（NSIS 安装包）。

本地构建（可选）：

```
cargo install tauri-cli --version "^2" --locked
cargo tauri build
```

## 目录结构

```
ui/                  界面（index.html + app.js + 内嵌开源库）
src-tauri/           Tauri 壳（Rust 命令：按路径读文件、写回留备份）
.github/workflows/   云构建工作流
```

## 许可

本应用代码 MIT。内嵌库许可见 `ui/index.html` 头部声明。
