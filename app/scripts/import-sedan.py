"""Optimize the credited sedan GLB for Echo's local viewer. Usage: python3 scripts/import-sedan.py source.glb"""
import base64, gzip, hashlib, json, math, struct, sys
from pathlib import Path
source=Path(sys.argv[1]).read_bytes()
length=struct.unpack_from('<I',source,12)[0]
gltf=json.loads(source[20:20+length]); blob=source[28+length:]
def accessor(index):
 a=gltf['accessors'][index]; v=gltf['bufferViews'][a['bufferView']]
 fmt={5126:'f',5125:'I',5123:'H',5121:'B'}[a['componentType']]; n={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
 size=struct.calcsize(fmt)*n; stride=v.get('byteStride',size); offset=v.get('byteOffset',0)+a.get('byteOffset',0)
 return [struct.unpack_from('<'+fmt*n,blob,offset+i*stride) for i in range(a['count'])]
allpos=[p for m in gltf['meshes'] for p in accessor(m['primitives'][0]['attributes']['POSITION'])]
lo=[min(p[i] for p in allpos) for i in range(3)]; hi=[max(p[i] for p in allpos) for i in range(3)]
scale=4.72/(hi[0]-lo[0]); cx=(hi[0]+lo[0])/2; cy=(hi[1]+lo[1])/2
parts=[]
def role(mat,x,y,z):
 if mat==16:return 'tire'
 if mat==12 or (mat==11 and y<.72 and abs(x)>.72):return 'rim'
 if mat in [5,7,8]:return 'glass'
 if mat==13:return 'tail'
 if mat==14:return 'indicator'
 if mat==15 and z< -1.7:return 'lamp'
 if mat==15:return 'heatedSeat' if x>.06 and z>.45 and y>.46 else 'seat'
 if mat==3:return 'seat'
 if mat in [0,1]:return 'screen'
 if mat in [2,6]:return 'interior'
 if mat==10:return 'trim'
 if mat in [9,11]:
  if abs(x)<.69 and -.62<z<1.20 and .45<y<1.22:return 'heatedSeat' if x>.06 and z>.45 else 'seat'
  return 'bodySolid' if z<-.95 or z>1.4 else 'body'
 return 'trim'
def encode(values,fmt):return base64.b64encode(struct.pack('<'+fmt*len(values),*values)).decode()
for m in gltf['meshes']:
 p=m['primitives'][0]; mat=p['material']; raw=accessor(p['attributes']['POSITION']); normals=accessor(p['attributes']['NORMAL']); inds=[v[0] for v in accessor(p['indices'])]
 pos=[(-(y-cy)*scale,(z-lo[2])*scale,-(x-cx)*scale) for x,y,z in raw]
 norm=[(-y,z,-x) for x,y,z in normals]; buckets={}
 for i in range(0,len(inds),3):
  ids=inds[i:i+3]; center=[sum(pos[j][k] for j in ids)/3 for k in range(3)]; r=role(mat,*center);buckets.setdefault(r,[]).extend(ids)
 ordered=[];groups=[]
 for r,indices in buckets.items():groups.append([len(ordered),len(indices),r]);ordered.extend(indices)
 parts.append({'position':encode([round(c*10000) for v in pos for c in v],'h'),'normal':encode([max(-127,min(127,round(c*127))) for v in norm for c in v],'b'),'index':encode(ordered,'I'),'groups':groups})
result={'credit':gltf['asset']['extras'],'sourceSHA256':hashlib.sha256(source).hexdigest(),'parts':parts}
out=Path(__file__).resolve().parents[1]/'assets/models/sedan.json.gz'
out.write_bytes(gzip.compress(json.dumps(result,separators=(',',':')).encode(),mtime=0))
print(f'{len(parts)} meshes, {sum(len(accessor(m["primitives"][0]["indices"])) for m in gltf["meshes"])//3} triangles; {out.stat().st_size:,} bytes')
