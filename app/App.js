import React, { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop } from 'react-native-svg';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { LaunchCover } from './src/LaunchCover';
import { HeatInsights } from './src/HeatInsights';
import { ContactsEditor } from './src/ContactsEditor';
import { CountdownRing, HeatTrace } from './src/HeatMotion';
import { config } from './config';
import { poll, readResource, request } from './src/client';
import { activityRows, activityTime } from './src/activity';
import { DANGER_F, emergencyPhone, heatCurve, lostAlarmCopy, sensorReadings, viewModel } from './src/model';
import { AccentRule, ActionButton, Brand, Halo, Icon, Navigation, Notice, palette, StatusLabel, WarmBackground } from './src/ui';

// Hand off the native loader only after the in-app logo has loaded and laid out.
SplashScreen.preventAutoHideAsync().catch(() => {});

function Chart({ entries, status, online }) {
  const [width, setWidth] = useState(280);
  const curve = heatCurve(entries, status, online, Math.max(1, width - 12), 112);
  const last = curve.points.at(-1);
  const path = curve.points.map((point, i) => `${i ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  return <View style={styles.chartCard}>
    <View style={styles.row}><View style={styles.inline}><Icon name="activity" size={16} color="#FFF5E9" /><Text style={[styles.sectionLabel, styles.onRed]}>CABIN TREND</Text></View><Text style={[styles.small, styles.onRed]}>{DANGER_F}°F danger</Text></View>
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ height: 128, marginTop: 14 }} accessibilityLabel="Recorded cabin temperatures. Dashed forecast uses the box's minutes to danger.">
      <Svg width={width} height={128} viewBox={`-6 -6 ${width} 128`}>
        <Defs><LinearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.18" /><Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" /></LinearGradient></Defs>
        <Line x1={0} x2={width} y1={curve.dangerY} y2={curve.dangerY} stroke="#FFD5A5" strokeWidth={1.25} />
        {last && <><Path d={`${path} L ${last.x} 126 L ${curve.points[0].x} 126 Z`} fill="url(#chartFill)" /><HeatTrace points={curve.points} path={path} /></>}
        {curve.forecast && <><Line x1={curve.forecast.from.x} y1={curve.forecast.from.y} x2={curve.forecast.to.x} y2={curve.forecast.to.y} stroke="#F6F1F2" strokeWidth={2} strokeDasharray="4 5" /><Circle cx={curve.forecast.to.x} cy={curve.forecast.to.y} r={4} fill="#FFD5A5" /></>}
        {last && <><Circle cx={last.x} cy={last.y} r={8} fill="#FFFFFF20" /><Circle cx={last.x} cy={last.y} r={3.5} fill="#FFFFFF" /></>}
      </Svg>
      {!last && <Text style={[styles.chartEmpty, styles.onRed]}>Waiting for temperature history</Text>}
    </View>
    <View style={styles.row}><Text style={[styles.small, styles.onRed]}>Recorded temperatures</Text><Text style={[styles.small, styles.onRed]}>{curve.forecast ? `Box forecast · ${curve.forecast.label}` : 'Latest reading'}</Text></View>
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
    <Brand />
    <View style={styles.pageHeading}><AccentRule /><Text style={styles.title}>Activity</Text><Text style={styles.subtitle}>Every action, with a reason.</Text></View>
    <View style={styles.row}><Text style={styles.sectionLabel}>YOUR TIMELINE</Text><Text style={styles.muted}>{rows.length} records</Text></View>
    {actions.state === 'loading' && <Notice icon="clock">Loading activity…</Notice>}
    {actions.state === 'unavailable' && <Notice icon="offline" title="Updates paused">Showing saved records until the server reconnects.</Notice>}
    {!carConnected && history.length > 0 && <Text style={styles.muted}>Box changes are from the last received history.</Text>}
    {rows.length === 0 && actions.state === 'ready' && <View style={styles.emptyState}><View style={styles.emptyIcon}><Icon name="activity" size={32} color={palette.brand} /></View><Text style={styles.rowTitle}>The story starts here.</Text><Text style={[styles.subtitle, styles.center]}>Calls, notes, and changes at the car will appear as they happen.</Text></View>}
    <View>{rows.map((row, index) => {
      const isBox = row.kind === 'level';
      const isCall = row.title.startsWith('Call');
      const color = isBox ? '#805016' : isCall ? '#3B5271' : palette.brand;
      return <View key={row.id} style={styles.activityRow}>
        <View style={styles.timeline}><View style={[styles.timelineDot, { backgroundColor: color }]} />{index < rows.length - 1 && <View style={styles.timelineLine} />}</View>
        <View style={[styles.activityCard, index === 0 && styles.latestCard]}>
          <View style={styles.row}><View style={styles.inline}><Icon name={isBox ? 'car' : isCall ? 'phone' : 'activity'} size={14} color={color} /><Text style={[styles.sourceLabel, { color }]}>{isBox ? 'BOX' : 'ACTION LOG'}</Text></View><Text style={styles.time}>{activityTime(row.time)}</Text></View>
          <Text style={styles.rowTitle}>{row.title}</Text><Text style={styles.reason}>{row.reason}</Text>
        </View>
      </View>;
    })}</View>
  </>;
}
function Contacts({ resource, locked }) {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState('');
  if (editing && !locked) {
    return <><Brand /><ContactsEditor names={resource.entries.map(contact => contact.name)} onDone={message => { setSaved(message); setEditing(false); }} /></>;
  }
  return <>
    <Brand />
    <View style={styles.pageHeading}><AccentRule /><Text style={styles.title}>Your people.</Text><Text style={styles.subtitle}>Who Echo calls when it matters.</Text></View>
    <View style={styles.row}><Text style={styles.sectionLabel}>BACKUP CALL ORDER</Text><View style={styles.inline}><Icon name="shield" size={13} color={palette.muted} /><Text style={styles.muted}>Fixed order</Text></View></View>
    {resource.state === 'loading' && <Notice icon="clock">Loading contacts…</Notice>}
    {resource.state === 'unavailable' && <Notice icon="offline" title="Updates paused">Showing the last received contact order.</Notice>}
    {resource.state === 'ready' && resource.entries.length === 0 && <Notice icon="contacts" title="Your circle is empty">No contacts have been received from the server.</Notice>}
    <View style={styles.contactList}>{resource.entries.map((contact, index) => <View key={contact.order} style={[styles.contactCard, index === 0 && styles.firstContact]}>
      <View style={styles.row}><Text style={styles.contactOrder}>CONTACT {String(contact.order).padStart(2, '0')}</Text>{index === 0 && <Text style={styles.firstTag}>FIRST IN ORDER</Text>}</View>
      <View style={styles.contactPerson}><View style={[styles.avatar, index > 0 && { backgroundColor: '#3523150C' }]}><Text style={styles.initial}>{Array.from(contact.name.trim())[0]?.toUpperCase() || '?'}</Text></View><Text style={styles.contactName}>{contact.name}</Text><Icon name="phone" color={palette.muted} size={20} /></View>
    </View>)}</View>
    {!!saved && <Notice icon="check" title="Contacts saved">{saved}</Notice>}
    {locked ? <Notice icon="alert" title="Contacts are locked">You can change contacts after the emergency ends.</Notice>
      : <ActionButton secondary icon="contacts" onPress={() => { setSaved(''); setEditing(true); }}>Edit contacts</ActionButton>}
    <Notice icon="shield" title="A dependable backup">The AI agent can call someone sooner than this order, never later.</Notice>
  </>;
}
export default function App() {
  return <SafeAreaProvider><EchoApp /></SafeAreaProvider>;
}
function EchoApp() {
  const insets = useSafeAreaInsets();
  const [fontsLoaded, fontError] = useFonts({ Doto: require('./assets/fonts/Doto.ttf'), Manrope: require('./assets/fonts/manrope.ttf'), Outfit: require('./assets/fonts/outfit.ttf') });
  const [data, setData] = useState({ snapshot: null, entries: [] });
  const [tab, setTab] = useState('Car');
  const [launchDone, setLaunchDone] = useState(false);
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
  const launchVisible = !launchDone && !vm.emergency;
  const emergencyScreen = tab === 'Car' && vm.emergency;
  return <View style={[styles.screen, emergencyScreen && styles.emergency]}>
    {!emergencyScreen && <WarmBackground />}
    <StatusBar barStyle={!emergencyScreen ? 'dark-content' : 'light-content'} />
    <View style={{ flex: 1 }} accessibilityElementsHidden={launchVisible} importantForAccessibility={launchVisible ? 'no-hide-descendants' : 'auto'}>
    {tab !== 'Car' && vm.emergency && <Pressable accessibilityRole="button" onPress={() => setTab('Car')} style={[styles.emergencyBanner, { marginTop: insets.top + 8 }]}>
      <Icon name="alert" color="#FF868D" /><View style={{ flex: 1 }}><Text style={[styles.rowTitle, styles.onRed]}>Emergency at the car</Text><Text style={[styles.small, styles.onRed]}>Go to the car now · View alert</Text></View><Icon name="arrow" color="#FFF5E9" />
    </Pressable>}
    <ScrollView key={tab} showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, { paddingTop: tab !== 'Car' && vm.emergency ? 20 : insets.top + 18 }]}>
      {tab === 'Insights' ? <HeatInsights /> : tab === 'Feed' ? <Activity actions={actions} history={data.entries} carConnected={vm.online} /> : tab === 'Contacts' ? <Contacts resource={contacts} locked={vm.emergency || vm.lostAlarm} /> : <>
        <Brand />
        <View style={styles.row}>
          <View style={{ gap: 5 }}><Text style={vm.emergency ? [styles.sectionLabel, styles.onRed] : styles.title}>{vm.emergency ? 'FAMILY CAR' : 'Family car'}</Text>{!vm.emergency && <Text style={styles.muted}>{vm.heard}</Text>}</View>
          <View style={[styles.carIcon, vm.emergency && { backgroundColor: '#FFFFFF15', borderColor: '#FFFFFF20' }]}><Icon name="car" color={vm.emergency ? '#FFFFFF' : palette.muted} size={22} /></View>
        </View>
        <View style={[styles.hero, vm.emergency && styles.emergencyHero]}>
          {!vm.emergency && <Halo color={vm.color} />}
          <StatusLabel label={vm.online ? status.state : 'BOX OFFLINE'} color={vm.emergency ? '#FFFFFF' : vm.online ? status.state === 'WARNING' || status.state === 'OCCUPANT' ? '#805016' : '#365B7E' : palette.muted} live={vm.online && !vm.emergency} />
          {vm.emergency ? <CountdownRing minutes={status.minsToDanger} /> : <>
            <Text style={styles.metricLabel}>{vm.online ? 'CABIN TEMPERATURE' : 'LAST KNOWN TEMPERATURE'}</Text>
            <View style={[styles.numberRow, !vm.online && { opacity: 0.65 }]}>
              <Text adjustsFontSizeToFit numberOfLines={1} style={styles.number}>{status ? String(status.tempF) : '—'}</Text><Text style={styles.unit}>°F</Text>
            </View>
          </>}
          <View style={styles.inline}><Icon name="seat" size={17} color={vm.emergency ? '#FFFFFF' : palette.muted} /><Text style={[styles.heroCaption, vm.emergency && styles.onRed]}>{vm.emergency ? `${status.tempF}°F${vm.rising ? ' and rising' : ''} · ${status.presence ? 'Seat occupied' : 'Seat empty'}` : `${!vm.online && status ? 'Last known · ' : ''}${seat}`}</Text></View>
          <Text style={[styles.heroDetail, styles.center, vm.emergency && styles.onRed]}>{vm.emergency ? status.minsToDanger === null ? 'No estimate from the box. Go to the car now.' : status.minsToDanger === 0 ? 'At danger level now. Go to the car now.' : 'Go to the car now.'
            : !vm.online ? lastHeard ? `As of ${lastHeard} · may be higher now` : 'Waiting for the box to connect.' : status.state === 'IDLE' ? 'Monitoring the car' : vm.rising ? 'Car is off · temperature is rising' : 'Car is off · monitoring temperature'}</Text>
          {!vm.online && status && <Text style={styles.muted}>Last alert: {status.state}</Text>}
        </View>
        {vm.emergency ? <>
          <Chart entries={data.entries} status={status} online={vm.online} />
          <View style={styles.actions}>
            <ActionButton emergency icon={now < sentUntil ? 'check' : 'arrow'} onPress={acknowledge} disabled={sending || now < sentUntil}>{sending ? 'Sending…' : now < sentUntil ? 'Message logged' : "I'm on my way"}</ActionButton>
            {!!ackNote && <Text accessibilityRole="alert" style={[styles.body, emergencyScreen && styles.onRed]}>{ackNote}</Text>}
            <ActionButton emergency icon="phone" secondary onPress={() => dial(() => emergencyPhone(config))}>{config.demoCalls ? 'Open demo dialer' : 'Call 911'}</ActionButton>
          </View>
        </> : <View style={styles.homeFooter}>
          {vm.online ? <>
            <View style={styles.sensors}>{sensorReadings(status).map((reading, index) => <View key={reading.label} style={[styles.sensor, index > 0 && styles.sensorDivider]}>
              <Icon name="seat" size={18} color={palette.muted} /><Text style={styles.sensorValue}>{reading.value}</Text><Text style={styles.sensorLabel}>{reading.label}</Text>
            </View>)}</View>
            <Notice title="Stay close" icon="shield">If you left the car, go back now. The box sounds its own alarm if the cabin gets hot.</Notice>
          </> : vm.lostAlarm ? <>
            <Notice urgent title={lostAlarmCopy(status, lastHeard).title} icon="alert">{lostAlarmCopy(status, lastHeard).body}</Notice>
            <ActionButton icon="phone" onPress={() => dial(() => emergencyPhone(config))}>{config.demoCalls ? 'Open demo dialer' : 'Call 911'}</ActionButton>
          </> : <>
            <Notice title="Connection lost. Check the car." icon="offline">The box may have lost Wi-Fi. Its own alarm still works at the car.</Notice>
          </>}
          {!!ackNote && <Text accessibilityRole="alert" style={[styles.body, emergencyScreen && styles.onRed]}>{ackNote}</Text>}
        </View>}
        {!!note && <Text accessibilityRole="alert" style={[styles.body, emergencyScreen && styles.onRed]}>{note}</Text>}
        {!config.serverUrl && <Text style={styles.small}>The server connection isn’t configured.</Text>}
        <View style={styles.safetyLine}><Icon name="shield" size={13} color={emergencyScreen ? '#F6F1F2' : palette.muted} /><Text style={[styles.safetyText, emergencyScreen && { color: '#F6F1F2' }]}>Only the button on the box can stop the alarm.</Text></View>
      </>}
    </ScrollView>
    <Navigation tab={tab} onChange={setTab} bottom={insets.bottom} light={!emergencyScreen} />
    </View>
    {!launchDone && <LaunchCover fontsReady={fontsLoaded || !!fontError} emergency={vm.emergency} onFinish={setLaunchDone} />}
  </View>;
}
const styles = StyleSheet.create({
  onRed: { color: '#FFF5E9' },
  screen: { flex: 1, backgroundColor: palette.ground }, emergency: { backgroundColor: '#B62432' },
  content: { flexGrow: 1, paddingHorizontal: 22, paddingBottom: 20, gap: 18, width: '100%', maxWidth: 560, alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, inline: { flexDirection: 'row', alignItems: 'center', gap: 7 }, center: { textAlign: 'center' },
  title: { fontFamily: 'Outfit', fontSize: 32, letterSpacing: -1, color: palette.text }, subtitle: { fontFamily: 'Manrope', fontSize: 14, lineHeight: 22, color: palette.muted },
  body: { fontFamily: 'Manrope', fontSize: 14, lineHeight: 22, color: palette.text }, small: { fontFamily: 'Manrope', fontSize: 10, lineHeight: 16, color: palette.muted }, muted: { fontFamily: 'Manrope', fontSize: 11, lineHeight: 17, color: palette.muted },
  sectionLabel: { fontFamily: 'Outfit', fontSize: 10, letterSpacing: 1.8, color: palette.muted }, pageHeading: { gap: 12, marginTop: 12, marginBottom: 16 },
  carIcon: { width: 44, height: 44, borderRadius: 16, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, justifyContent: 'center', alignItems: 'center' },
  hero: { justifyContent: 'center', alignItems: 'center', flexGrow: 1, minHeight: 295, gap: 10, paddingVertical: 24 }, emergencyHero: { minHeight: 245, flexGrow: 0, paddingVertical: 6, gap: 8 },
  metricLabel: { fontFamily: 'Manrope', fontSize: 9, letterSpacing: 2.2, color: palette.muted, marginTop: 8 },
  numberRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', width: '100%', gap: 7 }, number: { fontFamily: 'Doto', fontSize: 100, letterSpacing: -4, color: palette.text, flexShrink: 1 }, dangerNumber: { fontSize: 115 }, unit: { fontFamily: 'Outfit', fontSize: 24, color: palette.text },
  heroCaption: { fontFamily: 'Outfit', fontSize: 14, color: palette.text, flexShrink: 1, textAlign: 'center' }, heroDetail: { fontFamily: 'Manrope', fontSize: 11, lineHeight: 18, color: palette.muted },
  homeFooter: { gap: 14 }, sensors: { flexDirection: 'row', borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, borderRadius: 22, paddingVertical: 18 }, sensor: { flex: 1, alignItems: 'center', gap: 8, paddingHorizontal: 3 }, sensorDivider: { borderLeftWidth: 1, borderColor: palette.line }, sensorValue: { fontFamily: 'Outfit', fontSize: 18, color: palette.text }, sensorLabel: { fontFamily: 'Manrope', fontSize: 9, color: palette.muted },
  chartCard: { backgroundColor: '#510B1728', borderWidth: 1, borderColor: '#FFFFFF20', borderRadius: 22, padding: 16 }, chartEmpty: { position: 'absolute', top: 56, alignSelf: 'center', fontFamily: 'Manrope', fontSize: 12, color: palette.text }, actions: { gap: 10 },
  safetyLine: { flexDirection: 'row', gap: 6, justifyContent: 'center', alignItems: 'center', paddingTop: 3 }, safetyText: { fontFamily: 'Manrope', fontSize: 9, lineHeight: 15, color: palette.muted, flexShrink: 1 },
  emergencyBanner: { marginHorizontal: 22, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#36131B', borderWidth: 1, borderColor: '#E5202E60', borderRadius: 18, padding: 16 },
  rowTitle: { fontFamily: 'Outfit', color: palette.text, fontSize: 17 }, activityRow: { flexDirection: 'row', gap: 13 }, timeline: { width: 9, alignItems: 'center', paddingTop: 25 }, timelineDot: { width: 7, height: 7, borderRadius: 4 }, timelineLine: { flex: 1, width: 1, backgroundColor: palette.line, marginTop: 9, marginBottom: 2 },
  activityCard: { flex: 1, borderBottomWidth: 1, borderColor: palette.line, paddingVertical: 16, paddingHorizontal: 2, marginBottom: 12, gap: 10 }, latestCard: { borderColor: '#E0306A40' }, sourceLabel: { fontFamily: 'Outfit', fontSize: 9, letterSpacing: 1.1 }, time: { fontFamily: 'Manrope', fontSize: 10, color: palette.muted }, reason: { fontFamily: 'Manrope', fontSize: 12, lineHeight: 19, color: palette.muted },
  emptyState: { alignItems: 'center', paddingVertical: 60, gap: 15 }, emptyIcon: { width: 72, height: 72, borderRadius: 26, backgroundColor: '#FFF3CD40', alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  contactList: { gap: 14, marginBottom: 8 }, contactCard: { backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 24, padding: 20, gap: 22 }, firstContact: { borderColor: '#E0306A40' }, contactOrder: { fontFamily: 'Outfit', fontSize: 10, letterSpacing: 1.5, color: palette.muted }, firstTag: { fontFamily: 'Outfit', fontSize: 8, letterSpacing: 0.8, color: palette.brand },
  contactPerson: { flexDirection: 'row', alignItems: 'center', gap: 14 }, avatar: { width: 50, height: 50, borderRadius: 18, backgroundColor: '#FFF3CD55', alignItems: 'center', justifyContent: 'center' }, initial: { fontFamily: 'Doto', fontSize: 27, color: palette.text }, contactName: { fontFamily: 'Outfit', fontSize: 24, color: palette.text, flex: 1 },
});
