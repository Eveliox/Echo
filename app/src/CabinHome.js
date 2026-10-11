import React, { useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CabinCar } from './CabinCar';
import { AccentRule, Icon, palette } from './ui';
import { dangerEstimate, homeStatus, parentGuidance, seatLabel } from './home';
import { activityRows, activityTime } from './activity';

export function ParentStatus({ vm, lastHeard }) {
 const guidance = parentGuidance(vm);
 return <View style={s.heading}>
  <AccentRule />
  <Text accessibilityRole="header" style={[s.title, vm.emergency && s.onRed]}>{homeStatus(vm)}</Text>
  <Text style={[s.detail, vm.emergency && s.onRed]}>{vm.status ? `${vm.online ? 'Last updated' : 'Last recorded'} · ${lastHeard || 'Time unavailable'}` : 'No readings received yet'}</Text>
  <View accessibilityRole={guidance.urgent ? 'alert' : undefined} style={[s.guidance, guidance.urgent && s.urgent, vm.emergency && s.emergencyGuidance]}>
   <Icon name={guidance.urgent ? 'alert' : 'shield'} size={21} color={vm.emergency ? '#FFF5E9' : guidance.urgent ? '#A53134' : palette.muted} />
   <View style={s.guidanceText}><Text style={[s.guidanceTitle, vm.emergency && s.onRed]}>{guidance.title}</Text><Text style={[s.detail, vm.emergency && s.onRed]}>{guidance.detail}</Text></View>
  </View>
 </View>;
}
// The red Live alert screen shows the estimate in the CountdownRing instead.
export function CabinReadings({ vm, showEstimate = true }) {
 const status = vm.status;
 const estimate = dangerEstimate(vm);
 return <View style={s.readings}>
  <View style={s.metrics}>
   <View style={s.metric}><Text style={s.label}>Cabin temperature</Text><Text numberOfLines={1} adjustsFontSizeToFit style={s.value}>{status?.tempF ?? '—'}<Text style={s.unit}> °F</Text></Text></View>
   <View style={[s.metric, s.seatMetric]}><Text style={s.label}>Seat occupancy</Text><Text style={s.seat}>{seatLabel(status?.presence)}</Text></View>
  </View>
  {showEstimate && <View style={s.estimate}><Icon name="clock" size={17} color={palette.muted} /><Text style={s.estimateLabel}>{estimate.label}</Text><Text style={s.estimateValue}>{estimate.value}</Text></View>}
  {!vm.online && status && <Text style={s.stale}>These readings are out of date. Conditions may have changed.</Text>}
 </View>;
}
export function CabinHome({ vm, visible, onSceneLayout }) {
 const card = useRef(null);
 const scene = useRef(null);
 const report = () => { if (card.current && scene.current) onSceneLayout({ y: card.current.y + scene.current.y, height: scene.current.height }); };
 return <View onLayout={event => { card.current = event.nativeEvent.layout; report(); }} style={s.card}>
  <View style={s.row}><Text style={s.cardTitle}>Your car</Text><View style={[s.connection, !vm.online && s.offline]}><View style={[s.dot, !vm.online && s.offlineDot]} /><Text style={s.connectionText}>{vm.online ? 'Connected' : 'Offline'}</Text></View></View>
  <CabinReadings vm={vm} />
  <CabinCar online={vm.online} visible={visible} emergency={vm.emergency} state={vm.status?.state} onLayout={bounds => { scene.current = bounds; report(); }} />
 </View>;
}
export function LatestActivity({ actions, history, onOpen, emergency = false }) {
 const latest = activityRows(actions.entries, history)[0];
 return <Pressable accessibilityRole="button" accessibilityLabel="Open all activity" onPress={onOpen} style={({ pressed }) => [s.latest, emergency && { backgroundColor: '#F8EAD5' }, pressed && { opacity: .7 }]}>
  <View style={s.row}><Text style={s.cardTitle}>Latest update</Text><View style={s.link}><Text style={s.detail}>View all</Text><Icon name="arrow" size={18} /></View></View>
  <Text style={s.event}>{latest?.title || (actions.state === 'loading' ? 'Loading updates…' : actions.state === 'unavailable' ? 'Updates paused' : 'No activity yet')}</Text>
  <Text style={s.detail}>{latest ? `${activityTime(latest.time)} · ${latest.reason}` : 'Calls and changes at the car will appear here.'}</Text>
  {latest && actions.state === 'unavailable' && <Text style={s.stale}>Saved update · waiting to reconnect</Text>}
 </Pressable>;
}
const s = StyleSheet.create({
 heading: { gap: 8 }, title: { fontFamily: 'Outfit', fontSize: 30, letterSpacing: -.6, color: palette.text }, detail: { fontFamily: 'Manrope', fontSize: 14, lineHeight: 21, color: palette.muted },
 guidance: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, padding: 14, backgroundColor: '#FFF3CD60', borderRadius: 16, marginTop: 4 }, guidanceText: { flex: 1, gap: 4 }, guidanceTitle: { fontFamily: 'Outfit', fontSize: 18, color: palette.text }, urgent: { backgroundColor: '#FF615018', borderLeftWidth: 3, borderColor: '#C94944' }, emergencyGuidance: { backgroundColor: '#FFFFFF12', borderColor: '#FFF5E9' }, onRed: { color: '#FFF5E9' },
 card: { backgroundColor: '#FFF3CD70', borderRadius: 22, padding: 16, gap: 16 }, cardTitle: { fontFamily: 'Outfit', fontSize: 18, color: palette.text }, row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
 connection: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: '#35231506', borderRadius: 20 }, connectionText: { fontFamily: 'Manrope', fontSize: 12, color: palette.muted }, dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#537B60' }, offline: { backgroundColor: '#71503710' }, offlineDot: { backgroundColor: palette.muted },
 readings: { gap: 12 }, metrics: { flexDirection: 'row', gap: 16 }, metric: { flex: 1, gap: 5 }, label: { fontFamily: 'Manrope', fontSize: 13, color: palette.muted }, value: { fontFamily: 'Outfit', fontSize: 42, letterSpacing: -1, color: palette.text }, unit: { fontSize: 18, letterSpacing: 0 }, seatMetric: { borderLeftWidth: 1, borderColor: palette.line, paddingLeft: 16 }, seat: { fontFamily: 'Outfit', fontSize: 23, color: palette.text, paddingTop: 9 },
 estimate: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7, borderTopWidth: 1, borderColor: palette.line, paddingTop: 12 }, estimateLabel: { fontFamily: 'Manrope', fontSize: 12, lineHeight: 18, color: palette.muted, flex: 1, minWidth: 100 }, estimateValue: { fontFamily: 'Outfit', fontSize: 17, color: palette.text }, stale: { fontFamily: 'Manrope', fontSize: 13, lineHeight: 20, color: '#805016' },
 latest: { padding: 16, borderRadius: 18, backgroundColor: palette.raised, gap: 10, minHeight: 100 }, link: { flexDirection: 'row', alignItems: 'center', gap: 6 }, event: { fontFamily: 'Outfit', fontSize: 18, color: palette.text },
});
