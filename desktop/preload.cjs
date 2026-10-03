"use strict";

const {contextBridge, ipcRenderer} = require("electron");

contextBridge.exposeInMainWorld("doubaoDesktop", {
  openFolder: () => ipcRenderer.invoke("service:open-folder"),
  openData: () => ipcRenderer.invoke("service:open-logs"),
  remoteConnectorGet: () => ipcRenderer.invoke("remote-connector:get"),
  remoteConnectorSave: config => ipcRenderer.invoke("remote-connector:save", config),
  browserAction: action => ipcRenderer.invoke("browser:action", action),
  licenseStatus: force => ipcRenderer.invoke("license:status", force === true),
  licenseSecret: () => ipcRenderer.invoke("license:secret"),
  showLicense: () => ipcRenderer.invoke("license:show"),
});
