import React, { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, Ellipse, LinearGradient, Polygon, Polyline, Stop } from 'react-native-svg';
import { useReducedMotion } from './HeatMotion';
import { carMotionAllowed, projectCar, heatRings } from './carGeometry';
import { palette } from './ui';

export function CabinCar({ online, visible, emergency, state }) {
 const reduced=useReducedMotion();
 const [active,setActive]=useState(AppState.currentState==='active');
 const [paused,setPaused]=useState(false);
 const [angle,setAngle]=useState(-.65);
 useEffect(()=>{const s=AppState.addEventListener('change',v=>setActive(v==='active'));return ()=>s.remove();},[]);
 const moving=carMotionAllowed({online,visible,active,reduced,paused,emergency});
 useEffect(()=>{
  if(!moving)return;
  const timer=setInterval(()=>setAngle(a=>(a+.009)%(Math.PI*2)),50);
  return ()=>clearInterval(timer);
 },[moving]);
 return <View style={s.scene}>
  <Svg width="100%" height={190} viewBox="0 0 360 195" accessible accessibilityLabel="Rotating transparent car illustration with a highlighted rear seat. Illustration, not a seat location reading.">
   <Defs><LinearGradient id="carStage"><Stop offset="0" stopColor="#FF9A4A" stopOpacity=".12"/><Stop offset="1" stopColor="#E0306A" stopOpacity=".12"/></LinearGradient></Defs>
   <Ellipse cx="180" cy="162" rx="153" ry="31" fill="url(#carStage)"/>
   {projectCar(angle).map(f=><Polygon key={f.id} points={f.points} fill={f.fill} fillOpacity={f.opacity} stroke={f.stroke} strokeWidth=".45" strokeLinejoin="round"/>)}
   {online && ['OCCUPANT','WARNING','EMERGENCY'].includes(state) && heatRings(angle,((angle+7)*2)%1).map((ring,i)=><Polyline key={`heat-${i}`} points={ring.points} stroke="#FF6150" strokeWidth={state==='OCCUPANT'?1:2} strokeOpacity={ring.opacity*(state==='OCCUPANT'?.4:1)} fill="none"/>)}
  </Svg>
  <Pressable accessibilityRole="button" accessibilityLabel={paused?'Resume car rotation':'Pause car rotation'} disabled={!online || reduced || emergency} onPress={()=>setPaused(p=>!p)} style={({pressed})=>[s.control,pressed&&{opacity:.6}]}><Text style={s.caption}>{moving?'Ⅱ Pause rotation':!online?'Paused · no live readings':reduced?'Still view · reduced motion':emergency?'Still view · emergency': '▷ Resume rotation'}</Text></Pressable>
 </View>;
}
const s=StyleSheet.create({scene:{width:'100%',alignItems:'center'},control:{minHeight:44,justifyContent:'center',paddingHorizontal:18},caption:{fontFamily:'Manrope',fontSize:11,color:palette.muted}});
