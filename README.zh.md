# DSH Codex Bridge

[English guide](README.md)

将 Codex 或其他本机 HTTP 客户端连接到你选定的 DSH 会话。支持分别绑定多个项目、查询每条请求的进度和结果，以及取消桥接排队中的请求。

这是独立插件，采用 [MIT 许可](LICENSE)，不是 DeepSeek 或 OpenAI 官方产品。

## 安装

先确认 DSH 能正常运行。此版已按 **DSH Desktop 0.2.2-rc.1** 及其自带运行时核验；单独运行时需要 Node.js 22 或更新版本。

下载 **[0.8.0 安装包](https://github.com/czocelot/dsh-codex-bridge/releases/download/v0.8.0/dsh-codex-bridge-0.8.0.tgz)** 和 [SHA-256 校验文件](https://github.com/czocelot/dsh-codex-bridge/releases/download/v0.8.0/SHA256SUMS.txt)。[查看版本说明](https://github.com/czocelot/dsh-codex-bridge/releases/tag/v0.8.0)。

1. 保存这两个文件。在 Windows 上，可在文件所在目录运行以下命令，将计算出的哈希与校验文件中的一行进行比较：

   ```powershell
   Get-FileHash .\dsh-codex-bridge-0.8.0.tgz -Algorithm SHA256
   Get-Content .\SHA256SUMS.txt
   ```

2. 打开 DSH 的“插件 → 安装”，粘贴安装包的本地绝对路径；也可以直接粘贴下方安装链接。
3. 确认安装；安装完成后核对包名 `dsh-codex-bridge`、版本 `0.8.0`。
4. 选择“立即启用”，或回到插件页启用该组合包。如果 DSH 提示需要重启，按提示重启。

直接安装链接：

```text
https://github.com/czocelot/dsh-codex-bridge/releases/download/v0.8.0/dsh-codex-bridge-0.8.0.tgz
```

请使用本仓库的 Release 附件；npm 上的同名包属于另一项目。无需手改 YAML、执行 npm 命令或另建 API Key。

## 连接自己的会话

1. 打开“设置 → Bridge 连接权限”。
2. 点击“新增绑定”，选择 DSH 中已有的顶层会话；同名会话要核对项目目录。
3. 默认保留“沿用当前官方权限”，保存绑定。需要更改权限档位时，再明确选择并确认。

首次安装没有预设绑定。列表为空时，先在 DSH 中创建一个项目会话。浏览列表不会提交模型任务；连接时可能由 DSH 加载选中的会话。多个项目可以分别绑定，会话重命名不影响其 ID。

## 从本机客户端使用

默认地址为 `http://127.0.0.1:19491`。可先在 PowerShell 中检查服务与已绑定会话：

```powershell
Invoke-RestMethod http://127.0.0.1:19491/status
Invoke-RestMethod http://127.0.0.1:19491/sessions
```

将 HTTP 客户端配置为向 `POST /v1/prompt` 提交请求，并填写已绑定的 `session_id` 与唯一的 `request_id`。[接口使用说明](docs/API.md) 提供完整请求示例、进度和结果查询、排队取消方法。桥接不会自动向 Codex 注册工具。

提交后若网络超时，先查询原请求 ID，再决定是否重试。取消只针对本桥接的一条排队请求，不代表停止整个 DSH 会话。

## 常见问题与数据

- **监听未启动或端口占用：** 在 Bridge 面板选择空闲端口并保存，同时修改客户端地址。
- **会话未绑定：** 在面板中为该会话保存连接。
- **项目目录发生变化：** 核对目录后解除旧绑定，再重新连接。
- **宿主接口未就绪：** 核对 DSH 版本，等待宿主加载完成后刷新面板。已验证的范围见[兼容性与验证说明](docs/VALIDATION.md)。

绑定、请求记录与权限审计保存在 DSH Home 的 `plugin-data/dsh-codex-bridge/` 中。请保留自己的私有备份，勿将这些记录分享给别人。升级或卸载使用 DSH 插件管理器；卸载插件包不会自动删除这些记录。

桥接仅供本机访问，没有独立的认证 token。本机进程可以访问你绑定的会话。请保留回环监听，并在使用前阅读[安全说明](SECURITY.md)。

更多：[进阶设置](docs/ADVANCED.md) · [开发指南](docs/DEVELOPMENT.md) · [变更记录](CHANGELOG.md) · [第三方许可](THIRD_PARTY_NOTICES.md)。
