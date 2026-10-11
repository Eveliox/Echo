import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { Brand, Icon } from './ui';
import { insightsView } from './insights';
import insightsFile from '../assets/insights.json';

const ink = '#352315';
const muted = '#715037';
// Bundled notebook export (or its design-example starter); predictions only, never live values.
const view = insightsView(insightsFile);

function HeatArc({ moments, ticks, selected, timeline }) {
  const point = moments[selected];
  return <View style={s.arc} accessible accessibilityLabel={`Heat progression: ${point.minute} minutes ${timeline}, ${point.temperature} degrees Fahrenheit. Arc indicates elapsed time, not a temperature scale.`}>
    <Svg width="100%" height="100%" viewBox="0 0 340 182" accessible={false}>
      <Line x1="15" x2="325" y1="142" y2="142" stroke={ink} strokeOpacity="0.12" />
      <Path d="M8 174 Q18 157 35 142 M305 142 Q320 158 332 174" stroke={ink} strokeOpacity="0.25" strokeWidth="2" strokeDasharray="1 10" strokeLinecap="round" fill="none" />
      <Path d="M35 142 C94 9 246 9 305 142" stroke={ink} strokeWidth="2" fill="none" />
      <Line x1={point.x} x2={point.x} y1={point.y} y2="142" stroke={ink} strokeOpacity="0.24" />
      {ticks.map((x, index) => <Circle key={index} cx={x} cy="142" r="3" fill={ink} />)}
      <Circle cx={point.x} cy={point.y} r="24" fill="#FF9A4A" />
      <Circle cx={point.x} cy={point.y} r="6" fill={ink} />
      {Array.from({ length: 12 }, (_, index) => {
        const angle = index * Math.PI / 6;
        return <Line key={index} x1={point.x + Math.cos(angle) * 10} y1={point.y + Math.sin(angle) * 10} x2={point.x + Math.cos(angle) * 13} y2={point.y + Math.sin(angle) * 13} stroke={ink} strokeWidth="1.7" strokeLinecap="round" />;
      })}
    </Svg>
  </View>;
}

function WarmingBars() {
  return <Svg width="100%" height="54" viewBox="0 0 140 54" accessible={false}>
    {Array.from({ length: 25 }, (_, i) => {
      const height = 6 + 38 * Math.exp(-((i - 14) ** 2) / 24);
      return <Line key={i} x1={4 + i * 5.5} x2={4 + i * 5.5} y1={27 - height / 2} y2={27 + height / 2} stroke={ink} strokeOpacity={0.15 + height / 90} strokeWidth="1.5" />;
    })}
  </Svg>;
}

export function HeatInsights() {
  const [selected, setSelected] = useState(1);
  if (!view.ok) return <>
    <View style={s.header}><Brand /></View>
    <View><Text style={s.title}>Heat insights</Text></View>
    <View style={s.hero}><Text style={s.heroLabel}>{view.message}</Text></View>
    <Text style={s.footnote}>From past heat tests. Live alerts and countdowns always come from the box.</Text>
  </>;
  const { moments } = view;
  const point = moments[Math.min(selected, moments.length - 1)];
  return <>
    <View style={s.header}><Brand /><Text style={s.preview}>{view.badge}</Text></View>
    <View><Text style={s.title}>Heat insights</Text><Text style={s.subtitle}>{view.subtitle}</Text></View>
    <View style={s.hero}>
      <View style={s.numberRow}><Text style={s.number}>{view.minutes}</Text><Text style={s.unit}>min</Text></View>
      <Text style={s.heroLabel}>{view.minutesLabel}</Text>
      <Text style={s.sentence}>{view.sentence}</Text>
      {view.label && <Text style={s.disclosure}>{view.label}</Text>}
      {view.note && <Text style={s.disclosure}>{view.note}</Text>}
    </View>
    <View>
      <HeatArc moments={moments} ticks={view.ticks} selected={moments.indexOf(point)} timeline={view.timeline} />
      <View style={s.moments} accessibilityRole="tablist" accessibilityLabel="Explore the heat progression">
        {moments.map((moment, index) => <Pressable key={index} accessibilityRole="tab" accessibilityState={{ selected: point === moment }} accessibilityLabel={`${moment.minute} minutes, ${moment.temperature} degrees Fahrenheit`} onPress={() => setSelected(index)} style={({ pressed }) => [s.moment, point === moment && s.selectedMoment, pressed && { opacity: 0.55 }]}>
          <Text style={s.momentValue}>{moment.temperature}°</Text><Text style={s.caption}>{index === 0 ? 'Start' : `+${moment.minute} min`}</Text>
        </Pressable>)}
      </View>
      <Text accessibilityLiveRegion="polite" style={s.arcCaption}>{point.label} · {point.minute} min {view.timeline}</Text>
    </View>
    <View style={s.cards}>
      <View style={s.card}><Text style={s.cardTitle}>Warming</Text><Text style={s.caption}>{view.inputsCaption}</Text><Text adjustsFontSizeToFit numberOfLines={1} style={s.cardNumber}>{view.warming}<Text style={s.smallUnit}>°F/min</Text></Text><WarmingBars /><Text style={s.caption}>Heat accumulating</Text></View>
    </View>
    <View style={s.context}><View style={s.contextItem}><Icon name="clock" size={17} color={ink} /><Text style={s.contextText}>{view.timeOfDay}</Text></View><Text style={s.caption}>{view.startCaption}</Text></View>
    <View style={s.future}><Text style={s.futureTitle}>How heat becomes insight.</Text><Text style={s.body}>{view.how}</Text><Text style={s.body}>{view.basis}</Text></View>
    <Text style={s.footnote}>{view.footnote}</Text>
  </>;
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  preview: { fontFamily: 'Outfit', color: muted, fontSize: 12, letterSpacing: 1.5 },
  title: { fontFamily: 'Outfit', fontSize: 29, letterSpacing: -0.7, color: ink }, subtitle: { fontFamily: 'Manrope', fontSize: 18, color: muted, marginTop: 2 },
  hero: { alignItems: 'center', paddingTop: 0, paddingBottom: 4, gap: 5 }, numberRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 8 },
  number: { fontFamily: 'Doto', fontSize: 114, letterSpacing: -7, color: ink }, unit: { fontFamily: 'Outfit', fontSize: 22, color: ink },
  heroLabel: { fontFamily: 'Outfit', fontSize: 17, color: ink }, sentence: { fontFamily: 'Manrope', fontSize: 13, lineHeight: 19, color: ink, textAlign: 'center' }, disclosure: { fontFamily: 'Manrope', fontSize: 12, color: muted },
  arc: { width: '100%', aspectRatio: 340 / 182 }, moments: { flexDirection: 'row', justifyContent: 'space-between', gap: 16, marginTop: -10 },
  moment: { flex: 1, alignItems: 'center', gap: 3, minHeight: 59, paddingBottom: 8, borderBottomWidth: 1, borderColor: 'transparent' }, selectedMoment: { borderColor: '#35231565' },
  momentValue: { fontFamily: 'Outfit', fontSize: 25, color: ink }, caption: { fontFamily: 'Manrope', fontSize: 12, lineHeight: 18, color: muted },
  arcCaption: { fontFamily: 'Manrope', fontSize: 12, color: muted, textAlign: 'center', marginTop: 10 },
  cards: { flexDirection: 'row', gap: 10 }, card: { flex: 1, backgroundColor: '#FFF3CD26', borderRadius: 25, padding: 15, gap: 3 },
  cardTitle: { fontFamily: 'Outfit', fontSize: 16, color: ink }, cardNumber: { fontFamily: 'Doto', fontSize: 34, color: ink, marginVertical: 9, letterSpacing: -1.5 }, smallUnit: { fontFamily: 'Manrope', fontSize: 12, letterSpacing: 0 },
  context: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 }, contextItem: { flexDirection: 'row', gap: 6, alignItems: 'center' }, contextText: { fontFamily: 'Outfit', fontSize: 13, color: ink },
  future: { gap: 10, borderTopWidth: 1, borderColor: '#35231525', paddingTop: 20, marginTop: 4 }, futureTitle: { fontFamily: 'Outfit', fontSize: 20, color: ink }, body: { fontFamily: 'Manrope', fontSize: 13, lineHeight: 21, color: ink },
  footnote: { fontFamily: 'Manrope', fontSize: 12, lineHeight: 18, color: muted, paddingBottom: 10 },
});
