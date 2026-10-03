"use strict";

const path = require("path");

// 服务版本自带豆包自动化核心，避免登录窗口受外部灵帧进程或路径影响。
const controllerFile = path.join(__dirname, "vendor", "browser-controller.cjs");
module.exports = require(controllerFile);
