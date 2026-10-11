import React, { useMemo, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop } from 'react-native-svg';
import { heatCurve, DANGER_F } from './model';
import { closestReading } from './home';
import { palette } from './ui';

export function Chart({ entries, status, online }) {
 const [width,setWidth]=useState(260);
 const [selectedTime,setSelectedTime]=useState(null);
 const curve=heatCurve(entries,status,online,Math.max(1,width-12),112);
 const samples=curve.samples || [];
 const selected=samples.find(p=>p.time===selectedTime);
 const inspect=x=>setSelectedTime(closestReading(samples,x-6)?.time ?? null);
 const responder=useMemo(()=>PanResponder.create({
  onStartShouldSetPanResponder:()=>false,
  onMoveShouldSetPanResponder:(_,g)=>Math.abs(g.dx)>6 && Math.abs(g.dx)>Math.abs(g.dy),
  onPanResponderGrant:e=>inspect(e.nativeEvent.locationX),
  onPanResponderMove:e=>inspect(e.nativeEvent.locationX),
  onPanResponderTerminationRequest:()=>true,
 // Recreate handlers when recorded data changes so gestures never inspect stale points.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }),[entries,status,online,width]);
 const path=curve.points.map((p,i)=>`${i?'L':'M'} ${p.x} ${p.y}`).join(' ');
 return <View style={s.card}>
  <View style={s.row}><Text style={s.title}>Cabin trend</Text><Text style={s.small}>°F / RECORDED</Text></View>
  <Text accessibilityLiveRegion="polite" style={s.tooltip}>{selected?`${selected.tempF} °F · ${new Date(selected.time).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'})}`:samples.length?online?'Drag to inspect a reading':'Updates paused · recorded readings':'Waiting for temperature history'}</Text>
  <View style={s.plot}>
   <View style={s.axis}>{(curve.ticks || []).map((v,i)=><Text key={i} style={s.small}>{Math.round(v*10)/10}°</Text>)}</View>
   <View style={s.graph} onLayout={e=>setWidth(e.nativeEvent.layout.width)} {...responder.panHandlers} onTouchEnd={e=>inspect(e.nativeEvent.locationX)} accessible accessibilityRole="adjustable" accessibilityLabel={selected?`${selected.tempF} degrees Fahrenheit at ${new Date(selected.time).toLocaleString()}`:'Recorded cabin temperatures'} accessibilityActions={[{name:'increment',label:'Next reading'},{name:'decrement',label:'Previous reading'}]} onAccessibilityAction={e=>{const i=samples.findIndex(p=>p.time===selectedTime);const next=e.nativeEvent.actionName==='increment'?Math.min(samples.length-1,i+1):Math.max(0,(i<0?samples.length:i)-1);setSelectedTime(samples[next]?.time ?? null);}}>
    <Svg width={width} height={128} viewBox={`-6 -6 ${width} 128`} pointerEvents="none">
     <Defs><LinearGradient id="recordedHeat"><Stop offset="0" stopColor="#FF9A4A"/><Stop offset=".5" stopColor="#FF6150"/><Stop offset="1" stopColor="#E0306A"/></LinearGradient></Defs>
     {[0,56,112].map(y=><Line key={y} x1="0" x2={width-12} y1={y} y2={y} stroke={palette.line}/>)}
     {!!samples.length && <Line x1="0" x2={width-12} y1={curve.dangerY} y2={curve.dangerY} stroke={palette.muted} strokeDasharray="3 5"/>}
     <Path d={path} fill="none" stroke="url(#recordedHeat)" strokeWidth="2.5"/>
     {curve.forecast && <Line x1={curve.forecast.from.x} y1={curve.forecast.from.y} x2={curve.forecast.to.x} y2={curve.forecast.to.y} stroke={palette.muted} strokeDasharray="4 5"/>}
     {selected && <><Line x1={selected.x} x2={selected.x} y1="0" y2="112" stroke={palette.muted} strokeDasharray="2 4"/><Circle cx={selected.x} cy={selected.y} r="4" fill="#E0306A"/></>}
    </Svg>
   </View>
  </View>
  <View style={s.row}><Text style={s.small}>{samples.length?`${DANGER_F} °F danger`:'Your history will build here.'}</Text><Text style={s.small}>{curve.forecast?`Box forecast ${curve.forecast.label}`:''}</Text></View>
 </View>;
}
const s=StyleSheet.create({card:{backgroundColor:'#F8EAD5',borderRadius:20,padding:16,gap:12},row:{flexDirection:'row',justifyContent:'space-between',gap:8},title:{fontFamily:'Outfit',fontSize:17,color:palette.text},small:{fontFamily:'Manrope',fontSize:10,color:palette.muted},tooltip:{fontFamily:'Manrope',fontSize:12,color:palette.text,minHeight:20},plot:{flexDirection:'row',gap:5},axis:{width:39,height:128,justifyContent:'space-between',paddingVertical:3},graph:{flex:1,height:128}});
