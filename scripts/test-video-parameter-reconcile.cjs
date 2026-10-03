"use strict";
const assert = require("node:assert/strict");
const {reconcileVideoParameters,normalizeVideoModelLabel,probeVideoParameters} = require("../src/vendor/video-parameters.cjs");
const desired = {model:"Seedance 2.0 Mini",ratio:"9:16",duration:10};
const base = ({ratio="9:16",duration=10,menuOpen=false}={}) => ({model:"Seedance 2.0 Mini",modelMatches:true,ratio,duration,panel:{x:10,y:10,state:menuOpen?"open":"closed",expanded:String(menuOpen)},menuOpen,ratioTarget:menuOpen?{x:20,y:20}:null,durationTarget:menuOpen?{x:30,y:30,method:"native",min:4,max:15,step:1,value:duration}:null});
async function make(states) {
  const controller = {clicks:[], async evaluate(_session, expression) {
    const action = expression.match(/\),"(read|setDuration)"\)$/)?.[1] || "read";
    const value = typeof states === "function" ? states(action,this) : states.shift();
    return value;
  }, async dispatchHumanClick(_session, point) { this.clicks.push(point); return true; }, async connect() { return {send:async()=>{}}; }};
  return controller;
}
(async () => {
  assert.equal(normalizeVideoModelLabel("模型 Seedance 2.0 Mini"), "seedance2.0mini");
  assert.equal(normalizeVideoModelLabel("Seedance 2.0 Mini"), "seedance2.0mini");
  assert.match(probeVideoParameters.toString(), /const normalizeModel\s*=/, "serialized page probe must define model normalization in-page");
  assert.doesNotMatch(probeVideoParameters.toString(), /normalizeVideoModelLabel\s*\(/, "serialized page probe must not depend on a Node-side helper");
  const matched = await make([base()]);
  await reconcileVideoParameters(matched, {}, desired);
  assert.equal(matched.clicks.length, 0, "already matching parameters must not click");

  const prefixedModel = await make([{...base(), model:"模型 Seedance 2.0 Mini", modelMatches:true}]);
  await reconcileVideoParameters(prefixedModel, {}, desired);
  assert.equal(prefixedModel.clicks.length, 0, "model labels with the Doubao prefix must still match");

  let state = base({ratio:"16:9",duration:10});
  const corrected = await make((action, c) => {
    if (action === "read") {
      if (c.clicks.length === 0) return state;
      if (c.clicks.length === 1) return base({ratio:"16:9",duration:10,menuOpen:true});
      return base({ratio:"9:16",duration:10,menuOpen:false});
    }
    return base({ratio:"9:16",duration:10,menuOpen:true});
  });
  await reconcileVideoParameters(corrected, {}, desired);
  assert.equal(corrected.clicks.length, 2, "mismatched ratio opens menu once and selects once");

  const drift = await make((action, c) => {
    if (action === "read") {
      if (c.clicks.length === 0) return base({ratio:"16:9",duration:10});
      if (c.clicks.length === 1) return {...base({ratio:"16:9",duration:10,menuOpen:true}), ratioTarget:{x:20.4,y:20.2}};
      return base({ratio:"9:16",duration:10,menuOpen:false});
    }
    return {...base({ratio:"16:9",duration:10,menuOpen:true}), ratioTarget:{x:20,y:20}};
  });
  await reconcileVideoParameters(drift, {}, desired);
  assert.equal(drift.clicks.length, 2, "sub-pixel layout drift must not reject the still-visible ratio option");

  let moved=0,selected=false;
  const reflow=await make(()=>base({ratio:selected?'9:16':'16:9',menuOpen:true}));
  reflow.dispatchHumanClick=async(_s,_p,verify)=>{
    assert.equal(await verify(),true);
    moved++;
    if(moved===1)return false; // Reflow prevented the press; safe to re-read.
    selected=true;return true;
  };
  await reconcileVideoParameters(reflow,{},desired);
  assert.equal(moved,2,'retry only a click that was rejected before the press');

  const open = await make([base({ratio:"9:16",duration:10,menuOpen:true})]);
  await reconcileVideoParameters(open, {}, desired);
  assert.equal(open.clicks.length, 0, "an already open matching panel must not be toggled closed");

  console.log("Video parameter reconciliation: skip matched, open once for mismatch, preserve open panel passed");
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
