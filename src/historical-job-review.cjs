"use strict";

// Repairs only contradicted metadata with explicit recorded evidence. Never
// schedules a task, infers a missing conversation, or invents a video result.
function reviewHistoricalJob(job) {
  const error=job.error||{}, history=job.payload?.attemptHistory||[];
  let state, nextError;
  const modal=String(error.monitorDiagnostic?.pageConfirmationText||"");
  if(job.state==="submission_unknown"&&error.code==="DOUBAO_VIDEO_TASK_NOT_CREATED"&&/安全确认/.test(modal)&&/素材.*授权/.test(modal.replace(/\s+/g,""))) {
    state="awaiting_verification";
    nextError={...error,code:"DOUBAO_ASSET_AUTHORIZATION_REQUIRED",message:"历史页面记录显示素材授权安全确认未处理，请核对原账号页面",category:"manual_action",notSentVerified:false,submittedVerified:false,safeToRetry:false};
  } else if(job.state==="failed"&&error.code==="DOUBAO_CONFIRMATION_INPUT_NOT_READY"&&history.some(h=>h.code===error.code&&h.notSentVerified===false)) {
    state="submission_unknown";nextError={...error,notSentVerified:false,submittedVerified:false,submissionUnknown:true,safeToRetry:false};
  } else if(job.state==="submission_unknown"&&error.quotaExhausted===true&&error.terminalFailureVerified===true) {
    state="failed";nextError={...error,safeToRetry:false};
  }
  if(!state) return null;
  return {...job,state,error:nextError,recovery:{at:new Date().toISOString(),mode:"historical_evidence_review",previousState:job.state,previousUpdatedAt:job.updated_at,previousError:error}};
}
module.exports={reviewHistoricalJob};
