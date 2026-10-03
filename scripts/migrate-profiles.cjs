"use strict";

const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const formalRoot = path.join(process.env.LOCALAPPDATA || path.join(projectRoot, "data"), "DoubaoVideoManager");
const legacyUserData = path.join(projectRoot, "electron-user-data");
const formalUserData = path.join(formalRoot, "electron-user-data");
const preferLegacy = process.argv.includes("--prefer-legacy");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = path.join(formalRoot, `electron-user-data.backup-${stamp}`);

function copyDirectory(source, target) {
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.cpSync(source, target, {recursive: true, force: false, errorOnExist: false});
}

if (!fs.existsSync(legacyUserData)) {
  console.log(`未找到开发版会话目录：${legacyUserData}`);
  process.exit(0);
}

const legacyPartitions = path.join(legacyUserData, "Partitions");
const targetPartitions = path.join(formalUserData, "Partitions");
const partitions = fs.existsSync(legacyPartitions)
  ? fs.readdirSync(legacyPartitions, {withFileTypes: true}).filter(item => item.isDirectory() && /^doubao_service_/i.test(item.name)).map(item => item.name)
  : [];

let copied = 0;
let skipped = 0;
for (const name of partitions) {
  const source = path.join(legacyPartitions, name);
  const target = path.join(targetPartitions, name);
  if (fs.existsSync(target)) {
    if (!preferLegacy) {
      skipped += 1;
      console.log(`跳过已有正式会话：${name}`);
      continue;
    }
    const backupTarget = path.join(backupRoot, "Partitions", name);
    fs.mkdirSync(path.dirname(backupTarget), {recursive: true});
    fs.renameSync(target, backupTarget);
  }
  copyDirectory(source, target);
  copied += 1;
  console.log(`已迁移会话：${name}`);
}

const legacyAccounts = path.join(projectRoot, "config", "accounts.json");
const targetAccounts = path.join(formalRoot, "config", "accounts.json");
if (fs.existsSync(legacyAccounts) && !fs.existsSync(targetAccounts)) {
  fs.mkdirSync(path.dirname(targetAccounts), {recursive: true});
  fs.copyFileSync(legacyAccounts, targetAccounts);
  console.log("已迁移账号配置：accounts.json");
}

console.log(`迁移完成：copied=${copied}, skipped=${skipped}, formalRoot=${formalRoot}`);
if (preferLegacy && copied > 0) console.log(`正式会话备份：${backupRoot}`);
