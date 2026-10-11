import test from 'node:test';
import assert from 'node:assert/strict';
import { homeStatus, closestReading, carMotionAllowed } from '../src/home.js';
import { heatCurve } from '../src/model.js';
import { projectCar } from '../src/carGeometry.js';
test('home distinguishes waiting, stale readings and every received alert state',()=>{
 assert.equal(homeStatus({online:false,status:null}),'Waiting for readings');
 assert.equal(homeStatus({online:false,status:{state:'EMERGENCY'}}),'Connection lost');
 for(const [state,title] of Object.entries({IDLE:'Monitoring',ARMED:'Monitoring',OCCUPANT:'Seat occupied',WARNING:'Cabin warming',EMERGENCY:'Go to the car now'}))assert.equal(homeStatus({online:true,status:{state}}),title);
});
test('chart inspection selects exact recorded values, never forecast or interpolated values',()=>{
 const entries=[{receivedAt:100,status:{tempF:82.123}},{receivedAt:1000,status:{tempF:96.456}}];
 const c=heatCurve(entries,{tempF:96.456,minsToDanger:8},true);
 assert.equal(closestReading(c.samples,300).tempF,96.456);
 assert.equal(closestReading(c.samples,-20).tempF,82.123);
 assert.equal(closestReading(c.samples,0).time,100);
 assert.equal(closestReading([],12),null);
 assert.equal(closestReading(c.samples,NaN),null);
 assert.equal(heatCurve(entries,null,false).forecast,null);
});
test('rotation stops for every motion restriction and resumes only when all allow it',()=>{
 const base={online:true,visible:true,active:true,reduced:false,paused:false,emergency:false};
 assert.equal(carMotionAllowed(base),true);
 for(const key of Object.keys(base))assert.equal(carMotionAllowed({...base,[key]:!base[key]}),false,key);
});
test('car projection rotates a finite depth-sorted mesh and returns to the same angle',()=>{
 const first=projectCar(0),side=projectCar(Math.PI/2),full=projectCar(Math.PI*2);
 assert.ok(first.length>150);
 assert.notDeepEqual(first.map(f=>f.points),side.map(f=>f.points));
 assert.deepEqual(first.map(f=>f.points),full.map(f=>f.points));
 for(const a of [0,.7,1.5,3,4.5,6]) {
 const mesh=projectCar(a);
 assert.ok(mesh.every((f,i)=>Number.isFinite(f.depth)&&!f.points.includes('NaN')&&(i===0||mesh[i-1].depth<=f.depth)));
 }
});

test('parent guidance puts urgent lost readings ahead of reassurance', async () => {
 const { parentGuidance, dangerEstimate } = await import('../src/home.js');
 for (const state of ['WARNING','EMERGENCY']) {
  const vm={online:false,lostAlarm:true,status:{state,minsToDanger:0}};
  assert.equal(parentGuidance(vm).urgent,true);
  assert.match(parentGuidance(vm).title,/child now/);
  assert.match(parentGuidance(vm).detail,/lost contact/);
  assert.equal(dangerEstimate(vm).label,'Last recorded heat estimate');
 }
 assert.match(parentGuidance({online:true,emergency:true,status:{state:'EMERGENCY'}}).detail,/immediately/);
 assert.match(parentGuidance({online:true,status:{state:'ARMED',presence:true}}).detail,/Stay with your child/);
 assert.match(parentGuidance({online:false,status:{state:'IDLE'}}).detail,/cannot confirm/);
 assert.match(parentGuidance({online:false,status:null}).detail,/first reading/);
 assert.match(parentGuidance({online:true,status:{state:'IDLE',presence:false}}).detail,/Check the back seat/);
});
test('parent-facing estimates retain zero, exact decimals, null and stale labels', async () => {
 const { dangerEstimate }=await import('../src/home.js');
 assert.equal(dangerEstimate({online:true,status:{minsToDanger:0}}).value,'Danger level reached');
 assert.equal(dangerEstimate({online:true,status:{minsToDanger:2.125}}).value,'2.125 min');
 assert.equal(dangerEstimate({online:true,status:{minsToDanger:null}}).value,'No estimate');
 assert.equal(dangerEstimate({online:false,status:null}).value,'No estimate');
});
test('Live alert countdown shows the box value as sent, including zero, decimals and no estimate', async () => {
 const { countdownView } = await import('../src/home.js');
 assert.deepEqual(countdownView(7.5), { label: 'DANGER IN', value: '7.5', unit: 'min', spoken: '7.5 minutes to danger, reported by the box' });
 assert.equal(countdownView(12).value, '12');
 assert.equal(countdownView(0).label, 'DANGER REACHED');
 assert.equal(countdownView(0).value, '0');
 for (const missing of [null, undefined, NaN, -1]) {
  assert.equal(countdownView(missing).value, '—');
  assert.equal(countdownView(missing).label, 'NO ESTIMATE');
 }
});
test('seat reading distinguishes unknown from empty and never claims occupancy without a reading', async () => {
 const { seatLabel } = await import('../src/home.js');
 assert.equal(seatLabel(true), 'Occupied');
 assert.equal(seatLabel(false), 'Not detected');
 assert.equal(seatLabel(null), 'Unknown');
 assert.equal(seatLabel(undefined), 'Unknown');
});
test('the phone vibrates only when a live emergency starts', async () => {
 const { alertVibration, ALERT_VIBRATION } = await import('../src/home.js');
 assert.deepEqual(alertVibration(false, true), ALERT_VIBRATION);
 assert.equal(alertVibration(true, true), null, 'no repeat every poll');
 assert.equal(alertVibration(true, false), null);
 assert.equal(alertVibration(false, false), null);
 // A lost connection at EMERGENCY leaves vm.emergency false; a reconnect buzzes again.
 const { viewModel } = await import('../src/model.js');
 const snapshot = { online: true, lastSeen: 1000, status: { state: 'EMERGENCY', tempF: 105, presence: true, minsToDanger: 0 } };
 const lost = viewModel(snapshot, false, 2000, 1000), live = viewModel(snapshot, true, 2000, 1000);
 assert.equal(alertVibration(false, lost.emergency), null);
 assert.deepEqual(alertVibration(lost.emergency, live.emergency), ALERT_VIBRATION);
});
test('model visibility pauses outside the viewport and at exact edges', async () => {
 const {sceneVisible,carMotionAllowed:motion}=await import('../src/home.js');
 const b={y:300,height:230};
 assert.equal(sceneVisible(b,0,300),false);
 assert.equal(sceneVisible(b,0,301),true);
 assert.equal(sceneVisible(b,530,700),false);
 assert.equal(sceneVisible(b,529,700),true);
 assert.equal(sceneVisible(b,0,0),false);
 assert.equal(motion({online:true,visible:false,active:true,reduced:false,paused:false,emergency:false}),false);
});
