import React, { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useFonts } from 'expo-font';
import { config } from './config';
import { poll, readResource, request } from './src/client';
import { activityRows, activityTime } from './src/activity';
import { DANGER_F, emergencyPhone, heatCurve, phoneUrl, sensorReadings, viewModel } from './src/model';

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
function Sensor({ value, label }) {
  return <View style={styles.sensor}><Text style={styles.sensorValue}>{value}</Text><Text style={styles.small}>{label}</Text></View>;
}
function Chart({ entries, status, online }) {
  const [width, setWidth] = useState(280);
  const curve = heatCurve(entries, status, online, width, 125);
  return <View style={styles.chartCard}>
    <Text style={[styles.small, { textAlign: 'right' }]}>{DANGER_F}°F danger</Text>
    <View accessibilityLabel="Cabin temperature history and box-reported forecast" onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ height: 135, marginTop: 8 }}>
      <Line from={{ x: 0, y: curve.dangerY }} to={{ x: width, y: curve.dangerY }} dashed color="#B3A6AB" />
      {curve.points.slice(1).map((point, i) => <Line key={i} from={curve.points[i]} to={point} />)}
      {!!curve.points.length && <View style={{ position: 'absolute', width: 8, height: 8, borderRadius: 4, backgroundColor: '#F6F1F2', left: curve.points.at(-1).x - 4, top: curve.points.at(-1).y - 4 }} />}
      {curve.forecast && <Line from={curve.forecast.from} to={curve.forecast.to} dashed />}
      {!curve.points.length && <Text style={[styles.body, { marginTop: 60 }]}>Waiting for temperature history</Text>}
    </View>
    <View style={styles.row}><Text style={styles.small}>Recent readings</Text><Text style={styles.small}>{curve.forecast?.label ?? 'No forecast'}</Text></View>

  </View>;
}
// Each resource owns its request lifecycle, so an unavailable contacts/feed
// endpoint cannot block status polling or change the car's online indicator.
function useResource(path) {
  const [resource, setResource] = useState({ entries: [], state: 'loading' });
  useEffect(() => {
    let stopped = false;
    let active = AppState.currentState === 'active';
    let busy = false;
    let generation = 0;
    const update = async () => {
      if (stopped || !active || busy) return;
      busy = true;
      const current = generation;
      try {
        const entries = await readResource(config.serverUrl, path);
        if (!stopped && active && generation === current) setResource({ entries, state: 'ready' });
      } catch {
        if (!stopped && generation === current) setResource(previous => ({ ...previous, state: 'unavailable' }));
      } finally { busy = false; }
    };
    const subscription = AppState.addEventListener('change', state => {
      active = state === 'active'; generation++;
      setResource(previous => ({ ...previous, state: 'unavailable' }));
      if (active) update();
    });
    update();
    const timer = setInterval(update, 2000);
    return () => { stopped = true; clearInterval(timer); subscription.remove(); };
  }, [path]);
  return resource;
}
function Activity({ actions, history, carConnected }) {
  const rows = activityRows(actions.entries, history);
  return <>
    <Text style={styles.title}>Activity</Text>
    <Text style={styles.body}>What Echo did, and why.</Text>
    {actions.state === 'loading' && <Text style={styles.small}>Loading activity…</Text>}
    {actions.state === 'unavailable' && <Text style={styles.body}>Activity updates unavailable. Showing saved records.</Text>}
    {!carConnected && history.length > 0 && <Text style={styles.small}>Box changes are from the last received history.</Text>}
    {rows.length === 0 && actions.state === 'ready' && <View style={styles.infoCard}><Text style={styles.body}>No activity yet.</Text><Text style={styles.muted}>Calls, notes, and changes from the box will appear here.</Text></View>}
    <View>{rows.map(row => <View key={row.id} style={styles.activityRow}>
      <View style={styles.timeline}><View style={styles.timelineDot} /><View style={styles.timelineLine} /></View>
      <View style={styles.activityText}>
        <Text style={styles.muted}>{activityTime(row.time)} · {row.kind === 'level' ? 'BOX' : 'ACTION LOG'}</Text>
        <Text style={styles.rowTitle}>{row.title}</Text>
        <Text style={styles.body}>{row.reason}</Text>
      </View>
    </View>)}</View>
  </>;
}
function Contacts({ resource }) {
  return <>
    <Text style={styles.title}>Who Echo calls</Text>
    <Text style={styles.body}>The backup call order is fixed.</Text>
    {resource.state === 'loading' && <Text style={styles.small}>Loading contacts…</Text>}
    {resource.state === 'unavailable' && <Text style={styles.body}>Contact updates unavailable. Showing the last received order.</Text>}
    {resource.state === 'ready' && resource.entries.length === 0 && <Text style={styles.body}>No contacts received from the server.</Text>}
    <View style={styles.contactList}>{resource.entries.map(contact => <View key={contact.order} style={styles.contactRow}>
      <Text style={styles.contactNumber}>{contact.order}</Text><Text style={styles.contactName}>{contact.name}</Text>
    </View>)}</View>
    <View style={styles.infoCard}><Text style={styles.body}>The AI agent can call someone sooner than this order, never later.</Text></View>
  </>;
}
export default function App() {
  const [fonts] = useFonts({ Doto: require('./assets/fonts/Doto.ttf'), Manrope: require('./assets/fonts/manrope.ttf'), Outfit: require('./assets/fonts/outfit.ttf') });
  const [data, setData] = useState({ snapshot: null, entries: [] });
  const [tab, setTab] = useState('Car');
  const actions = useResource('/actions');
  const contacts = useResource('/contacts');
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [ackNote, setAckNote] = useState('');
  const [sentUntil, setSentUntil] = useState(0);
  const acknowledgementBusy = useRef(false);
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
    if (acknowledgementBusy.current || Date.now() < sentUntil) return;
    acknowledgementBusy.current = true;
    setSending(true);
    setAckNote('');
    try {
      await request(config.serverUrl, '/on-my-way', { method: 'POST' });
      setSentUntil(Date.now() + 60_000);
      setAckNote('Your message was logged. The alarm and backup calls continue.');
    } catch (error) { setAckNote(error.message); }
    finally { acknowledgementBusy.current = false; setSending(false); }
  };
  // Network monitoring is never held up by loading decorative fonts.
  const status = vm.status;
  const seat = status ? (status.presence ? 'Someone is in the seat' : 'Seat is empty') : 'Waiting for a seat reading';
  const lastHeard = Number.isFinite(data.snapshot?.lastSeen) ? new Date(data.snapshot.lastSeen).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : null;
  return <View style={[styles.screen, tab === 'Car' && vm.emergency && styles.emergency]}>
    <StatusBar barStyle="light-content" />
    {tab !== 'Car' && vm.emergency && <Pressable accessibilityRole="button" onPress={() => setTab('Car')} style={styles.emergencyBanner}>
      <Text style={styles.rowTitle}>◆ Emergency at the car</Text>
      <Text style={styles.body}>Go to the car now. View alert →</Text>
    </Pressable>}
    <ScrollView key={tab} contentContainerStyle={[styles.content, tab !== 'Car' && vm.emergency && { paddingTop: 24 }]}>
      {tab === 'Feed' ? <Activity actions={actions} history={data.entries} carConnected={vm.online} /> : tab === 'Contacts' ? <Contacts resource={contacts} /> : <>
      <View style={styles.row}>
        <Text style={[vm.emergency ? styles.badge : styles.title, !fonts && { fontFamily: undefined }]}>{vm.emergency ? '◆ EMERGENCY' : 'Family car'}</Text>
        <Text style={styles.small}>{vm.emergency ? 'Family car' : vm.heard}</Text>
      </View>
      <View style={[styles.hero, vm.emergency && styles.emergencyHero]}>
        {!vm.emergency && <View pointerEvents="none" style={[styles.glow, { backgroundColor: vm.color }]} />}
        <Text style={[vm.emergency ? styles.body : styles.badge, { color: vm.emergency ? '#F6F1F2' : vm.color }]}>
          {vm.emergency ? 'Danger in' : vm.online ? `○ ${status.state}` : 'BOX OFFLINE'}
        </Text>
        <View style={[styles.numberRow, !vm.online && { opacity: 0.4 }]}>
          <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.number, vm.emergency && styles.dangerNumber]}>{vm.emergency ? vm.minutes : status ? String(status.tempF) : '—'}</Text>
          <Text style={styles.unit}>{vm.emergency ? 'min' : '°F'}</Text>
        </View>
        <Text style={styles.heroCaption}>{vm.emergency ? `${status.tempF}°F${vm.rising ? ' and rising' : ''} · ${status.presence ? 'Seat occupied' : 'Seat empty'}` : `${!vm.online && status ? 'Last known · ' : ''}${seat}`}</Text>
        <Text style={[styles.body, styles.center]}>
          {vm.emergency ? status.minsToDanger === null ? 'No estimate from the box. Go to the car now.' : status.minsToDanger === 0 ? 'At danger level now. Go to the car now.' : 'Go to the car now.'
            : !vm.online ? lastHeard ? `As of ${lastHeard} · may be higher now` : 'Connect to the hotspot to receive updates.'
            : status.state === 'IDLE' ? 'Monitoring the car' : vm.rising ? 'Car is off · temperature is rising' : 'Car is off · monitoring temperature'}
        </Text>
        {!vm.online && status && <Text style={[styles.small, { opacity: 0.6 }]}>Last alert: {status.state}</Text>}
      </View>
      {vm.emergency ? <>
        <Chart entries={data.entries} status={status} online={vm.online} />
        <View style={styles.actions}>
          <Button onPress={acknowledge} disabled={sending || now < sentUntil}>{sending ? 'Sending…' : now < sentUntil ? 'Message logged' : "I'm on my way"}</Button>
          {!!ackNote && <Text accessibilityRole="alert" style={styles.body}>{ackNote}</Text>}
          <Button secondary onPress={() => dial(() => emergencyPhone(config))}>{config.demoCalls ? 'Open demo dialer' : 'Call 911'}</Button>
        </View>
      </> : <View style={styles.homeFooter}>
        {vm.online ? <>
          <View style={styles.sensors}>
            {sensorReadings(status).map(reading => <Sensor key={reading.label} {...reading} />)}
          </View>
          <Text style={styles.body}>If you left the car, go back now. The box sounds its own alarm if the cabin gets hot.</Text>
        </> : <>
          <View style={styles.offlineInfo}><Text style={styles.body}>The box may have lost Wi-Fi. Its own alarm still works at the car.</Text></View>
          <Button onPress={() => dial(() => phoneUrl(config.momNumber))}>Call Mom</Button>
        </>}
        {!!ackNote && <Text accessibilityRole="alert" style={styles.body}>{ackNote}</Text>}
      </View>}
      {!!note && <Text accessibilityRole="alert" style={styles.body}>{note}</Text>}
      {!config.serverUrl && <Text style={styles.small}>The server connection isn’t configured.</Text>}
      <Text style={[styles.small, styles.center, { marginTop: 4 }]}>Only the button on the box can stop the alarm.</Text>
      </>}
    </ScrollView>
    <View accessibilityRole="tablist" style={styles.navigation}>
      {['Car', 'Feed', 'Contacts'].map(name => <Pressable key={name} accessibilityRole="tab" accessibilityState={{ selected: tab === name }} onPress={() => setTab(name)} style={styles.tab}>
        <View style={[styles.tabIndicator, tab === name && { backgroundColor: '#F6F1F2' }]} />
        <Text style={[styles.tabLabel, tab === name && { color: '#F6F1F2' }]}>{name}</Text>
      </Pressable>)}
    </View>
  </View>;
}
const styles = StyleSheet.create({
  navigation: { flexDirection: 'row', paddingTop: 8, paddingBottom: 24, borderTopWidth: 1, borderColor: '#F6F1F22A', backgroundColor: '#0E0B0D' },
  tab: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 8 },
  tabLabel: { fontFamily: 'Outfit', fontSize: 14, color: '#B3A6AB' },
  tabIndicator: { height: 3, width: 22, borderRadius: 2 },
  emergencyBanner: { marginTop: 62, marginHorizontal: 28, borderColor: '#F6F1F2', borderWidth: 1, borderRadius: 16, padding: 16, gap: 8 },
  infoCard: { backgroundColor: '#1A1517', borderRadius: 18, padding: 20, gap: 10 },
  muted: { fontFamily: 'Manrope', color: '#B3A6AB', fontSize: 12, lineHeight: 19 },
  rowTitle: { fontFamily: 'Outfit', color: '#F6F1F2', fontSize: 17 },
  activityRow: { flexDirection: 'row', gap: 16 },
  activityText: { flex: 1, paddingBottom: 28, gap: 7 },
  timeline: { width: 12, alignItems: 'center', paddingTop: 5 },
  timelineDot: { height: 8, width: 8, borderRadius: 4, backgroundColor: '#B3A6AB' },
  timelineLine: { width: 1, flex: 1, backgroundColor: '#F6F1F22A', marginTop: 8, marginBottom: 5 },
  contactList: { gap: 12, marginVertical: 10 },
  contactRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1A1517', borderRadius: 18, padding: 22, gap: 22 },
  contactNumber: { fontFamily: 'Doto', fontSize: 32, color: '#B3A6AB' },
  contactName: { fontFamily: 'Manrope', fontSize: 19, color: '#F6F1F2', flexShrink: 1 },
  screen: { flex: 1, backgroundColor: '#0E0B0D' }, emergency: { backgroundColor: '#E5202E' },
  content: { flexGrow: 1, paddingHorizontal: 28, paddingTop: 62, paddingBottom: 36, gap: 18, width: '100%', maxWidth: 520, alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { fontFamily: 'Doto', fontSize: 27, color: '#F6F1F2' },
  body: { fontFamily: 'Manrope', fontSize: 14, lineHeight: 22, color: '#F6F1F2' },
  small: { fontFamily: 'Manrope', fontSize: 11, lineHeight: 17, color: '#D6CDD0' },
  badge: { fontFamily: 'Outfit', fontSize: 13, letterSpacing: 1.8, color: '#F6F1F2' },
  hero: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', minHeight: 340, paddingVertical: 30, gap: 12 },
  emergencyHero: { minHeight: 265, flexGrow: 0, paddingTop: 22, paddingBottom: 12, gap: 8 },
  glow: { position: 'absolute', height: 220, width: 220, borderRadius: 110, opacity: 0.09 },
  numberRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', width: '100%', gap: 6 },
  number: { fontFamily: 'Doto', color: '#F6F1F2', fontSize: 110, flexShrink: 1, textAlign: 'center' },
  dangerNumber: { fontSize: 132 },
  unit: { fontFamily: 'Outfit', fontSize: 24, color: '#F6F1F2' },
  heroCaption: { fontFamily: 'Outfit', fontSize: 16, color: '#F6F1F2', textAlign: 'center' },
  center: { textAlign: 'center' },
  homeFooter: { gap: 20, marginBottom: 4 },
  sensors: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#F6F1F22A', paddingVertical: 18 },
  sensor: { flex: 1, gap: 4 },
  sensorValue: { fontFamily: 'Doto', color: '#F6F1F2', fontSize: 19 },
  offlineInfo: { borderTopWidth: 1, borderColor: '#F6F1F22A', paddingTop: 20 },
  chartCard: { paddingTop: 4, paddingBottom: 14, borderBottomWidth: 1, borderColor: '#F6F1F24A' },
  actions: { gap: 10 },
  button: { minHeight: 60, borderRadius: 16, backgroundColor: '#F6F1F2', padding: 16, alignItems: 'center', justifyContent: 'center' },
  secondary: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: '#F6F1F2' },
  buttonText: { fontFamily: 'Outfit', fontSize: 18, color: '#0E0B0D' },
});
