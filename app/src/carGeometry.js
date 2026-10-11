// A small local mesh, projected into SVG so the cabin rotates without a GPU dependency.
const faces = [];
function face(vertices, fill, opacity = 1, stroke = '#FFFFFF25') { faces.push({ vertices, fill, opacity, stroke }); }
function box(x, y, z, w, h, d, color) {
  const v = [[x,y,z],[x+w,y,z],[x+w,y+h,z],[x,y+h,z],[x,y,z+d],[x+w,y,z+d],[x+w,y+h,z+d],[x,y+h,z+d]];
  [[0,1,2,3],[4,7,6,5],[0,4,5,1],[3,2,6,7],[0,3,7,4],[1,5,6,2]].forEach((indices,i) => face(indices.map(j=>v[j]),color,1,i===3?'#FFFFFFAA':'#71503730'));
}
// Longitudinal body sections: nose, hood, cabin shoulders, rear deck.
const sections = [[-2.3,.62,.54],[-2.12,.88,.73],[-1.5,.94,.83],[-.9,.96,.85],[.6,.96,.86],[1.55,.89,.78],[2.1,.78,.67],[2.25,.60,.56]];
const ring = ([z,w,h]) => [[-w*.75,.35,z],[-w,.49,z],[-w,h-.06,z],[-w*.75,h,z],[w*.75,h,z],[w,h-.06,z],[w,.49,z],[w*.75,.35,z]];
const rings = sections.map(ring);
for(let i=0;i<rings.length-1;i++) for(let j=0;j<8;j++) face([rings[i][j],rings[i+1][j],rings[i+1][(j+1)%8],rings[i][(j+1)%8]],j===3?'#FFF9F2':'#DCDCD7',.42,'none');
face(rings[0],'#F4EFE7',.65);face(rings.at(-1),'#F4EFE7',.5);
// Floor and seats stay visible through the body and glass.
box(-.7,.40,-1.15,1.4,.08,2.6,'#A6A09A');
for(const z of [-.55,.65]) for(const x of [-.62,.14]) {
 const hot = z>.5 && x>.1; const color = hot?'#FF6150':'#DBD3C6';
 box(x,.55,z,.48,.16,.5,color);box(x,.65,z+.35,.48,.55,.13,color);box(x+.09,1.18,z+.35,.30,.20,.12,color);
}
// Curved panoramic roof, divided into strips for a smooth silhouette.
const roof = [[-1.3,.77,.85],[-.72,.70,1.48],[-.35,.69,1.59],[.58,.69,1.59],[1.14,.74,1.33],[1.6,.81,.80]];
for(let i=0;i<roof.length-1;i++) for(let j=0;j<8;j++) {
 const p=(r,k)=>[r[1]*(k/4-1),r[2]+.07*Math.sin(Math.PI*k/8),r[0]];
 face([p(roof[i],j),p(roof[i+1],j),p(roof[i+1],j+1),p(roof[i],j+1)],'#ABC3C9',.18,'none');
}
for(const side of [-1,1]) {
 for(let i=0;i<roof.length-1;i++) {
  const a=roof[i],b=roof[i+1];
  face([[side*a[1],a[2],a[0]],[side*b[1],b[2],b[0]],[side*.9,.83,b[0]],[side*.9,.83,a[0]]],'#BCCFD0',.12);
 }
 for(const z of [-1.43,1.40]) {
  for(let j=0;j<20;j++) {
   const a=j*Math.PI/10,b=(j+1)*Math.PI/10;
   const p=(x,t,r)=>[x,.38+Math.sin(t)*r,z+Math.cos(t)*r];
   face([p(side*.84,a,.37),p(side*1.04,a,.37),p(side*1.04,b,.37),p(side*.84,b,.37)],'#393632',1,'#393632');
   face([[side*1.045,.38,z],p(side*1.045,a,.27),p(side*1.045,b,.27)],j%2?'#B5B4AF':'#777973',1,'#DCDDD5');
  }
 }
 // Headlamps and taillights.
 face([[side*.35,.68,-2.16],[side*.78,.65,-2.12],[side*.78,.59,-2.16],[side*.35,.62,-2.2]],'#FFF9D9');
 face([[side*.27,.65,2.15],[side*.68,.61,2.14],[side*.68,.55,2.18],[side*.27,.59,2.19]],'#F2334F');
}
export function projectCar(angle) {
 angle = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
 const project=([x,y,z])=>{
  const rx=x*Math.cos(angle)+z*Math.sin(angle), rz=z*Math.cos(angle)-x*Math.sin(angle);
  return {x:180+rx*62,y:145-y*62+rz*23,depth:rz+y*.18};
 };
 return faces.map((f,id)=>{
  const p=f.vertices.map(project);
  return {...f,id,points:p.map(v=>`${v.x.toFixed(2)},${v.y.toFixed(2)}`).join(' '),depth:p.reduce((s,v)=>s+v.depth,0)/p.length};
 }).sort((a,b)=>a.depth-b.depth);
}
export function carMotionAllowed({ online, visible, active, reduced, paused, emergency }) {
 return online && visible && active && !reduced && !paused && !emergency;
}

export function heatRings(angle, phase) {
 return [0,1,2].map(i=>{
  const rise=(phase+i/3)%1;
  const points=Array.from({length:25},(_,j)=>{
   const t=j*Math.PI/12;
   const x=.38+Math.cos(t)*(.25+rise*.12),z=.9+Math.sin(t)*(.3+rise*.12),y=1.2+rise*.7;
   return `${180+(x*Math.cos(angle)+z*Math.sin(angle))*62},${145-y*62+(z*Math.cos(angle)-x*Math.sin(angle))*23}`;
  }).join(' ');
  return {points,opacity:(1-rise)*.65};
 });
}
