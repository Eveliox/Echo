import { Buffer } from 'node:buffer';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const asset=JSON.parse(gunzipSync(readFileSync(new URL('../assets/models/sedan.json.gz',import.meta.url))));
test('bundled sedan retains its attribution and finite detailed geometry',()=>{
 assert.match(asset.credit.author,/RBLXSupercars/);
 assert.match(asset.credit.license,/CC-BY-4.0/);
 assert.match(asset.sourceSHA256,/^[0-9a-f]{64}$/);
 let triangles=0;const roles=new Set();
 for(const part of asset.parts){
  const positions=Buffer.from(part.position,'base64'), normals=Buffer.from(part.normal,'base64'),indices=Buffer.from(part.index,'base64');
  assert.equal(positions.length%6,0);assert.equal(normals.length,positions.length/2);assert.equal(indices.length%12,0);
  for(let i=0;i<indices.length;i+=4)assert.ok(indices.readUInt32LE(i)<positions.length/6);
  assert.equal(part.groups.reduce((n,g)=>n+g[1],0),indices.length/4);
  for(const [offset,count,role] of part.groups){assert.ok(offset>=0 && offset+count<=indices.length/4);roles.add(role);}
  triangles+=indices.length/12;
 }
 assert.equal(triangles,179692);
 for(const role of ['body','bodySolid','glass','heatedSeat','seat','rim','tire'])assert.ok(roles.has(role),role);
});
test('viewer ships model and scripts locally with no network access',()=>{
 const {html}=JSON.parse(readFileSync(new URL('../assets/models/viewer.json',import.meta.url)));
 assert.ok(html.includes("connect-src 'none'"));
 assert.ok(html.includes("default-src 'none'"));
 assert.doesNotMatch(html,/<script[^>]+src=/);
 assert.ok(html.includes(readFileSync(new URL('../assets/models/sedan.json.gz',import.meta.url)).toString('base64')));
});
