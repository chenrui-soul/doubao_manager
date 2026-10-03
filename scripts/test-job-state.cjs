"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "references", "job-state.json"), "utf8"));
const {publicJob} = require(path.join(__dirname, "..", "src", "server.cjs"));
const output = publicJob({...fixture.job, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z"});
assert.equal(output.state, fixture.expectedPublicState);
assert.equal(output.watermarkedUrl, fixture.job.result.watermarkedUrl);
console.log("job state precedence ok");
