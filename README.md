# 豆包视频服务（精简版）

本服务复用灵帧 AI 现有的豆包网页自动化能力，提供 HTTP 接口。服务不保存最终视频文件，只返回豆包的有水印地址和无水印地址。

## 启动

桌面程序采用“内置浏览器 + API 服务”结构：登录窗口由 Electron 内置 BrowserWindow 打开，每个账号使用独立且持久化的 Electron partition；API 任务会复用对应会话完成豆包视频生成。视频地址读取成功后，当前账号窗口自动关闭，登录数据仍保留。命令行 `npm run service` 未运行 Electron 时继续使用外部 Chrome 作为后备模式。

要求 Node.js 22.5+。豆包自动化核心已复制到 `src/vendor`，服务运行时不依赖灵帧应用是否启动；后续源码更新时需要重新同步该目录。

`D:\04 AI项目合集\03 灵帧AI桌面客户端源码-V0.12.2\lingzhen_ai_desktop_v1`

也可以设置 `LINGZHEN_SOURCE_ROOT` 指向源码目录。

## 在线设备授权

启用授权验证时，未激活的桌面程序启动后显示激活窗口，自动读取本机设备码，输入密钥并点击“激活 / 更换密钥”。已激活后可从左侧“授权管理”查看有效期、复制设备码、更换密钥或重新验证。当前密钥默认掩码，点击“查看”才解密读取；关闭弹窗或授权失效立即清除明文。更换密钥使用独立输入框，输入过程中授权状态仍持续更新。

开关优先级：进程环境变量 `DOUBAO_LICENSE_VERIFICATION=1/0` > 程序包内 `config/license-policy.json` 的布尔字段 `verificationEnabled` > 文件缺失或损坏时默认开启。自 0.3.3 起默认策略为 `true`（启用验证），使用资格及期限由在线密钥中心控制；开关不是运行数据目录配置，也不是密钥授权本身。HTTP/MCP 继续只判断本机是否已授权，不增加调用者 Token。

服务只向 `https://nexusapi.center/api/v1/device-activation/verify` 发送 `{"secret":"设备密钥","device_code":"本机设备码"}`。设备码为带应用前缀的 Windows MachineGuid SHA-256 摘要，同一 Windows 安装下重启或移动程序不改变设备码；系统重装或克隆可能影响标识，需要在密钥中心处理设备绑定。

本地 `GET /api/v1/license/status` 返回授权状态和设备码；`POST /api/v1/license/activate` 接收 JSON `{"secret":"设备密钥"}`。`GET /api/v1/license/status?refresh=1` 强制联网复核。其他 API（含 MCP 转发、账号登录、任务提交/恢复/查询）没有有效授权时返回 403。队列执行和提交前再次验证，避免已排队任务绕过到期限制。

密钥使用 Windows DPAPI CurrentUser 加密保存在数据目录的 `online-license.json`；不写入前端存储、不随健康状态返回、不将远端原始响应写入日志。旧离线 `license.json` 不再授予使用权，历史签发脚本不能用于此在线版本。启用验证时，程序重启必须重新联网验证，不信任磁盘上的有效期。无离线宽限期；同进程校验最多缓存 30 秒，超过后网络异常则暂停使用。桌面每 5 秒检查一次状态；失效时关闭普通页面和独立任务查看窗，隐藏后台窗口、冻结人工接管并保留原会话及接管锁，已提交任务可继续收集结果，新提交仍受授权拦截。恢复授权不会自动显示窗口或恢复人工接管，需要用户重新进入。已发送到豆包的远端任务无法据此撤销，不应自动重复提交。

**授权响应规则**：限时和长期授权都必须明确返回布尔批准与 active 状态；缺少批准字段、字符串或数字替代布尔值均拒绝。已实测密钥中心返回 `success:true`、`data.valid:true`、`data.status:"active"`。有 `data.expires_at`（兼容 `expiresAt`，ISO 8601 含时区）时按到期时间限制；未提供到期时间或值为 `null` 时，只有明确返回有效且 active 才按长期有效授权，本地状态返回 `permanent:true`、`expiresAt:null`，界面显示“长期有效”。空字符串或无效日期仍拒绝授权。可选设备绑定字段 `data.device_code`（或 `deviceCode`）必须与本机一致。长期密钥仍执行上述联网复验、撤销和断网拦截规则；HTTP 200 本身不代表授权成功。

运行 `npm run test:license` 检查加密、设备码、过期、并发、撤销、错误响应以及 HTTP/MCP/队列拦截；测试中的成功授权和视频 worker 是隔离模拟，不代表真实密钥已激活或真实视频已生成。`node scripts/preview-license-ui.cjs` 仅供本机界面测试（`ui-test` 是模拟输入，不是实际密钥），不会连接远端服务。

## MCP 配置

项目提供 MCP stdio 适配器，复用本机 `127.0.0.1:8787` 服务，不绕过账号锁定、图片上传和真实视频结果校验。先启动桌面程序，再将以下命令配置到 MCP 客户端：

```json
{
  "mcpServers": {
    "doubao-video-manager": {
      "command": "node",
      "args": ["D:/04 AI项目合集/豆包工具/src/mcp-server.cjs"]
    }
  }
}
```

也可以在项目目录运行 `npm run mcp`。可用工具包括 `doubao_health`、`doubao_list_accounts`、`doubao_generate_video`、`doubao_get_job`、`doubao_wait_job`、`doubao_resume_job`、`doubao_recover_existing_result` 和 `doubao_refresh_url`。`doubao_generate_video` 的 `files` 传本地图片绝对路径，`accountId` 可固定为 `account-001`；设置 `wait=true` 可等待终态。MCP 查询已完成任务时会先探测视频地址，发现豆包 CDN 签名过期（401/403/404/410）会自动刷新地址，不会重新生成视频。`doubao_recover_existing_result` 只在有原会话提交证据时工作，锁定原账号和原会话，仅补取已有结果。

安装后可运行 `npm run setup:mcp` 自动生成 `mcp-config.json`。如需自动合并到 Claude Desktop 配置，可设置环境变量 `DOUBAO_INSTALL_CLAUDE=1` 后运行该命令；脚本只合并 `mcpServers.doubao-video-manager`，不会覆盖其他服务器配置。

桌面程序启动时也会自动写入 `%LOCALAPPDATA%\\DoubaoVideoManager\\mcp-config.json`，配置使用程序自带的 Electron Node 运行时，不要求用户另装 Node.js。将该文件内容导入 MCP 客户端即可。

```powershell
npm start
```

生成单文件 Windows EXE：

```powershell
npm run dist:win
```

构建产物输出到 `dist/`；不要直接使用项目目录中遗留的旧版构建目录。

## 线上短剧平台内置连接

桌面程序可以直接复用短剧平台的“豆包视频管理器”本地连接协议，不需要另行运行 `doubao-local-connector.cmd`。程序启动后会读取：

```text
%LOCALAPPDATA%\DoubaoVideoManager\config\remote-connector.json
```

文件内容：

```json
{
  "enabled": true,
  "server": "https://comic-drama.nexusapi.center",
  "token": "网站生成的本地连接令牌",
  "localOrigin": "http://127.0.0.1:8787"
}
```

推荐直接在管理器顶部点击 **连接服务**，输入网站地址和连接凭证后点击 **保存并连接**。管理器会把配置保存到本机运行目录，之后启动时自动重连，不需要再次输入；凭证失效时可在同一窗口替换。公网地址必须使用 HTTPS；开发或局域网地址可以使用 `localhost`、`127.0.0.1` 或 RFC1918 内网 IPv4 的 HTTP。连接令牌由网站的本地连接授权生成，只保存在本机配置中，不要提交到代码仓库。也可以使用环境变量 `DOUBAO_REMOTE_SERVER`、`DOUBAO_REMOTE_TOKEN` 和 `DOUBAO_REMOTE_LOCAL_ORIGIN` 覆盖配置文件。管理器会主动轮询网站的 `/api/local-doubao`，只转发健康检查、视频提交和任务查询，网站关闭本地访问后会立即停止新的本地请求。

## 首次登录

先在 `config/accounts.json` 配置账号 ID，然后执行：

```powershell
npm run login -- account-001
```

如果从 Codex 或后台进程启动后看不到窗口，请直接双击项目根目录的 `login-account.cmd`，或在你自己的 PowerShell 窗口执行上面的命令。这样 Chrome 会运行在当前可见桌面会话中。

会打开软件内置的可视化豆包窗口。完成登录后，登录状态会保存在 Electron 的账号专属持久化 partition（运行目录下的 `electron-user-data`），不会因为关闭窗口丢失。也可以调用：

```http
POST /api/v1/accounts/account-001/login
```

## 生成接口

```http
POST /api/v1/video/generate
Content-Type: multipart/form-data
```

字段：`prompt`、`model`、`ratio`、`duration`、`files`。`ratio` 支持 `自动`、`3:4`、`4:3`、`9:16`、`16:9`、`1:1`、`21:9`。当前豆包页面没有可操作的分辨率控件，因此接口和桌面端只提交画面比例与时长；如果传入具体 `resolution` 值，服务端会明确返回不支持。桌面端“快速生成”面板和 MCP 都使用同一套字段。图片支持 jpg/jpeg/png/webp，最多 10 张。`files` 可以是 multipart 二进制文件，也可以是 HTTPS 网络图片 URL 数组；网络图片会先由服务端下载、校验后再作为真实附件上传到豆包。

Postman 使用 `form-data` 时，网络图片请将 `files` 设置为 **Text** 并填写纯 HTTPS URL；多个网络图片可以重复添加多行 `files`，也可以在一个字段中填写 JSON URL 数组。本地图片将 `files` 设置为 **File** 并选择图片，可重复添加多行。不要手动填写 `Content-Type`，让 Postman 自动生成 boundary。服务也会兼容从聊天窗口复制出来的 `[图片](https://...)` Markdown 链接。

JSON 网络图片示例：

```json
{
  "prompt": "让图1中的人物在海边慢慢转身，镜头向前推进",
  "model": "Seedance 2.0 Mini",
  "ratio": "9:16",
  "duration": 10,
  "timeoutMs": 120000,
  "files": ["https://example.com/reference.png"]
}
```

默认持久化任务后返回 `202` 和 `requestId`，网络参考图随后在后台下载、校验（`preparing_assets`）；下载失败通过任务查询返回 `failed` 和错误原因。二进制图片上传和授权校验仍需先完成。通过 `GET /api/v1/video/jobs/{requestId}` 查询；需要保持 HTTP 请求等待结果时使用 `?wait=1`。任务状态保存在 `data/jobs.json`，兼容桌面 EXE 内置的 Electron Node 运行时。

手动查看账号时只保留当前一个豆包页面，切换会释放旧页面并记住其会话地址；登录 Cookie 和浏览器缓存会保留。后台生成页面独立管理，不受手动切换影响。默认启用硬件加速；遇到显卡兼容问题可设置 `DOUBAO_SOFTWARE_RENDERING=1` 使用软件渲染。仅在需要修复缓存时设置 `DOUBAO_CLEAR_BROWSER_CACHE_ON_START=1`，正常启动不清空缓存。

任务需要人工登录或验证后，可调用 `POST /api/v1/video/jobs/{requestId}/resume` 继续；提交状态未知但已保存豆包会话证据的任务，也可以用该接口恢复原会话监听，不会重新提交或重新上传图片。地址过期时可调用 `POST /api/v1/video/jobs/{requestId}/refresh-url`，只刷新地址，不会重新生成视频。

完成结果示例：

```json
{
  "requestId": "req_xxx",
  "state": "completed",
  "videoVid": "xxx",
  "conversationId": "xxx",
  "watermarkFreeUrl": "https://...",
  "watermarkedUrl": "https://...",
  "watermarkFreeAvailable": true
}
```

默认在视频地址读取完成并写入任务结果后关闭本次使用的豆包浏览器；登录 Profile 不会删除，下次任务会重新打开并复用登录状态。如需保持浏览器打开，可设置 `DOUBAO_CLOSE_BROWSER_AFTER_RESULT=0`。

B 阶段工作台首页保留运行概览、额度状态、最近任务。接口说明包含接入说明和调用记录，生成继续由创作平台、HTTP API 或 MCP 提交。点击任务标题只读查看原账号原会话，详情支持核对、普通确认、仅补取、人工接管。自动操作期间只允许查看；账号空闲后才能接管，接管期间该账号暂停自动操作，结束后先核对页面。缺少原会话时只显示详情，不猜测或换号。补取不发送生成或确认消息，确认操作先持久化一次性记录。

账号在提交前遇到额度、登录或浏览器问题会自动切换其他账号；提交状态未知时会进入 `submission_unknown`，不会重复提交。

本地额度估算仅用于统计，即使估算剩余为零也不拦截生成。只有豆包页面明确报告额度耗尽，才暂停该账号的免费任务调度。账号卡片将未确认的实际剩余额度显示为“待确认”。账号接口中的 `quotaRemaining`、`miniRuns`、`fastRuns` 仍是本地估算值；`actualQuotaRemaining` 为 `null` 表示实际余额未知，`quotaStatus` 为 `provider_exhausted` 表示豆包已报告耗尽。付费额度确认仍需要显式授权。

不消耗额度的并发测试：在项目目录运行 `npm run test:concurrency -- --tasks 10 --accounts 4 --delay 2000`，表示同时提交 10 个请求、使用 4 个模拟账号、每个任务模拟等待 2 秒。省略参数时使用 `references/concurrency.json` 的默认值（50 请求、2 账号）。测试使用真实本地 HTTP 接口和任务调度，豆包执行部分返回模拟结果；使用随机本地端口与独立临时数据，不访问豆包、不打开浏览器、不修改正式账号或任务。终端实时显示进度，报告保存到 `scripts/log/concurrency-results.json`，包含响应时间、完成数、实际最大并行数及账号并发冲突数。还可运行 `npm run test:concurrency:quota` 验证并发下的额度不足处理。模拟测试不代表真实网页的资源占用、组件操作或豆包生成速度。

## 干净构建与授权策略验收

使用 `npm run dist:win -- --out <输出目录>`。如构建工具不在本项目，使用 `--builder <electron-builder/cli.js绝对路径>` 或 `DOUBAO_BUILDER_CLI` 指定已安装工具。构建入口只复制运行源码、界面、图标和明确授权策略，生成空账号配置；不复制运行数据。构建前及最终 ASAR 均校验策略，缺失、类型错误、模式变化会使构建失败。最终运行文件逐一与本次源文件快照核对，验收结果写入 `package-verification.json`。
