import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

const AnimatedPath = Animated.createAnimatedComponent(Path);

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

// Reveal the received curve; the faint base and latest marker stay visible.
// Animation never interpolates temperatures or invents additional readings.
export function HeatTrace({ points, path }) {
  const reduced = useReducedMotion();
  const [reveal] = useState(() => new Animated.Value(1));
  const length = points.reduce((total, point, i) => i === 0 ? total : total + Math.hypot(point.x - points[i - 1].x, point.y - points[i - 1].y), 0);
  useEffect(() => {
    reveal.setValue(reduced ? 1 : 0);
    if (reduced) return;
    const animation = Animated.timing(reveal, { toValue: 1, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: false, isInteraction: false });
    animation.start();
    return () => animation.stop();
  }, [path, reduced, reveal]);
  return <>
    <Path d={path} fill="none" stroke="#F6F1F2" strokeOpacity={0.3} strokeWidth={2.25} strokeLinejoin="round" />
    {length > 0 && <AnimatedPath d={path} fill="none" stroke="#F6F1F2" strokeWidth={2.25} strokeLinejoin="round" strokeDasharray={[length, length]} strokeDashoffset={reveal.interpolate({ inputRange: [0, 1], outputRange: [length, 0] })} />}
  </>;
}

export function CountdownRing({ minutes }) {
  const reduced = useReducedMotion();
  const [pulse] = useState(() => new Animated.Value(0));
  const hasEstimate = Number.isFinite(minutes) && minutes >= 0;
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
  return <View style={s.ring} accessible accessibilityLiveRegion="polite" accessibilityLabel={hasEstimate ? `${minutes} minutes to danger, reported by the box` : 'No danger estimate from the box'}>
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.2, 0.6] }), transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.045] }) }] }]}>
      <Svg width="100%" height="100%" viewBox="0 0 224 224" accessible={false}><Circle cx="112" cy="112" r="102" stroke="#FFD5A5" strokeWidth="3" fill="none" /></Svg>
    </Animated.View>
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" viewBox="0 0 224 224" accessible={false}><Circle cx="112" cy="112" r="96" stroke="#FFF5E9" strokeOpacity={hasEstimate ? 0.75 : 0.25} strokeWidth="1" fill="none" /></Svg>
    <Text style={s.label}>DANGER IN</Text>
    <View style={s.numberRow}><Text adjustsFontSizeToFit numberOfLines={1} style={s.number}>{hasEstimate ? String(minutes) : '—'}</Text><Text style={s.unit}>min</Text></View>
    <Text style={s.caption}>Reported by the box</Text>
  </View>;
}

const s = StyleSheet.create({
  ring: { width: 224, height: 224, alignItems: 'center', justifyContent: 'center', gap: 3 },
  label: { fontFamily: 'Manrope', fontSize: 9, letterSpacing: 2, color: '#FFF5E9' },
  numberRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', width: 170, gap: 5 },
  number: { fontFamily: 'Doto', fontSize: 76, letterSpacing: -3, flexShrink: 1, color: '#FFF5E9' },
  unit: { fontFamily: 'Outfit', fontSize: 19, color: '#FFF5E9' },
  caption: { fontFamily: 'Manrope', fontSize: 9, color: '#FFF5E9' },
});
