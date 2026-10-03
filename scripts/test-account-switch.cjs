"use strict";

const assert = require("assert");
const Module = require("module");
const fs = require("fs");
const path = require("path");
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "electron") return {WebContentsView: class {}, shell: {openExternal() {}}};
  return originalLoad.call(this, request, parent, isMain);
};

const {activateSession} = require(path.join(__dirname, "..", "src", "embedded-browser-manager.cjs"));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "references", "account-switch.json"), "utf8"));
const calls = [];
const make = id => ({id, visible: true, view: {setVisible(value) { calls.push([id, value]); }}});
const first = make(fixture.accounts[0]);
const second = make(fixture.accounts[1]);
const sessions = new Map([[first.id, first], [second.id, second]]);
activateSession(sessions, second);
assert.equal(first.visible, fixture.expected[first.id].visible);
assert.equal(second.visible, fixture.expected[second.id].visible);
assert.deepEqual(calls, [[first.id, false], [second.id, true]]);
console.log("account switch ok");
