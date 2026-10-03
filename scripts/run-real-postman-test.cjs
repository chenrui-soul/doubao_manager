"use strict";
const fs = require("node:fs");
const path = require("node:path");
const base = "C:/Users/ADMINI~1/AppData/Local/Temp";
const files = [
  "codex-clipboard-a94a71b6-c9be-479c-b45d-0dad83232045.jpg",
  "codex-clipboard-b14bcd07-4e45-4c8c-9415-17a53a1a92bd.jpg",
  "codex-clipboard-32581300-97da-41f9-a6c7-03e09e749f60.jpg",
  "codex-clipboard-b9739109-655d-43fe-a4c1-bcef1c2f0374.jpg",
  "codex-clipboard-9f7a7817-d6b1-4335-910e-591ceef9e6d9.jpg",
  "codex-clipboard-65d6f1a6-8469-468a-90af-2a4cf0664679.jpg",
  "codex-clipboard-dd8f8136-4c99-46ea-ab59-01fbd1eb487c.jpg",
].map(name => path.join(base, name));
const prompt = `电影级真人写实，真实皮肤、毛发、针织、帆布、旧木、金属和雨水质感。冷蓝雨夜包围暖金救助空间，暖色实景灯光70%、冷蓝环境光30%，真实生活质感，轻悬疑。顾言真在爪印宠物店前厅抱着三腿犬阿七，玻璃门在画左，爪印墙向画右展开，门外持续强雨，门保持关闭，不越轴。0-5.2秒中近景，顾言真正对玻璃门稳定陈述：“领养交接必须有芯片扫码记录和监管单。”口型逐字同步。5.2-10秒轻微推近门外红色100编号牌后回焦顾言真，她看向红卡再看回门外男人，说：“你手上那张卡，不是合法凭证。”门仍关闭。连续雨声、店内低频、阿七呼吸。人物、犬、红色100牌、宠物店、故事板、首帧、尾帧身份固定；阿七始终三腿，右后残肢不承重。禁止身份漂移、第四条腿、道具复制、数字错误、镜像翻转、字幕、水印、额外台词。`;
async function main() {
  const form = new FormData();
  form.set("prompt", prompt); form.set("model", "Seedance 2.0 Mini"); form.set("ratio", "16:9"); form.set("duration", "10");
  for (const file of files) { if (!fs.existsSync(file)) throw new Error(`图片不存在: ${file}`); form.append("files", new Blob([fs.readFileSync(file)], {type: "image/jpeg"}), path.basename(file)); }
  const response = await fetch("http://127.0.0.1:8787/api/v1/video/generate", {method: "POST", body: form});
  const created = await response.json(); console.log(JSON.stringify({status: response.status, created}, null, 2));
  if (response.status !== 202) process.exit(1);
  const id = created.requestId; const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const current = await (await fetch(`http://127.0.0.1:8787/api/v1/video/jobs/${encodeURIComponent(id)}`)).json();
    console.log(JSON.stringify({requestId: id, state: current.state, accountId: current.accountId, timings: current.timings, error: current.error, watermarkedUrl: current.watermarkedUrl, watermarkFreeUrl: current.watermarkFreeUrl}));
    if (["completed", "failed", "submission_unknown", "awaiting_login", "awaiting_verification"].includes(current.state)) { if (current.state !== "completed") process.exitCode = 2; return; }
  }
  console.error(JSON.stringify({requestId: id, error: "test poll deadline exceeded"})); process.exitCode = 3;
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
