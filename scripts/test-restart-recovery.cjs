"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "references", "restart-recovery.json"), "utf8"));
const {recoverInterruptedJobs, scheduleRecoveredJobs} = require(path.join(__dirname, "..", "src", "server.cjs"));

for (let round = 1; round <= 3; round += 1) {
  const jobs = [...fixture.activeStates, ...fixture.preservedStates].map((state, index) => ({id: `round-${round}-${index}`, state, error: null}));
  const store = {activeJobs: () => jobs.filter(job => fixture.activeStates.includes(job.state)), save(job) { const target = jobs.find(item => item.id === job.id); Object.assign(target, job); return target; }};
  const recovered = recoverInterruptedJobs(store);
  assert.equal(recovered, fixture.activeStates.length);
  for (const job of jobs) {
    if (fixture.activeStates.includes(job.state) || job.id.startsWith(`round-${round}-`)) {
      if (fixture.activeStates.includes(job.state)) continue;
    }
  }
  for (const [index, state] of fixture.activeStates.entries()) {
    const job = jobs[index];
    if (state === "queued") assert.equal(job.state, fixture.expectedQueuedState);
    else {
      assert.equal(job.state, fixture.expectedUnknownState);
      assert.equal(job.error.code, fixture.expectedErrorCode);
    }
  }
  fixture.preservedStates.forEach((state, index) => assert.equal(jobs[fixture.activeStates.length + index].state, state));
}
console.log("restart recovery ok (3 rounds)");

const evidenceJob = {id: "resume-existing", state: "generating", account_id: "account-001", payload: {prompt: "继续监听", conversationId: "conv-123"}, result: null, error: null};
const evidenceStore = {activeJobs: () => [evidenceJob], save(job) { Object.assign(evidenceJob, job); return evidenceJob; }};
assert.equal(recoverInterruptedJobs(evidenceStore), 1);
assert.equal(evidenceJob.state, "queued");
assert.equal(evidenceJob.payload.resumeExisting, true);
assert.equal(evidenceJob.payload.accountLockRequired, true);
assert.equal(evidenceJob.payload.preferredAccountId, "account-001");
console.log("restart resume-existing evidence ok");

for (let round = 1; round <= 3; round += 1) {
  const jobs = [
    {id: `queued-${round}`, state: "queued"},
    {id: `generating-${round}`, state: "generating"},
    {id: `completed-${round}`, state: "completed"},
  ];
  const scheduled = [];
  assert.equal(scheduleRecoveredJobs({activeJobs: () => jobs}, job => { scheduled.push(job.id); return true; }), 1);
  assert.deepEqual(scheduled, [`queued-${round}`]);
}
console.log("restart recovered queue scheduling ok (3 rounds)");
