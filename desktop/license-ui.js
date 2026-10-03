"use strict";
(() => {
  const dialog = document.querySelector("#licenseDialog");
  const node = id => document.getElementById(id);
  let state = {valid: false};
  let revealVersion = 0;
  let secretRevealed = false;
  let refreshing = false;
  let activating = false;
  let openedManually = false;
  const shell = document.querySelector(".app-shell");
  const activationCodes = new Set(["DOUBAO_LICENSE_REQUIRED", "DOUBAO_LICENSE_EXPIRED", "DOUBAO_LICENSE_REJECTED", "DOUBAO_LICENSE_DEVICE_MISMATCH", "DOUBAO_LICENSE_STORAGE_ERROR"]);
  function concealSecret() {
    revealVersion++;
    secretRevealed = false;
    node("storedLicenseSecret").type = "password";
    node("storedLicenseSecret").value = state.valid && !state.verificationDisabled ? "••••••••" : "";
    node("revealLicense").textContent = "查看";
    node("revealLicense").disabled = false;
  }
  function closeDialog() {
    openedManually = false;
    concealSecret();
    if (state.valid) node("licenseSecret").value = "";
    dialog.close();
  }
  async function show() {
    if (state.verificationDisabled) return;
    await window.doubaoDesktop.showLicense();
    if (!dialog.open) {
      if (state.valid) dialog.showModal();
      else dialog.show();
    }
  }
  async function render(value) {
    const previouslyValid = state.valid;
    state = value;
    node("openLicense").hidden = value.verificationDisabled === true;
    node("storedLicense").hidden = !value.valid || value.verificationDisabled === true;
    if (!value.valid || value.verificationDisabled || !previouslyValid) concealSecret();
    if (value.verificationDisabled) {
      node("licenseSecret").value = "";
      openedManually = false;
    }
    node("deviceCode").value = value.deviceCode || "";
    node("licenseMessage").textContent = value.message || (value.valid ? "已激活" : "请激活授权");
    const expiry = value.valid && value.permanent ? "长期有效" : (value.expiresAt ? new Date(value.expiresAt).toLocaleString("zh-CN") : "");
    node("licenseExpiry").textContent = expiry ? `授权到期时间：${expiry}` : "";
    node("licenseSummary").textContent = value.verificationDisabled ? "授权验证已暂时停用" : value.valid ? (value.permanent ? "授权有效 · 长期有效" : `授权有效 · ${new Date(value.expiresAt).toLocaleDateString("zh-CN")} 到期`) : "授权未激活";
    node("licenseSummary").className = `license-summary ${value.valid ? "is-valid" : "is-invalid"}`;
    node("closeLicense").hidden = !value.valid;
    shell.inert = !value.valid;
    shell.hidden = !value.valid;
    node("startupScreen").hidden = value.valid;
    if (value.valid) {
      if (dialog.open && !openedManually) closeDialog();
      if (!previouslyValid) { refreshAccounts(); refreshTasks(); }
    } else if (activationCodes.has(value.code)) {
      node("startupScreen").hidden = true;
      if (previouslyValid && dialog.open) closeDialog();
      node("startupTitle").textContent = "需要激活授权";
      node("startupMessage").textContent = value.message || "请输入设备密钥继续使用";
      node("retryStartup").hidden = true;
      await show();
    } else {
      // Network/service failures do not mean that a new key is required.
      if (dialog.open && !openedManually) closeDialog();
      node("startupTitle").textContent = "暂时无法完成授权验证";
      node("startupMessage").textContent = value.message || "请检查网络后重试";
      node("retryStartup").hidden = false;
    }
  }
  async function refresh(force = false) {
    if (refreshing || activating) return;
    refreshing = true;
    try {
      const value = await window.doubaoDesktop.licenseStatus(force);
      await render(value);
    }
    catch { await render({valid: false, message: "授权服务未连接，请稍后重试"}); }
    finally { refreshing = false; }
  }
  dialog.addEventListener("cancel", event => { event.preventDefault(); if (state.valid) closeDialog(); });
  dialog.addEventListener("close", () => { if (!dialog.open) { openedManually = false; concealSecret(); if (state.valid) node("licenseSecret").value = ""; } });
  node("revealLicense").addEventListener("click", async () => {
    if (secretRevealed) { concealSecret(); return; }
    if (!dialog.open || !state.valid || state.verificationDisabled) return;
    const version = ++revealVersion;
    node("revealLicense").disabled = true;
    try {
      const secret = await window.doubaoDesktop.licenseSecret();
      if (version !== revealVersion || !dialog.open || !state.valid || state.verificationDisabled) return;
      if (!secret) { node("licenseMessage").textContent = "当前密钥暂时无法读取，请重新验证后再试"; return; }
      node("storedLicenseSecret").value = secret;
      node("storedLicenseSecret").type = "text";
      node("revealLicense").textContent = "隐藏";
      secretRevealed = true;
    } catch { if (version === revealVersion) node("licenseMessage").textContent = "当前密钥读取失败，请重新验证后再试"; }
    finally { if (version === revealVersion) node("revealLicense").disabled = false; }
  });
  node("openLicense").addEventListener("click", async () => { openedManually = true; await show(); });
  node("closeLicense").addEventListener("click", () => { if (state.valid) closeDialog(); });
  node("retryLicense").addEventListener("click", () => refresh(true));
  node("retryStartup").addEventListener("click", async () => {
    node("retryStartup").disabled = true;
    node("startupTitle").textContent = "正在连接服务";
    node("startupMessage").textContent = "请稍候…";
    try { await refresh(true); } finally { node("retryStartup").disabled = false; }
  });
  node("copyDevice").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(node("deviceCode").value); node("licenseMessage").textContent = "设备码已复制"; }
    catch { node("deviceCode").select(); node("licenseMessage").textContent = "请按 Ctrl+C 复制设备码"; }
  });
  node("licenseForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (activating || state.verificationDisabled) return;
    activating = true;
    node("activateLicense").disabled = true;
    node("licenseMessage").textContent = "正在连接密钥中心…";
    try {
      const response = await fetch("http://127.0.0.1:8787/api/v1/license/activate", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({secret: node("licenseSecret").value}), signal: AbortSignal.timeout(25000)});
      const result = await response.json();
      if (response.ok && result.license?.valid === true) {
        node("licenseSecret").value = "";
        concealSecret();
        await render(result.license);
        closeDialog();
        refreshAccounts(); refreshTasks();
      } else {
        node("licenseMessage").textContent = result.error || "激活失败，请检查设备密钥";
      }
    } catch { node("licenseMessage").textContent = "激活请求未完成，请检查网络并重新验证授权状态"; }
    finally { activating = false; node("activateLicense").disabled = false; }
  });
  refresh();
  setInterval(() => refresh(), 5000);
})();
