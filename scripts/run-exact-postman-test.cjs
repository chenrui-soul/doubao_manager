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
const prompt = String.raw`【段级视觉风格】 冷蓝雨夜包围暖金救助空间，以真实生活质感承载温柔守护与轻悬疑。；70% 暖色实景灯光与 30% 冷蓝雨夜环境光；旧而干净、使用频繁、可持续经营的社区宠物店；人物情绪克制，通过视线、呼吸、抱护和专业动作表达；悬疑来自编号、记录、门外压力和碎片记忆，不依赖恐怖化画面  【本段剧情范围与唯一核心结果】 顾言真说清合法交接所需材料，否定红卡作为合法凭证。  【参考资产绑定】 - 绑定资产：图一（@图 1）顾言真 - 绑定资产：图二（@图 2）阿七 - 绑定资产：图三（@图 3）红色 100 编号牌 - 绑定资产：图四（@图 4）爪印宠物店 - 绑定资产：图五（@图 5）本段宫格故事板 - 绑定资产：图六（@图 6）本段首帧 - 绑定资产：图七（@图 7）本段尾帧  【空间、轴线与光影基准】 玻璃门在画左，爪印墙向画右展开；玻璃门 — 顾言真 — 爪印墙主轴；不越轴；店内暖金吊灯、门外冷蓝雨光，暖冷约 70:30；16:9 横画幅。  【0.0 秒初始状态】 门外男人短暂停顿；顾言真抓住程序漏洞。；爪印宠物店前厅爪印墙；玻璃门外持续强雨；关闭；室内暖金 70%，室外冷蓝 30%；九十九枚爪印与一个空位；蓝色印泥；红色 100 编号牌；玻璃门在画左，爪印墙向画右展开；玻璃门 — 顾言真 — 爪印墙主轴  【时间轴】 [0.00-5.20 秒 | 镜头 010] - 构图与摄影机：顾言真中近景；顾言真可见口型与门锁；正侧面；静止；玻璃门 — 顾言真 — 爪印墙主轴；不越轴 - 路线、动作、道具与物理过程：顾言真在门内稳定陈述，手臂抱犬但身体正对玻璃门，雨水把门外人影切碎。 不接受门外红卡。 结束时：顾言真已说清合法交接所需材料。 - 人物表演与身体反馈：顾言真身体正对玻璃门，双臂抱稳阿七；下颌平稳、视线直指门外，逐项重读记录和监管单。 - 对白、口型与声音：0.20–5.00 秒，顾言真：“领养交接必须有芯片扫码记录和监管单。”（画内对白，嘴部清晰且无遮挡，逐字同步口型；专业坚定，自然语速，自然换气，不抢句，句尾下落）；环境声：连续雨声、店内低频与阿七呼吸；跨镜保持声场方向；拟音：衣物、脚步或玻璃门细节拟音，只在本镜实际动作触发处同步，未说话角色保持闭嘴。 - 光影、特效与环境反馈：店内暖金吊灯与画左玻璃门冷蓝雨光；人物柔光，湿毛、玻璃与金属保留真实高光；专业占据主动；湿毛、玻璃、织物与道具保留真实接触和反光，门外雨势延续，光源位置连续。  [5.20-10.00 秒 | 镜头 011] - 构图与摄影机：门内外关系近景；顾言真嘴部和雨幕后的红卡；顾言真侧脸与红卡同框；轻微推近红卡后回焦人物；玻璃门 — 顾言真 — 爪印墙主轴；不越轴 - 路线、动作、道具与物理过程：顾言真眼线落到门外红卡，再抬回男人轮廓，明确否定。 红色 100 编号牌只展示红色正面与 100 数字轮廓。 结束时：顾言真明确不承认红卡的合法性；门仍关闭。 - 人物表演与身体反馈：顾言真先以眼线指向红卡，再抬眼对准男人轮廓；下颌微收、句尾落下，手臂持续承托阿七。 - 对白、口型与声音：5.60–9.00 秒，顾言真：“你手上那张卡，不是合法凭证。”（画内对白，嘴部清晰且无遮挡，逐字同步口型；专业坚定，自然语速，自然换气，不抢句，句尾下落）；环境声：连续雨声、店内低频与阿七呼吸；跨镜保持声场方向；拟音：衣物、脚步或玻璃门细节拟音，只在本镜实际动作触发处同步，未说话角色保持闭嘴。 - 光影、特效与环境反馈：店内暖金吊灯与画左玻璃门冷蓝雨光；人物柔光，湿毛、玻璃与金属保留真实高光；坚定拒绝；湿毛、玻璃、织物与道具保留真实接触和反光，门外雨势延续，光源位置连续。  【目标时长最终状态】 顾言真明确不承认红卡的合法性；门仍关闭。；爪印宠物店前厅爪印墙；玻璃门外持续强雨；关闭；室内暖金 70%，室外冷蓝 30%；九十九枚爪印与一个空位；蓝色印泥；红色 100 编号牌；玻璃门在画左，爪印墙向画右展开；玻璃门 — 顾言真 — 爪印墙主轴  【下一段续接状态】 顾言真明确不承认红卡的合法性；门仍关闭。；爪印宠物店前厅爪印墙；玻璃门外持续强雨；关闭；室内暖金 70%，室外冷蓝 30%；九十九枚爪印与一个空位；蓝色印泥；红色 100 编号牌；玻璃门在画左，爪印墙向画右展开；玻璃门 — 顾言真 — 爪印墙主轴  【连续性硬约束】 顾言真、阿七与本段资产身份全程固定；阿七始终三腿，右后残肢不承重；门在画左、爪印墙向画右，不越批准主轴；新爪印完成后不退回空位；道具转移必须连续，不凭空复制；对白保持原文和时间，画内口型逐字同步，心声与电话声均不由画内听者代说；每段独立重建所列参考图中的状态。  【禁止项】 身份漂移，脸型变化，服装跳变，阿七增加第四条腿，右后残肢换边，道具复制，数字 100 错误，门与爪印墙镜像翻转，无因果瞬移，穿模，白底多视图，宫格边框，字幕和水印，卡通塑料质感，血腥伤口，魔法光团，未知人物，额外台词，动物心声张嘴，电话说话人出镜。`;
async function main() {
  const form = new FormData(); form.set("prompt", prompt); form.set("model", "Seedance 2.0 Mini"); form.set("ratio", "16:9"); form.set("duration", "10");
  for (const file of files) { if (!fs.existsSync(file)) throw new Error(`图片不存在: ${file}`); form.append("files", new Blob([fs.readFileSync(file)], {type: "image/jpeg"}), path.basename(file)); }
  console.log(JSON.stringify({promptLength: prompt.length, fileCount: files.length, model: "Seedance 2.0 Mini", ratio: "16:9", duration: 10}));
  const response = await fetch("http://127.0.0.1:8787/api/v1/video/generate", {method: "POST", body: form});
  const created = await response.json(); console.log(JSON.stringify({status: response.status, created}, null, 2)); if (response.status !== 202) process.exit(1);
  const id = created.requestId; const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5000)); const current = await (await fetch(`http://127.0.0.1:8787/api/v1/video/jobs/${encodeURIComponent(id)}`)).json(); console.log(JSON.stringify({requestId: id, state: current.state, accountId: current.accountId, timings: current.timings, error: current.error, watermarkedUrl: current.watermarkedUrl, watermarkFreeUrl: current.watermarkFreeUrl})); if (["completed", "failed", "submission_unknown", "awaiting_login", "awaiting_verification"].includes(current.state)) { if (current.state !== "completed") process.exitCode = 2; return; } }
  console.error(JSON.stringify({requestId: id, error: "test poll deadline exceeded"})); process.exitCode = 3;
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
