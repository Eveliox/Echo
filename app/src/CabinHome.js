import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CabinCar } from './CabinCar';
import { AccentRule, Icon, palette } from './ui';
import { homeStatus } from './home';
import { activityRows, activityTime } from './activity';

export function CabinHome({ vm, lastHeard, visible, onLayout }) {
 const status=vm.status;
 return <View onLayout={onLayout} style={s.wrap}>
  <View style={s.heading}><AccentRule/><Text accessibilityRole="header" accessibilityLiveRegion="polite" style={s.title}>{homeStatus(vm)}</Text><Text style={s.detail}>{status?`${vm.online?'Updated':'Last recorded'} · ${lastHeard || 'time unavailable'}`:'Your cabin view will appear when the box connects.'}</Text></View>
  <View style={s.card}>
   <View style={s.row}><Text style={s.label}>FAMILY CAR / CABIN</Text><Text style={s.detail}>{vm.online?'● Live':'○ Offline'}</Text></View>
   <View style={s.metrics}>
    <View style={s.metric}><Text style={s.label}>TEMPERATURE</Text><Text numberOfLines={1} adjustsFontSizeToFit style={s.value}>{status?.tempF ?? '—'}<Text style={s.unit}> °F</Text></Text></View>
    <View style={s.metric}><Text style={s.label}>SEAT</Text><Text numberOfLines={1} adjustsFontSizeToFit style={s.seat}>{status?.presence == null?'Unknown':status.presence?'Occupied':'Empty'}</Text></View>
    <View style={s.metric}><Text style={s.label}>TO DANGER</Text><Text numberOfLines={1} adjustsFontSizeToFit style={s.value}>{status?.minsToDanger ?? '—'}<Text style={s.unit}> min</Text></Text></View>
   </View>
   {!vm.online && status && <Text style={s.stale}>Last recorded values · may have changed</Text>}
   <CabinCar online={vm.online} visible={visible} emergency={vm.emergency} state={status?.state}/>
   <Text style={s.detail}>Cabin illustration · estimate reported by the box</Text>
  </View>
 </View>;
}
export function LatestActivity({actions,history,onOpen}) {
 const latest=activityRows(actions.entries,history)[0];
 return <Pressable accessibilityRole="button" accessibilityLabel="Open full activity timeline" onPress={onOpen} style={({pressed})=>[s.latest,pressed&&{opacity:.7}]}>
  <View style={s.row}><Text style={s.label}>LATEST ACTIVITY</Text><View style={s.link}><Text style={s.detail}>View all</Text><Icon name="arrow" size={16}/></View></View>
  <Text style={s.event}>{latest?.title || (actions.state==='loading'?'Loading activity…':actions.state==='unavailable'?'Activity updates paused':'No activity yet')}</Text>
  <Text numberOfLines={2} style={s.detail}>{latest?`${activityTime(latest.time)} · ${latest.reason}`:'Calls, notes, and changes at the car will appear here.'}</Text>
  {latest && actions.state==='unavailable' && <Text style={s.stale}>Saved activity · updates paused</Text>}
 </Pressable>;
}
const s=StyleSheet.create({wrap:{gap:14},heading:{gap:7},title:{fontFamily:'Outfit',fontSize:30,letterSpacing:-.8,color:palette.text},detail:{fontFamily:'Manrope',fontSize:12,lineHeight:18,color:palette.muted},card:{backgroundColor:'#FFF3CD70',borderRadius:20,padding:16,gap:10},row:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',gap:8},label:{fontFamily:'Manrope',fontSize:10,letterSpacing:.7,color:palette.muted},metrics:{flexDirection:'row',gap:6,marginTop:6},metric:{flex:1,gap:7},value:{fontFamily:'Outfit',fontSize:27,letterSpacing:-1,color:palette.text},unit:{fontSize:12,letterSpacing:0},seat:{fontFamily:'Outfit',fontSize:19,color:palette.text,paddingTop:7},stale:{fontFamily:'Manrope',fontSize:12,color:'#805016'},latest:{padding:16,borderRadius:18,backgroundColor:palette.raised,gap:9,minHeight:100},link:{flexDirection:'row',alignItems:'center',gap:6},event:{fontFamily:'Outfit',fontSize:18,color:palette.text}});
