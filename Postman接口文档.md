---
created: 2026-09-05
updated: 2026-09-29
tags: [豆包, API, Postman]
---

# 豆包视频服务 Postman 接口文档

## 摘要

服务通过本机 HTTP 接口调用豆包生成视频。服务不保存最终视频文件，任务完成后返回豆包的有水印地址和无水印地址。多个豆包账号由服务随机调度；账号额度、登录或浏览器异常时会自动跳过当前账号并尝试其他账号。

## 使用前提

- 启动“豆包视频管理器”后，默认服务地址为 `http://127.0.0.1:8787`。
- 账号必须先在软件中新增并完成可视化登录。
- Postman 不需要配置鉴权。
- 当前服务只监听本机地址，不要直接把 `8787` 端口暴露到公网。

## Postman 环境变量

创建一个 Postman Environment：

| 变量 | 初始值 | 用途 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8787` | API 根地址 |
| `requestId` | 留空 | 生成接口返回后保存任务 ID |

## 一、生成视频

### 请求

```http
POST {{baseUrl}}/api/v1/video/generate
```

Postman 的 `Body` 选择 `form-data`。不要手动添加 `Content-Type`，Postman 会自动生成 multipart boundary。

| Key | 类型 | 示例 | 必填 | 说明 |
|---|---|---|---|---|
| `prompt` | Text | `让图1和图2中的人物在图3的海边一起跳舞，镜头平稳推进` | 是 | 视频生成提示词。图号按照 `files` 的上传顺序对应。 |
| `model` | Text | `Seedance 2.0 Mini` | 否 | 可选：`Seedance 2.0 Mini`、`Seedance 2.0 Fast`。默认 Mini。 |
| `ratio` | Text | `9:16` | 否 | 可选：`自动`、`3:4`、`4:3`、`9:16`、`16:9`、`1:1`、`21:9`。 |
| `duration` | Text | `10` | 否 | 秒数，服务端限制为 4 到 15 秒。 |
| `timeoutMs` | Text | `120000` | 否 | 任务监控时间。带图片时服务端会保证不少于 10 分钟。 |
| `files` | File 或 Text | 见下方 | 否 | 参考图。支持 jpg/jpeg/png/webp，最多 10 张。 |

### 本地图片：`files` 选择 File

每张图片单独占一行，Key 都叫 `files`，类型选择 `File`：

| Key | Type | Value |
|---|---|---|
| `files` | File | `人物1.jpg` |
| `files` | File | `人物2.jpg` |
| `files` | File | `海边场景.png` |

### 网络图片：`files` 选择 Text

每个网络图片单独占一行，Key 都叫 `files`，类型选择 `Text`，填写纯 HTTPS 地址：

| Key | Type | Value |
|---|---|---|
| `files` | Text | `https://example.com/person-1.jpg` |
| `files` | Text | `https://example.com/person-2.jpg` |
| `files` | Text | `https://example.com/beach.png` |

网络图片要求：

- 必须是公网可访问的 `https://` 地址；
- 图片格式必须是 JPG、JPEG、PNG 或 WEBP；
- 单张网络图片不超过 20 MB；
- 服务端会先下载并校验，再上传到豆包对话框；
- 不要填 MinIO Console 页面地址，使用对象的实际下载地址，例如 `https://s3.example.com/bucket/path.png`。

### 三张网络图片完整示例

```text
prompt     = 让图1和图2中的人物在图3的海边场景中一起跳舞，保持人物身份和场景关系，镜头平稳推进
model      = Seedance 2.0 Mini
ratio      = 9:16
duration   = 10
timeoutMs  = 120000
files      = https://s3.example.com/person-1.jpg
files      = https://s3.example.com/person-2.png
files      = https://s3.example.com/beach.jpg
```

### 成功返回

默认不等待视频完成，持久化任务后返回 `202 Accepted` 和 `requestId`。网络参考图在后台下载、校验；下载失败会通过任务查询接口返回 `failed` 和具体错误，不再阻塞首次响应。二进制图片上传和授权校验仍需先完成。

```json
{
  "requestId": "req_mtnudlmt_740926c4",
  "state": "queued",
  "accountId": null,
  "createdAt": "2026-09-05T03:47:23.191Z",
  "updatedAt": "2026-09-05T03:47:23.191Z"
}
```

把返回的 `requestId` 保存到 Postman 环境变量 `requestId`，然后调用查询接口。

## 二、查询任务状态

```http
GET {{baseUrl}}/api/v1/video/jobs/{{requestId}}
```

建议每 2 到 5 秒查询一次，直到 `state` 变为终态。

### 生成成功

```json
{
  "requestId": "req_mtnudlmt_740926c4",
  "state": "completed",
  "accountId": "account-002",
  "createdAt": "2026-09-05T03:47:23.191Z",
  "updatedAt": "2026-09-05T04:02:11.338Z",
  "conversationId": "38440171474531074",
  "videoVid": "abc123456789",
  "watermarkedUrl": "https://www.doubao.com/....mp4",
  "watermarkFreeUrl": "https://....mp4",
  "watermarkFreeAvailable": true
}
```

结果字段：

- `watermarkedUrl`：有水印视频地址；
- `watermarkFreeUrl`：无水印视频地址，豆包未提供时可能为空；
- `watermarkFreeAvailable`：是否成功取得无水印地址；
- 服务不保存视频文件，地址由豆包侧提供。

### 任务状态

常见状态包括：

| 状态 | 含义 |
|---|---|
| `queued` | 已进入队列 |
| `preparing_assets` | 正在后台下载、校验网络参考图 |
| `selecting_account` | 正在选择豆包账号 |
| `checking_login` | 检查登录状态 |
| `uploading` | 上传参考图 |
| `configuring` | 配置模型、比例和时长 |
| `submitting` | 正在向豆包提交 |
| `generating` | 豆包正在生成 |
| `downloading` | 已发现结果，正在读取视频地址 |
| `completed` | 成功返回视频地址 |
| `failed` | 生成失败 |
| `submission_unknown` | 已执行提交动作，但无法确认豆包是否创建任务，避免重复提交 |
| `awaiting_login` | 需要登录账号 |
| `awaiting_verification` | 需要人工完成验证 |

## 三、提交后同步等待

如果希望一个请求一直等到豆包完成或失败，在生成 URL 后加 `wait=1`：

```http
POST {{baseUrl}}/api/v1/video/generate?wait=1
```

如果希望限制 HTTP 连接等待时间，可增加 `waitTimeoutMs`：

```http
POST {{baseUrl}}/api/v1/video/generate?wait=1&waitTimeoutMs=900000
```

注意：`waitTimeoutMs` 只限制 HTTP 请求等待，不会停止豆包任务。返回 `504 DOUBAO_HTTP_WAIT_TIMEOUT` 后，继续使用查询接口查看同一个 `requestId`。

## 四、恢复任务

人工登录、人工验证或提交状态未知的任务，可以恢复：

```http
POST {{baseUrl}}/api/v1/video/jobs/{{requestId}}/resume
```

Body 留空。对于 `submission_unknown`，只有任务保存了豆包会话证据时才允许恢复；恢复会继续监听原会话，不会重新上传图片或重复提交。

## 五、刷新视频地址

豆包地址过期时，可以只刷新地址，不重新生成：

```http
POST {{baseUrl}}/api/v1/video/jobs/{{requestId}}/refresh-url
```

Body 留空。仅支持已完成且仍保留账号信息的任务。

## 六、健康检查和账号接口

### 健康检查

```http
GET {{baseUrl}}/health
```

### 查询账号

```http
GET {{baseUrl}}/api/v1/accounts
```

### 新增账号

```http
POST {{baseUrl}}/api/v1/accounts
Content-Type: application/json
```

```json
{
  "name": "豆包账号 005"
}
```

新增后需要在软件内打开该账号并完成可视化登录。

### 检查登录

```http
POST {{baseUrl}}/api/v1/accounts/account-002/check-login
```

### 打开登录窗口

```http
POST {{baseUrl}}/api/v1/accounts/account-002/login
```

### 重命名账号

```http
PATCH {{baseUrl}}/api/v1/accounts/account-002
Content-Type: application/json
```

```json
{
  "name": "豆包账号 002"
}
```

### 删除账号

```http
DELETE {{baseUrl}}/api/v1/accounts/account-002
```

正在执行任务的账号不能删除。

## 七、错误处理

错误统一返回 JSON：

```json
{
  "error": "当前模型或生成参数不可用",
  "code": "DOUBAO_PARAMETER_REJECTED"
}
```

常见错误：

| HTTP | Code | 处理建议 |
|---:|---|---|
| 400 | `prompt 不能为空`、图片 URL 无效 | 修正请求参数 |
| 401/登录状态错误 | `DOUBAO_LOGIN_REQUIRED` | 打开登录接口完成登录 |
| 413 | 请求体或图片过大 | 压缩图片或减少图片数量 |
| 415 | 请求格式不支持 | 生成接口使用 `multipart/form-data` 或 `application/json` |
| 429 | `DOUBAO_QUEUE_FULL` | 等待队列空闲后重试 |
| 409 | `DOUBAO_SUBMISSION_UNKNOWN` | 先人工确认，再调用 resume，避免重复生成 |
| 任务错误 | `DOUBAO_VIDEO_QUOTA_EXHAUSTED` | 当前账号会被跳过，服务自动尝试其他账号 |
| 任务错误 | `DOUBAO_VIDEO_RESULT_TIMEOUT` | 查询任务；不要立即重复提交 |

## 八、最简测试顺序

1. `GET {{baseUrl}}/health`，确认服务正常。
2. `GET {{baseUrl}}/api/v1/accounts`，确认至少有一个 `loginState=logged_in` 的账号。
3. `POST {{baseUrl}}/api/v1/video/generate`，Body 使用 `form-data`。
4. 复制返回的 `requestId`。
5. 循环调用 `GET {{baseUrl}}/api/v1/video/jobs/{{requestId}}`。
6. `state=completed` 时读取 `watermarkedUrl` 和 `watermarkFreeUrl`。
