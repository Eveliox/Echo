import React, { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, ScrollView, StatusBar, StyleSheet, Text, Vibration, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { LaunchCover } from './src/LaunchCover';
import { HeatInsights } from './src/HeatInsights';
import { ContactsEditor } from './src/ContactsEditor';
import { CabinHome, CabinReadings, LatestActivity, ParentStatus } from './src/CabinHome';
import { Chart } from './src/Chart';
import { CountdownRing } from './src/HeatMotion';
import { alertVibration, sceneVisible } from './src/home';
import { config } from './config';
import { poll, readResource, request } from './src/client';
import { activityRows, activityTime } from './src/activity';
import { emergencyPhone, viewModel } from './src/model';
import { AccentRule, ActionButton, Brand, Icon, Navigation, Notice, palette, WarmBackground } from './src/ui';

// Hand off the native loader only after the in-app logo has loaded and laid out.
SplashScreen.preventAutoHideAsync().catch(() => {});

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
    <View style={styles.pageHeading}><AccentRule /><Text style={styles.title}>Activity</Text><Text style={styles.subtitle}>Calls and updates from your car.</Text></View>
    <View style={styles.row}><Text style={styles.sectionLabel}>YOUR TIMELINE</Text><Text style={styles.muted}>{rows.length} records</Text></View>
    {actions.state === 'loading' && <Notice icon="clock">Loading activity…</Notice>}
    {actions.state === 'unavailable' && <Notice icon="offline" title="Updates paused">Showing saved records until Echo reconnects.</Notice>}
    {!carConnected && history.length > 0 && <Text style={styles.muted}>Box changes are from the last received history.</Text>}
    {rows.length === 0 && actions.state === 'ready' && <View style={styles.emptyState}><View style={styles.emptyIcon}><Icon name="activity" size={32} color={palette.brand} /></View><Text style={styles.rowTitle}>The story starts here.</Text><Text style={[styles.subtitle, styles.center]}>Calls, notes, and changes at the car will appear as they happen.</Text></View>}
    <View>{rows.map((row, index) => {
      const isBox = row.kind === 'level';
      const isCall = row.title.startsWith('Call');
      const color = isBox ? '#805016' : isCall ? '#3B5271' : palette.brand;
      return <View key={row.id} style={styles.activityRow}>
        <View style={styles.timeline}><View style={[styles.timelineDot, { backgroundColor: color }]} />{index < rows.length - 1 && <View style={styles.timelineLine} />}</View>
        <View style={[styles.activityCard, index === 0 && styles.latestCard]}>
          <View style={styles.row}><View style={styles.inline}><Icon name={isBox ? 'car' : isCall ? 'phone' : 'activity'} size={14} color={color} /><Text style={[styles.sourceLabel, { color }]}>{isBox ? 'CAR SENSOR' : 'ECHO'}</Text></View><Text style={styles.time}>{activityTime(row.time)}</Text></View>
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
    {resource.state === 'ready' && resource.entries.length === 0 && <Notice icon="contacts" title="Your circle is empty">Your emergency contact list will appear here once Echo connects.</Notice>}
    <View style={styles.contactList}>{resource.entries.map((contact, index) => <View key={contact.order} style={[styles.contactCard, index === 0 && styles.firstContact]}>
      <View style={styles.row}><Text style={styles.contactOrder}>CONTACT {String(contact.order).padStart(2, '0')}</Text>{index === 0 && <Text style={styles.firstTag}>FIRST IN ORDER</Text>}</View>
      <View style={styles.contactPerson}><View style={[styles.avatar, index > 0 && { backgroundColor: '#3523150C' }]}><Text style={styles.initial}>{Array.from(contact.name.trim())[0]?.toUpperCase() || '?'}</Text></View><Text style={styles.contactName}>{contact.name}</Text><Icon name="phone" color={palette.muted} size={20} /></View>
    </View>)}</View>
    {!!saved && <Notice icon="check" title="Contacts saved">{saved}</Notice>}
    {locked ? <Notice icon="alert" title="Contacts are locked">You can change contacts after the emergency ends.</Notice>
      : <ActionButton secondary icon="contacts" onPress={() => { setSaved(''); setEditing(true); }}>Edit contacts</ActionButton>}
    <Notice icon="shield" title="A dependable backup">Echo uses this order for backup calls when an emergency needs attention.</Notice>
  </>;
}
export default function App() {
  return <SafeAreaProvider><EchoApp /></SafeAreaProvider>;
}
function EchoApp() {
  const insets = useSafeAreaInsets();
  const [fontsLoaded, fontError] = useFonts({ Doto: require('./assets/fonts/Doto.ttf'), Manrope: require('./assets/fonts/manrope.ttf'), Outfit: require('./assets/fonts/outfit.ttf') });
  const [data, setData] = useState({ snapshot: null, entries: [] });
  const [tab, setTabState] = useState('Car');
  const [carVisible, setCarVisible] = useState(true);
  const [showChart, setShowChart] = useState(false);
  const setTab = name => { viewport.current.offset = 0; setCarVisible(true); setTabState(name); };
  const carBounds = useRef({ y: 0, height: 600 });
  const viewport = useRef({ offset: 0, height: 1000 });
  const [launchDone, setLaunchDone] = useState(false);
  const actions = useResource('/actions');
  const contacts = useResource('/contacts');
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
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
  const wasEmergency = useRef(false);
  useEffect(() => {
    const pattern = alertVibration(wasEmergency.current, vm.emergency);
    if (pattern) Vibration.vibrate(pattern);
    wasEmergency.current = vm.emergency;
  }, [vm.emergency]);
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
    <ScrollView key={tab} scrollEventThrottle={100} onScroll={event => { const { contentOffset, layoutMeasurement } = event.nativeEvent; viewport.current = { offset: contentOffset.y, height: layoutMeasurement.height }; setCarVisible(sceneVisible(carBounds.current, contentOffset.y, layoutMeasurement.height)); }} showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, { paddingTop: tab !== 'Car' && vm.emergency ? 20 : insets.top + 18 }]}>
      {tab === 'Insights' ? <HeatInsights /> : tab === 'Feed' ? <Activity actions={actions} history={data.entries} carConnected={vm.online} /> : tab === 'Contacts' ? <Contacts resource={contacts} locked={vm.emergency || vm.lostAlarm} /> : <>
        <View style={vm.emergency ? styles.emergencyBrand : undefined}><Brand /></View>
        <ParentStatus vm={vm} lastHeard={lastHeard} />
        {vm.emergency && <View style={styles.countdown}><CountdownRing minutes={vm.status.minsToDanger} /></View>}
        {(vm.emergency || vm.lostAlarm) && <View style={styles.actions}>
          {vm.emergency && <>
            <ActionButton emergency icon={now < sentUntil ? 'check' : 'arrow'} onPress={acknowledge} disabled={sending || now < sentUntil}>{sending ? 'Sending…' : now < sentUntil ? 'Message sent' : "I'm on my way"}</ActionButton>
            <Text style={[styles.small, styles.onRed]}>This tells Echo you are responding. The alarm continues.</Text>
          </>}
          {!!ackNote && <Text accessibilityRole="alert" style={[styles.body, emergencyScreen && styles.onRed]}>{ackNote}</Text>}
          <ActionButton emergency={vm.emergency} icon="phone" secondary={vm.emergency} onPress={() => dial(() => emergencyPhone(config))}>{config.demoCalls ? 'Open demo dialer' : 'Call 911'}</ActionButton>
        </View>}
        {vm.emergency && <View style={styles.emergencyReadings}><CabinReadings vm={vm} showEstimate={false} /></View>}
        {!vm.emergency && <CabinHome vm={vm} visible={carVisible && !launchVisible} onSceneLayout={bounds => { carBounds.current = bounds; setCarVisible(sceneVisible(bounds, viewport.current.offset, viewport.current.height)); }} />}
        <LatestActivity emergency={vm.emergency} actions={actions} history={data.entries} onOpen={() => setTab('Feed')} />
        {vm.emergency ? <Chart entries={data.entries} status={status} online={vm.online} /> : <View style={styles.historySection}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showChart }} onPress={() => setShowChart(value => !value)} style={({ pressed }) => [styles.historyToggle, pressed && { opacity: .65 }]}>
            <View style={styles.inline}><Icon name="activity" size={21} /><Text style={styles.rowTitle}>Temperature history</Text></View><Text style={styles.body}>{showChart ? '−' : '+'}</Text>
          </Pressable>
          {showChart && <Chart entries={data.entries} status={status} online={vm.online} />}
        </View>}
        {!vm.emergency && <ActionButton secondary icon="contacts" onPress={() => setTab('Contacts')}>Your emergency contacts</ActionButton>}
        {!!note && <Text accessibilityRole="alert" style={[styles.body, emergencyScreen && styles.onRed]}>{note}</Text>}
        {!config.serverUrl && <Text style={styles.small}>Connect Echo to start receiving readings.</Text>}
        <View style={styles.safetyLine}><Icon name="shield" size={13} color={emergencyScreen ? '#F6F1F2' : palette.muted} /><Text style={[styles.safetyText, emergencyScreen && { color: '#F6F1F2' }]}>Only the button on the box can stop the alarm.</Text></View>
      </>}
    </ScrollView>
    <Navigation tab={tab} onChange={setTab} bottom={insets.bottom} light={!emergencyScreen} />
    </View>
    {!launchDone && <LaunchCover fontsReady={fontsLoaded || !!fontError} emergency={vm.emergency} onFinish={setLaunchDone} />}
  </View>;
}
const styles = StyleSheet.create({
  emergencyBrand: { alignSelf: 'flex-start', padding: 8, paddingBottom: 0, backgroundColor: palette.ground, borderRadius: 12 },
  countdown: { alignItems: 'center' },
  emergencyReadings: { backgroundColor: '#F8EAD5', padding: 16, borderRadius: 18 },
  historySection: { backgroundColor: '#F8EAD5', borderRadius: 18, overflow: 'hidden' },
  historyToggle: { minHeight: 56, padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  onRed: { color: '#FFF5E9' },
  screen: { flex: 1, backgroundColor: palette.ground }, emergency: { backgroundColor: '#B62432' },
  content: { flexGrow: 1, paddingHorizontal: 22, paddingBottom: 20, gap: 18, width: '100%', maxWidth: 560, alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, inline: { flexDirection: 'row', alignItems: 'center', gap: 7 }, center: { textAlign: 'center' },
  title: { fontFamily: 'Outfit', fontSize: 32, letterSpacing: -1, color: palette.text }, subtitle: { fontFamily: 'Manrope', fontSize: 14, lineHeight: 22, color: palette.muted },
  body: { fontFamily: 'Manrope', fontSize: 14, lineHeight: 22, color: palette.text }, small: { fontFamily: 'Manrope', fontSize: 12, lineHeight: 18, color: palette.muted }, muted: { fontFamily: 'Manrope', fontSize: 12, lineHeight: 18, color: palette.muted },
  sectionLabel: { fontFamily: 'Outfit', fontSize: 12, letterSpacing: 1.6, color: palette.muted }, pageHeading: { gap: 12, marginTop: 12, marginBottom: 16 },
  actions: { gap: 10 },
  safetyLine: { flexDirection: 'row', gap: 8, justifyContent: 'center', alignItems: 'center', paddingTop: 3 }, safetyText: { fontFamily: 'Manrope', fontSize: 14, lineHeight: 20, color: palette.muted, flexShrink: 1 },
  emergencyBanner: { marginHorizontal: 22, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#36131B', borderWidth: 1, borderColor: '#E5202E60', borderRadius: 18, padding: 16 },
  rowTitle: { fontFamily: 'Outfit', color: palette.text, fontSize: 17 }, activityRow: { flexDirection: 'row', gap: 13 }, timeline: { width: 9, alignItems: 'center', paddingTop: 25 }, timelineDot: { width: 7, height: 7, borderRadius: 4 }, timelineLine: { flex: 1, width: 1, backgroundColor: palette.line, marginTop: 9, marginBottom: 2 },
  activityCard: { flex: 1, borderBottomWidth: 1, borderColor: palette.line, paddingVertical: 16, paddingHorizontal: 2, marginBottom: 12, gap: 10 }, latestCard: { borderColor: '#E0306A40' }, sourceLabel: { fontFamily: 'Outfit', fontSize: 12, letterSpacing: 1.1 }, time: { fontFamily: 'Manrope', fontSize: 12, color: palette.muted }, reason: { fontFamily: 'Manrope', fontSize: 13, lineHeight: 20, color: palette.muted },
  emptyState: { alignItems: 'center', paddingVertical: 60, gap: 15 }, emptyIcon: { width: 72, height: 72, borderRadius: 26, backgroundColor: '#FFF3CD40', alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  contactList: { gap: 14, marginBottom: 8 }, contactCard: { backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 24, padding: 20, gap: 22 }, firstContact: { borderColor: '#E0306A40' }, contactOrder: { fontFamily: 'Outfit', fontSize: 12, letterSpacing: 1.4, color: palette.muted }, firstTag: { fontFamily: 'Outfit', fontSize: 12, letterSpacing: 0.8, color: palette.brand },
  contactPerson: { flexDirection: 'row', alignItems: 'center', gap: 14 }, avatar: { width: 50, height: 50, borderRadius: 18, backgroundColor: '#FFF3CD55', alignItems: 'center', justifyContent: 'center' }, initial: { fontFamily: 'Doto', fontSize: 27, color: palette.text }, contactName: { fontFamily: 'Outfit', fontSize: 24, color: palette.text, flex: 1 },
});
