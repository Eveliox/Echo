import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Image, StyleSheet } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { shouldRevealApp } from './launch';
import { palette, WarmBackground } from './ui';

export function LaunchCover({ fontsReady, emergency, onFinish }) {
  const [opacity] = useState(() => new Animated.Value(1));
  const [imageReady, setImageReady] = useState(false);
  const [laidOut, setLaidOut] = useState(false);
  const [nativeHidden, setNativeHidden] = useState(false);
  const [loadTimedOut, setLoadTimedOut] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(true);
  const reveal = shouldRevealApp({ elapsedMs, assetsReady: fontsReady && imageReady, emergency, nativeHidden });

  useEffect(() => {
    // A local image failure must not trap the app behind the native loader.
    const timer = setTimeout(() => setLoadTimedOut(true), 1500);
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted) setReduceMotion(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { mounted = false; clearTimeout(timer); subscription.remove(); };
  }, []);
  useEffect(() => {
    if (nativeHidden || (!emergency && !loadTimedOut && !(laidOut && imageReady))) return;
    let stopped = false;
    let frame;
    // Keep the native splash until the matching in-app logo is ready. Start
    // the pause on the next drawn frame, not while Expo's loader is on top.
    SplashScreen.hideAsync().catch(() => {}).then(() => {
      if (!stopped) frame = requestAnimationFrame(() => { if (!stopped) setNativeHidden(true); });
    });
    return () => { stopped = true; if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [laidOut, imageReady, loadTimedOut, emergency, nativeHidden]);
  useEffect(() => {
    if (!nativeHidden) return;
    const start = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - start), 50);
    return () => clearInterval(timer);
  }, [nativeHidden]);
  useEffect(() => {
    if (!reveal) return;
    if (emergency || reduceMotion) {
      SplashScreen.hideAsync().catch(() => {});
      onFinish(true);
      return;
    }
    const animation = Animated.timing(opacity, { toValue: 0, duration: 400, useNativeDriver: true });
    animation.start(({ finished }) => { if (finished) onFinish(true); });
    return () => animation.stop();
  }, [reveal, emergency, reduceMotion, opacity, onFinish]);
  if (emergency) return null;
  return <Animated.View onLayout={() => setLaidOut(true)} accessibilityViewIsModal importantForAccessibility="yes" style={[styles.cover, { opacity }]}>
    <WarmBackground />
    <Image source={require('../assets/echo-logo.png')} accessibilityLabel="Echo" resizeMode="contain" fadeDuration={0} onLoad={() => setImageReady(true)} onError={() => setImageReady(true)} style={styles.logo} />
  </Animated.View>;
}
const styles = StyleSheet.create({
  cover: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: palette.ground, justifyContent: 'center', alignItems: 'center', zIndex: 10 },
  logo: { width: 240, height: 80, maxWidth: '80%' },
});
