import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { Brand, Icon } from './ui';

const ink = '#352315';
const muted = '#715037';
// Illustrative design fixture, not a notebook export or live sensor data.
const moments = [
  { minute: 0, temperature: 92, x: 35, y: 142, label: 'Starting cabin' },
  { minute: 7, temperature: 98, x: 170, y: 42, label: 'Heat building' },
  { minute: 14, temperature: 104, x: 305, y: 142, label: 'Danger threshold' },
];


function HeatArc({ selected }) {
  const point = moments[selected];
  return <View style={s.arc} accessible accessibilityLabel={`Illustrative progression: ${point.minute} minutes, ${point.temperature} degrees Fahrenheit. Arc indicates elapsed example time, not a temperature scale.`}>
    <Svg width="100%" height="100%" viewBox="0 0 340 182" accessible={false}>
      <Line x1="15" x2="325" y1="142" y2="142" stroke={ink} strokeOpacity="0.12" />
      <Path d="M8 174 Q18 157 35 142 M305 142 Q320 158 332 174" stroke={ink} strokeOpacity="0.25" strokeWidth="2" strokeDasharray="1 10" strokeLinecap="round" fill="none" />
      <Path d="M35 142 C94 9 246 9 305 142" stroke={ink} strokeWidth="2" fill="none" />
      <Line x1={point.x} x2={point.x} y1={point.y} y2="142" stroke={ink} strokeOpacity="0.24" />
      {moments.map(moment => <Circle key={moment.minute} cx={moment.x} cy="142" r="3" fill={ink} />)}
      <Circle cx={point.x} cy={point.y} r="24" fill="#FFD16C" />
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

function HumidityDots() {
  return <Svg width="100%" height="54" viewBox="0 0 140 54" accessible={false}>
    {Array.from({ length: 36 }, (_, i) => <Circle key={i} cx={15 + (i % 12) * 10} cy={12 + Math.floor(i / 12) * 15} r={i % 5 === 0 ? 3 : 2} fill={ink} fillOpacity={i < 15 ? 0.65 : 0.13} />)}
  </Svg>;
}

export function HeatInsights() {
  const [selected, setSelected] = useState(1);
  const point = moments[selected];
  return <>
    <View style={s.header}><Brand /><Text style={s.preview}>DESIGN PREVIEW</Text></View>
    <View><Text style={s.title}>Heat insights</Text><Text style={s.subtitle}>An afternoon, imagined.</Text></View>
    <View style={s.hero}>
      <View style={s.numberRow}><Text style={s.number}>14</Text><Text style={s.unit}>min</Text></View>
      <Text style={s.heroLabel}>Example time to 104°F</Text>
      <Text style={s.disclosure}>(not from a real heat test)</Text>
    </View>
    <View>
      <HeatArc selected={selected} />
      <View style={s.moments} accessibilityRole="tablist" accessibilityLabel="Explore illustrative heat progression">
        {moments.map((moment, index) => <Pressable key={moment.minute} accessibilityRole="tab" accessibilityState={{ selected: selected === index }} accessibilityLabel={`${moment.minute} minutes, ${moment.temperature} degrees Fahrenheit`} onPress={() => setSelected(index)} style={({ pressed }) => [s.moment, selected === index && s.selectedMoment, pressed && { opacity: 0.55 }]}>
          <Text style={s.momentValue}>{moment.temperature}°</Text><Text style={s.caption}>{moment.minute === 0 ? 'Start' : `+${moment.minute} min`}</Text>
        </Pressable>)}
      </View>
      <Text accessibilityLiveRegion="polite" style={s.arcCaption}>{point.label} · {point.minute} min into the example</Text>
    </View>
    <View style={s.cards}>
      <View style={s.card}><Text style={s.cardTitle}>Warming</Text><Text style={s.caption}>Example average</Text><Text adjustsFontSizeToFit numberOfLines={1} style={s.cardNumber}>+0.86<Text style={s.smallUnit}>°F/min</Text></Text><WarmingBars /><Text style={s.caption}>Heat accumulating</Text></View>
      <View style={s.card}><Text style={s.cardTitle}>Humidity</Text><Text style={s.caption}>Example condition</Text><Text style={s.cardNumber}>41<Text style={s.smallUnit}>%</Text></Text><HumidityDots /><Text style={s.caption}>Relative humidity</Text></View>
    </View>
    <View style={s.context}><View style={s.contextItem}><Icon name="clock" size={17} color={ink} /><Text style={s.contextText}>2:00 PM</Text></View><Text style={s.caption}>92°F starting cabin · example inputs</Text></View>
    <View style={s.future}><Text style={s.futureTitle}>How heat becomes insight.</Text><Text style={s.body}>With real heat tests, Databricks will turn patterns in temperature, humidity, time of day, and warming rate into a simple prediction.</Text><Text style={s.body}>Real tests are still pending. Today’s logs are simulator replays.</Text></View>
    <Text style={s.footnote}>Illustrative only, not a safe waiting time. Live alerts and countdowns always come from the box.</Text>
  </>;
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  preview: { fontFamily: 'Outfit', color: muted, fontSize: 9, letterSpacing: 1.5 },
  title: { fontFamily: 'Outfit', fontSize: 29, letterSpacing: -0.7, color: ink }, subtitle: { fontFamily: 'Manrope', fontSize: 18, color: muted, marginTop: 2 },
  hero: { alignItems: 'center', paddingTop: 0, paddingBottom: 4, gap: 5 }, numberRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 8 },
  number: { fontFamily: 'Doto', fontSize: 114, letterSpacing: -7, color: ink }, unit: { fontFamily: 'Outfit', fontSize: 22, color: ink },
  heroLabel: { fontFamily: 'Outfit', fontSize: 17, color: ink }, disclosure: { fontFamily: 'Manrope', fontSize: 11, color: muted },
  arc: { width: '100%', aspectRatio: 340 / 182 }, moments: { flexDirection: 'row', justifyContent: 'space-between', gap: 16, marginTop: -10 },
  moment: { flex: 1, alignItems: 'center', gap: 3, minHeight: 59, paddingBottom: 8, borderBottomWidth: 1, borderColor: 'transparent' }, selectedMoment: { borderColor: '#35231565' },
  momentValue: { fontFamily: 'Outfit', fontSize: 25, color: ink }, caption: { fontFamily: 'Manrope', fontSize: 10, lineHeight: 16, color: muted },
  arcCaption: { fontFamily: 'Manrope', fontSize: 10, color: muted, textAlign: 'center', marginTop: 10 },
  cards: { flexDirection: 'row', gap: 10 }, card: { flex: 1, backgroundColor: '#FFF3CD26', borderRadius: 25, padding: 15, gap: 3 },
  cardTitle: { fontFamily: 'Outfit', fontSize: 16, color: ink }, cardNumber: { fontFamily: 'Doto', fontSize: 34, color: ink, marginVertical: 9, letterSpacing: -1.5 }, smallUnit: { fontFamily: 'Manrope', fontSize: 11, letterSpacing: 0 },
  context: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 }, contextItem: { flexDirection: 'row', gap: 6, alignItems: 'center' }, contextText: { fontFamily: 'Outfit', fontSize: 12, color: ink },
  future: { gap: 10, borderTopWidth: 1, borderColor: '#35231525', paddingTop: 20, marginTop: 4 }, futureTitle: { fontFamily: 'Outfit', fontSize: 20, color: ink }, body: { fontFamily: 'Manrope', fontSize: 12, lineHeight: 20, color: ink },
  footnote: { fontFamily: 'Manrope', fontSize: 10, lineHeight: 17, color: muted, paddingBottom: 10 },
});
