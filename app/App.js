import React, { useEffect, useState } from 'react';
import { AppState, Linking, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useFonts } from 'expo-font';
import { config } from './config';
import { poll, request } from './src/client';
import { DANGER_F, emergencyCopy, emergencyPhone, heatCurve, phoneUrl, viewModel } from './src/model';

function Button({ children, onPress, secondary = false, disabled = false }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.secondary, (disabled || pressed) && { opacity: 0.55 }]}><Text style={[styles.buttonText, secondary && { color: '#F6F1F2' }]}>{children}</Text></Pressable>;
}
function Line({ from, to, dashed = false, color = '#F6F1F2' }) {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const segments = dashed ? Math.ceil(length / 12) : 1;
  return Array.from({ length: segments }, (_, i) => {
    const offset = dashed ? i * 12 : 0;
    const size = dashed ? Math.min(6, length - offset) : length;
    return <View key={i} style={{ position: 'absolute', height: 2, width: size, backgroundColor: color, left: from.x + Math.cos(angle) * (offset + size / 2) - size / 2, top: from.y + Math.sin(angle) * (offset + size / 2), transform: [{ rotate: `${angle}rad` }] }} />;
  });
}
function Chart({ entries, status, online }) {
  const [width, setWidth] = useState(280);
  const curve = heatCurve(entries, status, online, width, 125);
  return <View style={styles.chartCard}>
    <Text style={styles.label}>CABIN HEAT</Text>
    <Text style={styles.body}>{DANGER_F}°F danger level</Text>
    <View accessibilityLabel="Cabin temperature history and box-reported forecast" onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ height: 145, marginTop: 16 }}>
      <Line from={{ x: 0, y: curve.dangerY }} to={{ x: width, y: curve.dangerY }} dashed color="#B3A6AB" />
      {curve.points.slice(1).map((point, i) => <Line key={i} from={curve.points[i]} to={point} />)}
      {curve.forecast && <Line from={curve.forecast.from} to={curve.forecast.to} dashed />}
      {!curve.points.length && <Text style={[styles.body, { marginTop: 60 }]}>Waiting for temperature history</Text>}
    </View>
    <View style={styles.row}><Text style={styles.small}>Recent readings</Text><Text style={styles.small}>{curve.forecast?.label ?? 'No forecast'}</Text></View>
    <Text style={[styles.small, { marginTop: 10 }]}>Dashed forecast uses the box’s minutes to danger.</Text>
  </View>;
}
export default function App() {
  const [fonts] = useFonts({ Doto: require('./assets/fonts/Doto.ttf'), Manrope: require('./assets/fonts/manrope.ttf'), Outfit: require('./assets/fonts/outfit.ttf') });
  const [data, setData] = useState({ snapshot: null, entries: [] });
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let stopped = false;
    let generation = 0;
    let active = AppState.currentState === 'active';
    let busy = false;
    const update = async () => {
      if (!active || busy || stopped) return;
      busy = true;
      const current = generation;
      try {
        const next = await poll(config.serverUrl);
        if (!stopped && active && current === generation) { setData(next); setConnected(true); }
      } catch { if (!stopped && current === generation) setConnected(false); }
      finally { busy = false; }
    };
    const subscription = AppState.addEventListener('change', state => {
      active = state === 'active'; generation++; setConnected(false); setNow(Date.now());
      if (active) update();
    });
    update();
    const timer = setInterval(() => { setNow(Date.now()); update(); }, 2000);
    return () => { stopped = true; clearInterval(timer); subscription.remove(); };
  }, []);
  const vm = viewModel(data.snapshot, connected, now, data.receivedAt);
  const dial = async number => {
    try { await Linking.openURL(number()); }
    catch (error) { setNote(error.message || 'Could not open the phone dialer.'); }
  };
  const acknowledge = async () => {
    setSending(true);
    try { await request(config.serverUrl, '/on-my-way', { method: 'POST' }); setNote('Your message was logged. The alarm and backup calls continue.'); }
    catch (error) { setNote(error.message); }
    finally { setSending(false); }
  };
  // Network monitoring is never held up by loading decorative fonts.
  const status = vm.status;
  return <View style={[styles.screen, vm.emergency && styles.emergency]}>
    <StatusBar barStyle="light-content" />
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.row}><Text style={[styles.brand, !fonts && { fontFamily: undefined }]}>echo</Text><Text style={styles.small}>YOUR CAR, CONNECTED</Text></View>
      <Text style={styles.title}>{vm.emergency ? 'Someone needs you.' : 'Your car'}</Text>
      <View style={styles.row}><Text style={[styles.badge, { color: vm.emergency ? '#F6F1F2' : vm.color }]}>{vm.online ? status.state : 'OFFLINE'}</Text><Text style={styles.small}>{vm.heard}</Text></View>
      {!vm.online && <View style={styles.offlineBanner}><Text style={styles.body}>Connection lost. Check the car.</Text><Text style={styles.small}>{status ? 'Last known temperature — may be higher now.' : 'No reading yet. Connect to the hotspot to receive updates.'}</Text></View>}
      {vm.emergency && <Text style={styles.body}>{emergencyCopy(status)}</Text>}
      <View style={[styles.carCard, vm.emergency && { backgroundColor: '#FFFFFF12' }]}>
        <Text style={styles.label}>{vm.emergency ? 'MINUTES TO DANGER' : 'CABIN TEMPERATURE'}</Text>
        {!vm.online && status && <Text style={[styles.small, { opacity: 0.5 }]}>Last alert: {status.state}</Text>}
        <View style={[styles.glow, { backgroundColor: vm.color, opacity: 0.10 }]} />
        <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.number, !vm.online && { opacity: 0.45 }]}>{vm.emergency ? vm.minutes : vm.temperature}</Text>
        <Text style={[styles.body, { textAlign: 'center' }]}>{vm.emergency ? (status.minsToDanger === null ? 'No estimate from the box' : status.minsToDanger === 0 ? 'At danger level now' : 'As reported by the box') : 'degrees Fahrenheit'}</Text>
        <View style={[styles.row, { marginTop: 24, opacity: vm.online ? 1 : 0.5 }]}><Text style={styles.body}>{status ? (status.presence ? '● Seat occupied' : '○ Seat empty') : 'Seat unknown'}</Text><Text style={styles.body}>Battery {status?.battery == null ? '—' : `${status.battery}%`}</Text></View>
        {vm.emergency && <Text style={[styles.body, { marginTop: 12 }]}>{status.tempF}°F{vm.rising ? ' and rising' : ''}</Text>}
      </View>
      {(vm.emergency || data.entries.length > 0) && <View style={!vm.online && { opacity: 0.5 }}><Chart entries={data.entries} status={status} online={vm.online} /></View>}
      {vm.emergency && <><Button onPress={acknowledge} disabled={sending}>{sending ? 'Sending…' : "I'm on my way"}</Button><Button secondary onPress={() => dial(() => emergencyPhone(config))}>{config.demoCalls ? 'Open demo dialer' : 'Call 911'}</Button></>}
      {!vm.online && <Button secondary onPress={() => dial(() => phoneUrl(config.momNumber))}>Call Mom</Button>}
      {!!note && <Text accessibilityRole="alert" style={styles.body}>{note}</Text>}
      {!config.serverUrl && <Text style={styles.small}>The server connection isn’t configured.</Text>}
      <Text style={[styles.small, { textAlign: 'center', marginTop: 10 }]}>Only the button on the box can stop the alarm.</Text>
    </ScrollView>
  </View>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0E0B0D' }, emergency: { backgroundColor: '#E5202E' },
  content: { paddingHorizontal: 24, paddingTop: 64, paddingBottom: 44, gap: 18, width: '100%', maxWidth: 520, alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  brand: { fontFamily: 'Doto', fontSize: 32, color: '#F6F1F2' },
  title: { fontFamily: 'Doto', fontSize: 34, color: '#F6F1F2', marginTop: 14 },
  body: { fontFamily: 'Manrope', fontSize: 15, lineHeight: 23, color: '#F6F1F2' },
  small: { fontFamily: 'Manrope', fontSize: 12, lineHeight: 19, color: '#D6CDD0' },
  label: { fontFamily: 'Manrope', fontSize: 11, letterSpacing: 1.7, color: '#B3A6AB' },
  badge: { fontFamily: 'Outfit', fontSize: 14, letterSpacing: 1.5 },
  carCard: { backgroundColor: '#1A1517', padding: 22, borderRadius: 24, overflow: 'hidden' },
  glow: { position: 'absolute', height: 190, width: 190, borderRadius: 100, alignSelf: 'center', top: 20 },
  number: { fontFamily: 'Doto', color: '#F6F1F2', fontSize: 86, textAlign: 'center', marginTop: 14 },
  offlineBanner: { borderLeftWidth: 3, borderColor: '#6E6468', paddingLeft: 14, gap: 5 },
  chartCard: { padding: 18, borderRadius: 20, backgroundColor: '#1A1517' },
  button: { minHeight: 58, borderRadius: 18, backgroundColor: '#F6F1F2', padding: 16, alignItems: 'center', justifyContent: 'center' },
  secondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#F6F1F280' },
  buttonText: { fontFamily: 'Outfit', fontSize: 18, color: '#0E0B0D' },
});
