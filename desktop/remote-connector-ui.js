"use strict";

(() => {
  const $ = selector => document.querySelector(selector);
  const dialog = $("#remoteConnectorDialog");
  if (!dialog || !window.doubaoDesktop?.remoteConnectorGet) return;
  const form = $("#remoteConnectorForm");
  const server = $("#remoteServer");
  const token = $("#remoteToken");
  const status = $("#remoteConnectorStatus");
  const save = $("#saveRemoteConnector");
  let statusTimer;

  function renderState(value) {
    const state = value?.state || "未配置";
    status.textContent = value?.server ? `${state} · ${value.server}` : state;
    status.className = `remote-connector-status ${value?.connected ? "is-connected" : ""}`;
  }

  async function refresh() {
    try { renderState(await window.doubaoDesktop.remoteConnectorGet()); }
    catch { status.textContent = "连接状态暂时无法读取"; }
  }

  async function open() {
    const value = await window.doubaoDesktop.remoteConnectorGet();
    server.value = value.server || "";
    token.value = value.token || "";
    token.type = "password";
    $("#toggleRemoteToken").textContent = "显示";
    renderState(value);
    if (!dialog.open) dialog.showModal();
    clearInterval(statusTimer);
    statusTimer = setInterval(refresh, 5000);
  }

  function close() {
    clearInterval(statusTimer);
    statusTimer = null;
    if (dialog.open) dialog.close();
  }

  $("#openRemoteConnector").addEventListener("click", () => { void open(); });
  $("#closeRemoteConnector").addEventListener("click", close);
  $("#cancelRemoteConnector").addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  $("#toggleRemoteToken").addEventListener("click", () => {
    const visible = token.type === "text";
    token.type = visible ? "password" : "text";
    $("#toggleRemoteToken").textContent = visible ? "显示" : "隐藏";
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    status.textContent = "正在保存并连接…";
    status.className = "remote-connector-status";
    try {
      const value = await window.doubaoDesktop.remoteConnectorSave({server: server.value.trim(), token: token.value.trim()});
      renderState(value);
      token.type = "password";
      $("#toggleRemoteToken").textContent = "显示";
    } catch (error) {
      status.textContent = error?.message || "连接配置无效";
      status.className = "remote-connector-status is-error";
    } finally { save.disabled = false; }
  });
})();
