"use strict";
// Clean, repeatable portable build. Never copy runtime data or credentials.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const {createRequire} = require("node:module");
const {readPolicy, checkPackage} = require("./license-package-check.cjs");
const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${name} 缺少参数`);
  return args[i + 1];
}
async function main() {
  const policyBytes = fs.readFileSync(path.join(root, "config/license-policy.json"));
  const policy = readPolicy(policyBytes);
  const builderPath = option("--builder", process.env.DOUBAO_BUILDER_CLI) || require.resolve("electron-builder");
  const builderRequire = createRequire(path.resolve(builderPath));
  const {build, Platform} = builderRequire("electron-builder");
  const asar = builderRequire("@electron/asar");
  const output = path.resolve(option("--out", path.join(root, "dist")));
  const electronDist = option("--electron-dist", "");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-clean-build-"));
  const expectedFiles = new Map();
  function copy(relative) {
    const source = path.join(root, relative), target = path.join(stage, relative);
    if (fs.statSync(source).isDirectory()) {
      for (const file of fs.readdirSync(source)) copy(path.posix.join(relative, file));
    } else {
      const bytes = fs.readFileSync(source);
      fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, bytes);
      expectedFiles.set(relative, bytes);
    }
  }
  for (const relative of ["src", "desktop", "assets/doubao-manager.ico", "assets/doubao-manager.png", "assets/doubao-manager.svg", "README.md"]) copy(relative);
  fs.mkdirSync(path.join(stage, "config"));
  fs.writeFileSync(path.join(stage, "config/license-policy.json"), policyBytes);
  fs.writeFileSync(path.join(stage, "config/accounts.json"), JSON.stringify({accounts: []}) + "\n");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
  if (Object.keys(pkg.dependencies).join() !== "ws") throw new Error("依赖清单已变化，请更新干净构建的依赖复制规则");
  fs.cpSync(path.join(root, "node_modules/ws"), path.join(stage, "node_modules/ws"), {recursive: true});
  pkg.build.directories.output = output;
  pkg.build.npmRebuild = false;
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(pkg, null, 2));
  const verification = {version: pkg.version, expectedVerificationEnabled: policy.verificationEnabled, stage};
  await build({projectDir: stage, targets: Platform.WINDOWS.createTarget("portable"), config: {
    ...(electronDist ? {electronDist:path.resolve(electronDist)} : {}),
    beforePack: () => checkPackage(file => fs.readFileSync(path.join(stage, file)), policy.verificationEnabled),
    afterPack: context => {
      const archive = path.join(context.appOutDir, "resources/app.asar");
      const read = file => asar.extractFile(archive, path.normalize(file));
      verification.package = checkPackage(read, policy.verificationEnabled);
      for (const [file, bytes] of expectedFiles) {
        if (!Buffer.from(read(file)).equals(bytes)) throw new Error(`成品与源码不一致：${file}`);
      }
      const entries = asar.listPackage(archive);
      if (entries.some(file => /(?:^|[\\/])(?:jobs\.json|online-license\.json|tools-license-private\.pem|Cookies|profiles|data)(?:[\\/]|$)/i.test(file))) throw new Error("成品包含禁止交付的运行数据");
      verification.sourceFilesVerified = expectedFiles.size;
      verification.archive = archive;
    },
  }});
  fs.writeFileSync(path.join(output, "package-verification.json"), JSON.stringify(verification, null, 2));
  console.log(`成品验收通过：${pkg.version}，授权验证${policy.verificationEnabled ? "开启" : "关闭"}，${expectedFiles.size} 个文件与源码一致`);
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
