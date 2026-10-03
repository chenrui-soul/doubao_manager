"use strict";
// Run with Electron, in an isolated profile; no real account is opened.
const {app, BrowserWindow} = require("electron");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "doubao-gpu-probe-")));
app.commandLine.appendSwitch("no-sandbox");
const software = process.argv.includes("--software");
if (software) {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("in-process-gpu");
  app.disableHardwareAcceleration();
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({show: false, webPreferences: {backgroundThrottling: false, contextIsolation: true, nodeIntegration: false}});
  const timer = setTimeout(() => { console.error("GPU probe timed out"); app.exit(1); }, 15000);
  try {
    await win.loadURL("data:text/html,<html><body><canvas></canvas></body></html>");
    const rendered = await win.webContents.executeJavaScript(`(() => {
      const gl = document.querySelector('canvas').getContext('webgl');
      if (!gl) return {webgl: false};
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {webgl: true, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable'};
    })()`);
    const result = {software, features: app.getGPUFeatureStatus(), rendered};
    const dir = path.join(__dirname, "log"); fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, software ? "gpu-software.json" : "gpu-hardware.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    clearTimeout(timer); win.destroy(); app.exit(0);
  } catch (error) { clearTimeout(timer); console.error(error); app.exit(1); }
});
