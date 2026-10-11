import React, { useEffect, useRef, useState } from 'react';
import { AppState, Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useReducedMotion } from './HeatMotion';
import { carMotionAllowed } from './home';
import { palette } from './ui';
import viewer from '../assets/models/viewer.json';

const MODEL_HEIGHT = 230;

export function CabinCar({ online, visible, emergency, state, onLayout }) {
 const reduced = useReducedMotion();
 const web = useRef(null);
 const [active, setActive] = useState(AppState.currentState === 'active');
 const [paused, setPaused] = useState(false);
 const [ready, setReady] = useState(false);
 const [failed, setFailed] = useState(false);
 const [credits, setCredits] = useState(false);
 useEffect(() => { const s = AppState.addEventListener('change', v => setActive(v === 'active')); return () => s.remove(); }, []);
 const moving = carMotionAllowed({ online, visible, active, reduced, paused, emergency });
 const heat = state === 'WARNING' || state === 'EMERGENCY' ? 1 : state === 'OCCUPANT' ? .18 : 0;
 useEffect(() => {
  if (ready && !failed) web.current?.injectJavaScript(`window.echoCar && window.echoCar(${JSON.stringify({ moving, online, heat })}); true;`);
 }, [ready, failed, moving, online, heat]);
 useEffect(() => {
  if (ready || failed) return;
  const timeout = setTimeout(() => setFailed(true), 15000);
  return () => clearTimeout(timeout);
 }, [ready, failed]);
 const still = !online || reduced || emergency || failed;
 return <View style={s.scene} onLayout={event => onLayout?.({ y: event.nativeEvent.layout.y, height: MODEL_HEIGHT })}>
  <View style={s.model} accessible accessibilityRole="image" accessibilityLabel="Transparent sedan illustration with a highlighted rear seat. This is not your exact car or a detected seat location.">
   {(!ready || failed) && <Image source={require('../assets/models/transparent-sedan.png')} resizeMode="contain" style={StyleSheet.absoluteFill} />}
   {!failed && <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, { opacity: ready ? 1 : 0 }]}>
    <WebView ref={web} source={viewer} originWhitelist={['*']} style={s.web} scrollEnabled={false} bounces={false} javaScriptEnabled domStorageEnabled={false} mixedContentMode="never" setSupportMultipleWindows={false} onShouldStartLoadWithRequest={request => request.url === 'about:blank'} onError={() => setFailed(true)} onContentProcessDidTerminate={() => setFailed(true)} onRenderProcessGone={() => setFailed(true)} onMessage={event => {
     try { const message = JSON.parse(event.nativeEvent.data); if (message.type === 'ready') setReady(true); if (message.type === 'error') setFailed(true); } catch { setFailed(true); }
    }} />
   </View>}
  </View>
  <View style={s.controls}>
   <Pressable accessibilityRole="button" accessibilityState={{ disabled: still || !ready }} accessibilityLabel={paused ? 'Resume car rotation' : 'Pause car rotation'} disabled={still || !ready} onPress={() => setPaused(p => !p)} style={({ pressed }) => [s.control, pressed && s.pressed]}>
    <Text style={s.caption}>{failed ? 'Still view' : !ready ? 'Preparing 3D view…' : !online ? 'Rotation paused · offline' : reduced ? 'Still view · reduced motion' : emergency ? 'Rotation paused' : paused ? '▷ Rotate car' : 'Ⅱ Pause rotation'}</Text>
   </Pressable>
   <Pressable accessibilityRole="button" accessibilityState={{ expanded: credits }} accessibilityLabel="About the car illustration" onPress={() => setCredits(v => !v)} style={({ pressed }) => [s.control, pressed && s.pressed]}><Text style={s.caption}>Illustration info</Text></Pressable>
  </View>
  {credits && <View style={s.credits}><Text style={s.caption}>Illustration only. The seat highlight does not identify where your child is sitting.</Text><Text style={s.caption}>3D sedan by RBLXSupercars; source uploader brandonleong28. Adapted for Echo with transparent panels and a seat highlight. CC BY 4.0. No Tesla affiliation.</Text><Pressable accessibilityRole="link" onPress={() => Linking.openURL('https://sketchfab.com/RBLXSupercars').catch(() => {})} style={s.control}><Text style={s.link}>Model artist</Text></Pressable><Pressable accessibilityRole="link" onPress={() => Linking.openURL('https://creativecommons.org/licenses/by/4.0/').catch(() => {})} style={s.control}><Text style={s.link}>Creative Commons license</Text></Pressable></View>}
 </View>;
}
const s = StyleSheet.create({
 scene: { width: '100%' }, model: { height: MODEL_HEIGHT, width: '100%' }, web: { backgroundColor: 'transparent', flex: 1 },
 controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' },
 control: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 8 },
 caption: { fontFamily: 'Manrope', fontSize: 12, lineHeight: 18, color: palette.muted },
 pressed: { opacity: .6 }, credits: { gap: 8, paddingTop: 8 }, link: { fontFamily: 'Manrope', fontSize: 13, color: palette.text, textDecorationLine: 'underline' },
});
