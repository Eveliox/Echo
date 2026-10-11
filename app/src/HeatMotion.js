import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { countdownView } from './home';

export function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted) setReduced(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { mounted = false; subscription.remove(); };
  }, []);
  return reduced;
}

export function CountdownRing({ minutes }) {
  const reduced = useReducedMotion();
  const [pulse] = useState(() => new Animated.Value(0));
  const view = countdownView(minutes);
  const hasEstimate = view.unit !== '';
  useEffect(() => {
    pulse.setValue(0);
    if (reduced || !hasEstimate) return;
    // A breathing halo, not elapsed time or a percentage of time remaining.
    // The number below is always the literal latest box value, including zero.
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false }),
      Animated.timing(pulse, { toValue: 0, duration: 1000, easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false }),
    ]));
    animation.start();
    return () => animation.stop();
  }, [hasEstimate, reduced, pulse]);
  return <View style={s.ring} accessible accessibilityLiveRegion="polite" accessibilityLabel={view.spoken}>
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.2, 0.6] }), transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.045] }) }] }]}>
      <Svg width="100%" height="100%" viewBox="0 0 224 224" accessible={false}><Circle cx="112" cy="112" r="102" stroke="#FFD5A5" strokeWidth="3" fill="none" /></Svg>
    </Animated.View>
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" viewBox="0 0 224 224" accessible={false}><Circle cx="112" cy="112" r="96" stroke="#FFF5E9" strokeOpacity={hasEstimate ? 0.75 : 0.25} strokeWidth="1" fill="none" /></Svg>
    <Text style={s.label}>{view.label}</Text>
    <View style={s.numberRow}><Text adjustsFontSizeToFit numberOfLines={1} style={s.number}>{view.value}</Text>{hasEstimate && <Text style={s.unit}>{view.unit}</Text>}</View>
    <Text style={s.caption}>Reported by the box</Text>
  </View>;
}

const s = StyleSheet.create({
  ring: { width: 224, height: 224, alignItems: 'center', justifyContent: 'center', gap: 3 },
  label: { fontFamily: 'Manrope', fontSize: 13, letterSpacing: 2, color: '#FFF5E9' },
  numberRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', width: 170, gap: 5 },
  number: { fontFamily: 'Doto', fontSize: 84, letterSpacing: -3, flexShrink: 1, color: '#FFF5E9' },
  unit: { fontFamily: 'Outfit', fontSize: 20, color: '#FFF5E9' },
  caption: { fontFamily: 'Manrope', fontSize: 13, color: '#FFF5E9' },
});
