import test from 'node:test';
import assert from 'node:assert/strict';
import { homeStatus, closestReading } from '../src/home.js';
import { heatCurve } from '../src/model.js';
import { carMotionAllowed, projectCar } from '../src/carGeometry.js';
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
