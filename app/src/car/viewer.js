import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const send = type => window.ReactNativeWebView?.postMessage(JSON.stringify({ type }));
let renderer, environment, scene, car, camera, heatMaterial, seatMaterial;
let moving = false, online = false, heat = 0, angle = .3, elapsed = 0, frame = 0, lastTime = 0;
const rings = [];
function fail() { moving = false; cancelAnimationFrame(frame); send('error'); }
function material(color, options = {}) { return new THREE.MeshPhysicalMaterial({ color, roughness: .45, metalness: .05, ...options }); }
function base64Bytes(text) { return Uint8Array.from(atob(text), c => c.charCodeAt(0)); }
function render() {
 if (!renderer || !car) return;
 car.rotation.y = angle;
 seatMaterial.color.set(online ? '#FF8A60' : '#C7BCAF');
 seatMaterial.emissive.set(online ? '#FF503C' : '#000000');
 seatMaterial.emissiveIntensity = online ? .08 + heat * .45 : 0;
 heatMaterial.opacity = online ? heat * .35 : 0;
 rings.forEach((ring, i) => {
  const phase = (elapsed * .4 + i / 3) % 1;
  ring.visible = online && heat > 0;
  ring.position.y = 1.0 + phase * .85;
  ring.scale.setScalar(.85 + phase * .3);
  ring.material.opacity = (1 - phase) * heat * .38;
 });
 renderer.render(scene, camera);
}
function tick(time) {
 frame = 0;
 if (!moving || document.hidden) return;
 const elapsedFrame = (time - (lastTime || time)) / 1000;
 if (lastTime && elapsedFrame < 1 / 30) { frame = requestAnimationFrame(tick); return; }
 const delta = Math.min(elapsedFrame, .05);
 lastTime = time; angle += delta * .17; elapsed += delta;
 render(); frame = requestAnimationFrame(tick);
}
function sync() {
 cancelAnimationFrame(frame); frame = 0; lastTime = 0;
 render();
 if (moving && !document.hidden && car) frame = requestAnimationFrame(tick);
}
window.echoCar = state => {
 moving = state.moving === true; online = state.online === true;
 heat = Number.isFinite(state.heat) ? Math.max(0, Math.min(1, state.heat)) : 0;
 sync();
};
document.addEventListener('visibilitychange', sync);
window.addEventListener('pagehide', () => {
 moving = false; cancelAnimationFrame(frame);
 scene?.traverse(o => { o.geometry?.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); });
 environment?.dispose(); renderer?.dispose();
});
async function start() {
 renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
 renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
 renderer.setClearColor(0x000000, 0);
 renderer.toneMapping = THREE.ACESFilmicToneMapping;
 renderer.toneMappingExposure = 1.05;
 document.body.appendChild(renderer.domElement);
 renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); fail(); });
 scene = new THREE.Scene();
 const room = new RoomEnvironment();
 const pmrem = new THREE.PMREMGenerator(renderer);
 environment = pmrem.fromScene(room, .04); scene.environment = environment.texture;
 room.dispose(); pmrem.dispose();
 scene.add(new THREE.HemisphereLight('#FFFAF3', '#736D66', 1.3));
 const key = new THREE.DirectionalLight('#FFFFFF', 2.2); key.position.set(-3, 5, 4); scene.add(key);
 const rim = new THREE.DirectionalLight('#FFD0B3', 1.8); rim.position.set(4, 2, -3); scene.add(rim);
 camera = new THREE.PerspectiveCamera(33, 1, .1, 50);
 camera.position.set(3.9, 2.8, -4.9); camera.lookAt(0, .65, 0);
 const resize = () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); render(); };
 window.addEventListener('resize', resize); resize();
 const compressed = base64Bytes(document.getElementById('sedan-data').textContent);
 const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
 const model = JSON.parse(await new Response(stream).text());
 seatMaterial = material('#FF8A60', { roughness: .48, sheen: .5, sheenColor: new THREE.Color('#FFE2C9') });
 const materials = {
  bodySolid: material('#EDECE8', { metalness: .24, roughness: .23, clearcoat: 1 }),
  body: material('#EDECE8', { metalness: .24, roughness: .19, clearcoat: 1, transparent: true, opacity: .58, depthWrite: false, side: THREE.FrontSide }),
  glass: material('#B1CAD1', { metalness: .1, roughness: .09, clearcoat: 1, transparent: true, opacity: .18, depthWrite: false, side: THREE.FrontSide }),
  rim: material('#96999A', { metalness: .94, roughness: .23 }),
  tire: material('#252628', { roughness: .86 }),
  seat: material('#CFC4B2', { roughness: .64, sheen: .4 }),
  heatedSeat: seatMaterial,
  interior: material('#44423F', { roughness: .85 }),
  trim: material('#464A4B', { metalness: .65, roughness: .3, transparent: true, opacity: .60, depthWrite: false }),
  screen: material('#172124', { roughness: .16 }),
  lamp: material('#F5F7F2', { emissive: '#FFF7DC', emissiveIntensity: .7, roughness: .12 }),
  tail: material('#C52E3B', { emissive: '#F2334F', emissiveIntensity: .3, roughness: .2 }),
  indicator: material('#FF9A4A', { roughness: .2 }),
 };
 car = new THREE.Group(); scene.add(car);
 for (const part of model.parts) {
  const geometry = new THREE.BufferGeometry();
  const pos = new Int16Array(base64Bytes(part.position).buffer);
  geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos, v => v / 10000), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(base64Bytes(part.normal).buffer), 3, true));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(base64Bytes(part.index).buffer), 1));
  // Separate material groups so translucent surfaces sort after the interior.
  for (const [offset, count, role] of part.groups) {
   const group = geometry.clone(); group.setIndex(new THREE.BufferAttribute(geometry.index.array.slice(offset, offset + count), 1));
   const mesh = new THREE.Mesh(group, materials[role]);
   mesh.renderOrder = role === 'body' ? 2 : role === 'glass' ? 3 : 0;
   car.add(mesh);
  }
  geometry.dispose();
 }
 // Soft contact shadow, locally drawn; no remote lighting maps or textures.
 const shadowCanvas = document.createElement('canvas'); shadowCanvas.width = shadowCanvas.height = 128;
 const ctx = shadowCanvas.getContext('2d');
 const gradient = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
 gradient.addColorStop(0, '#53423344'); gradient.addColorStop(.55, '#53423322'); gradient.addColorStop(1, '#53423300');
 ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
 const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 5.8), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false }));
 shadow.rotation.x = -Math.PI / 2; shadow.position.y = -.03; car.add(shadow);
 heatMaterial = new THREE.MeshBasicMaterial({ color: '#FF6150', transparent: true, opacity: 0, depthWrite: false });
 const glow = new THREE.Mesh(new THREE.SphereGeometry(.42, 16, 12), heatMaterial); glow.position.set(.4, .85, .78); glow.scale.set(.7, 1.1, .8); car.add(glow);
 for (let i = 0; i < 3; i++) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.26, .009, 5, 40), new THREE.MeshBasicMaterial({ color: '#FF6150', transparent: true, depthWrite: false }));
  ring.rotation.x = Math.PI / 2; ring.position.set(.4, 1, .78); car.add(ring); rings.push(ring);
 }
 sync(); send('ready');
}
start().catch(fail);
