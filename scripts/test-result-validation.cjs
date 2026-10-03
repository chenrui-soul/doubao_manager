"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "references", "result-validation.json"), "utf8"));
const {hasVideoResult} = require(path.join(__dirname, "..", "src", "server.cjs"));
fixture.valid.forEach(result => assert.equal(hasVideoResult(result), true));
fixture.invalid.forEach(result => assert.equal(hasVideoResult(result), false));
console.log("result validation ok");
