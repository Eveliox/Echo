import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

export const palette = { ground: '#F5E5DB', surface: '#FFF3CD30', raised: '#FFF3CD55', text: '#352315', muted: '#715037', line: '#35231520', brand: '#873F25' };
export function WarmBackground() {
  return <View pointerEvents="none" style={StyleSheet.absoluteFill} accessible={false}>
    <Svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 390 850">
      <Defs>
        <LinearGradient id="heatSky" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#F5E5DB" /><Stop offset="0.3" stopColor="#FFC6A6" /><Stop offset="0.57" stopColor="#FFDD75" /><Stop offset="1" stopColor="#FF8C43" /></LinearGradient>
        <RadialGradient id="heatSun"><Stop offset="0" stopColor="#FFEE81" stopOpacity="1" /><Stop offset="0.48" stopColor="#FFE678" stopOpacity="0.8" /><Stop offset="1" stopColor="#FFE678" stopOpacity="0" /></RadialGradient>
        <RadialGradient id="heatEmber"><Stop offset="0" stopColor="#FF642C" stopOpacity="0.85" /><Stop offset="1" stopColor="#FF642C" stopOpacity="0" /></RadialGradient>
      </Defs>
      <Rect width="390" height="850" fill="url(#heatSky)" />
      <Rect x="-140" y="210" width="670" height="480" fill="url(#heatSun)" />
      <Rect x="15" y="410" width="400" height="600" fill="url(#heatEmber)" />
    </Svg>
  </View>;
}

const paths = {
  heat: 'M8 3c-3 3 3 4 0 7m4-8c-3 3 3 4 0 7m4-6c-3 3 3 4 0 7M4 17h16M7 21h10',
  car: 'M5 10 7 5h10l2 5M4 10h16v8H4zM7 18v2m10-2v2M7 13h1m8 0h1',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  contacts: 'M15 20v-2a5 5 0 0 0-10 0v2M17 13a4 4 0 0 1 4 4v3M14 4a4 4 0 0 1 0 8M13 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6zM8 12l3 3 5-6',
  phone: 'M8 3H4v3c0 8 6 14 14 14h3v-4l-5-2-2 2c-3-1-5-3-6-6l2-2z',
  check: 'm5 12 4 4L19 6',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  offline: 'm3 3 18 18M5 7a13 13 0 0 0-2 2m5 2-2 2m4 2-1 1m3 4h.01M10 5a14 14 0 0 1 11 4m-7 0a9 9 0 0 1 4 3',
  seat: 'M7 4v9h10v6M7 13l-2 6h12M8 7h4v5m-4 7v2m10-2v2',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  alert: 'm12 3 10 18H2zM12 9v5m0 3h.01',
};
export function Icon({ name, size = 22, color = palette.text }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}><Path d={paths[name] || paths.activity} fill="none" stroke={color} strokeWidth={1.65} strokeLinecap="round" strokeLinejoin="round" /></Svg>;
}
export function Brand() {
  return <View style={s.brandRow}><Image source={require('../assets/echo-logo.png')} accessibilityLabel="Echo" resizeMode="contain" style={s.logo} /></View>;
}
export function StatusLabel({ label, color, live = false }) {
  const [opacity] = useState(() => new Animated.Value(1));
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted) setReduceMotion(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { mounted = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    opacity.setValue(1);
    if (!live || reduceMotion) return;
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 0.35, duration: 1200, useNativeDriver: true, isInteraction: false }),
      Animated.timing(opacity, { toValue: 1, duration: 1200, useNativeDriver: true, isInteraction: false }),
    ]));
    animation.start();
    return () => { animation.stop(); };
  }, [live, reduceMotion, opacity]);
  return <View style={s.statusLabel}><Animated.View style={[s.dot, { backgroundColor: color, opacity }]} /><Text style={[s.statusText, { color }]}>{label}</Text></View>;
}
export function Halo({ color }) {
  return <View pointerEvents="none" accessible={false} style={StyleSheet.absoluteFill}>
    <Svg width="100%" height="100%" viewBox="0 0 340 280">
      <Defs><RadialGradient id="halo"><Stop offset="0" stopColor={color} stopOpacity="0.15" /><Stop offset="1" stopColor={color} stopOpacity="0" /></RadialGradient></Defs>
      <Rect width="340" height="280" fill="url(#halo)" />
      <Circle cx="170" cy="140" r="123" stroke={color} strokeOpacity="0.11" strokeWidth="1" fill="none" />
      <Circle cx="170" cy="140" r="138" stroke={color} strokeOpacity="0.05" strokeWidth="1" fill="none" />
      <Line x1="170" x2="170" y1="10" y2="17" stroke={color} strokeOpacity="0.3" />
      <Line x1="170" x2="170" y1="263" y2="270" stroke={color} strokeOpacity="0.3" />
    </Svg>
  </View>;
}
export function ActionButton({ children, onPress, secondary = false, disabled = false, icon = 'arrow', emergency = false }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.button, secondary && s.secondary, emergency && { backgroundColor: secondary ? '#FFFFFF0C' : '#FFF5E9', borderColor: '#FFFFFF88' }, disabled && s.disabled, pressed && { transform: [{ scale: 0.985 }], opacity: 0.85 }]}>
    <Icon name={icon} size={20} color={emergency ? secondary ? '#FFF5E9' : '#6A1720' : secondary ? palette.text : palette.ground} /><Text style={[s.buttonText, secondary && { color: palette.text }, emergency && { color: secondary ? '#FFF5E9' : '#6A1720' }]}>{children}</Text>
  </Pressable>;
}
export function Notice({ title, children, icon = 'shield', urgent = false }) {
  const color = urgent ? '#B62432' : palette.muted;
  return <View accessibilityRole={urgent ? 'alert' : undefined} style={[s.notice, urgent && { borderColor: color, borderTopWidth: 2 }]}><View style={s.noticeIcon}><Icon name={icon} size={20} color={color} /></View><View style={{ flex: 1, gap: 5 }}>{title && <Text style={[s.noticeTitle, urgent && { color }]}>{title}</Text>}<Text style={[s.noticeText, urgent && { color: palette.text }]}>{children}</Text></View></View>;
}
export function Navigation({ tab, onChange, bottom, light = true }) {
  return <View style={[s.navOuter, { paddingBottom: Math.max(bottom, 12) }, { backgroundColor: light ? 'transparent' : '#7E1822' }]}><View accessibilityRole="tablist" style={[s.nav, { borderColor: light ? '#35231525' : '#FFFFFF30' }]}>
    {['Car', 'Feed', 'Contacts', 'Insights'].map(name => {
      const selected = tab === name;
      return <Pressable key={name} accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => onChange(name)} style={({ pressed }) => [s.tab, pressed && { opacity: 0.7 }]}>
        <Icon name={{ Car: 'car', Feed: 'activity', Contacts: 'contacts', Insights: 'heat' }[name]} color={light ? selected ? '#352315' : '#715037' : selected ? '#FFF5E9' : '#EFC4BD'} size={21} />
        <Text style={[s.tabLabel, selected && { color: palette.text }, { color: light ? selected ? '#352315' : '#715037' : selected ? '#FFF5E9' : '#EFC4BD' }]}>{name}</Text>
      </Pressable>;
    })}
  </View></View>;
}
export function AccentRule() {
  return <Svg width="44" height="3"><Defs><LinearGradient id="brandRule"><Stop offset="0" stopColor="#FF9A3C" /><Stop offset="1" stopColor="#E32B6E" /></LinearGradient></Defs><Rect width="44" height="3" rx="1.5" fill="url(#brandRule)" /></Svg>;
}
const s = StyleSheet.create({
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 8 }, logo: { width: 92, height: 34 },
  statusLabel: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 7, alignSelf: 'center' }, dot: { width: 5, height: 5, borderRadius: 3 }, statusText: { fontFamily: 'Outfit', fontSize: 10, letterSpacing: 1.2 },
  button: { minHeight: 58, borderRadius: 18, padding: 16, backgroundColor: palette.text, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10 },
  secondary: { backgroundColor: '#FFF3CD26', borderWidth: 1, borderColor: '#35231555' }, disabled: { opacity: 0.65 }, buttonText: { fontFamily: 'Outfit', fontSize: 17, color: palette.ground, flexShrink: 1 },
  notice: { borderColor: palette.line, borderTopWidth: 1, paddingVertical: 18, flexDirection: 'row', gap: 12 }, noticeIcon: { paddingTop: 1 }, noticeTitle: { fontFamily: 'Outfit', color: palette.text, fontSize: 14 }, noticeText: { fontFamily: 'Manrope', fontSize: 12, lineHeight: 19, color: palette.muted },
  navOuter: { backgroundColor: palette.ground, paddingHorizontal: 20, paddingTop: 10 }, nav: { flexDirection: 'row', borderTopWidth: 1, borderColor: palette.line, paddingTop: 8, gap: 4 },
  tab: { flex: 1, minHeight: 52, justifyContent: 'center', alignItems: 'center', gap: 5 }, tabLabel: { fontFamily: 'Outfit', color: palette.muted, fontSize: 11 },
});
