import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { config } from '../config';
import { saveContacts } from './client';
import { contactDraftError, MAX_CONTACTS, normalizePhone } from './model';
import { ActionButton, Notice, palette } from './ui';

// Replaces the whole contact list. The server never sends numbers to the app,
// so names start filled in from the current list and every number is typed.
export function ContactsEditor({ names, onDone }) {
  const [rows, setRows] = useState(() => (names.length ? names : ['']).map(name => ({ name, number: '' })));
  const [pin, setPin] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState('');
  const change = (index, field, value) => setRows(current => current.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  const save = async () => {
    const error = contactDraftError(rows) || (config.demoContacts || pin.trim() ? '' : 'Enter the Echo PIN.');
    if (error) { setProblem(error); return; }
    setSending(true);
    setProblem('');
    try {
      const contacts = rows.map(row => ({ name: row.name.normalize('NFC').trim(), number: normalizePhone(row.number) }));
      const result = await saveContacts(config.serverUrl, pin.trim(), contacts, { demo: config.demoContacts });
      onDone(`Saved ${result.saved} contact${result.saved === 1 ? '' : 's'}. Echo starts calling them after the Echo server restarts.`);
    } catch (err) { setProblem(err.message); }
    finally { setSending(false); }
  };
  return <View style={styles.editor}>
    <Text style={styles.label}>EDIT EMERGENCY CONTACTS</Text>
    <Text style={styles.help}>Echo calls them in this order. Numbers are kept on the Echo server; this app only shows names.</Text>
    {rows.map((row, index) => <View key={index} style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.order}>CONTACT {String(index + 1).padStart(2, '0')}</Text>
        {rows.length > 1 && <Pressable accessibilityRole="button" accessibilityLabel={`Remove contact ${index + 1}`} hitSlop={10} onPress={() => setRows(current => current.filter((_, i) => i !== index))}><Text style={styles.remove}>Remove</Text></Pressable>}
      </View>
      <TextInput style={styles.input} value={row.name} onChangeText={value => change(index, 'name', value)} placeholder="Name" placeholderTextColor={palette.muted} autoCapitalize="words" maxLength={40} accessibilityLabel={`Contact ${index + 1} name`} />
      <TextInput style={styles.input} value={row.number} onChangeText={value => change(index, 'number', value)} placeholder="Phone, like (305) 555-0100" placeholderTextColor={palette.muted} keyboardType="phone-pad" textContentType="telephoneNumber" maxLength={20} accessibilityLabel={`Contact ${index + 1} phone number`} />
    </View>)}
    {rows.length < MAX_CONTACTS && <ActionButton secondary icon="contacts" onPress={() => setRows(current => [...current, { name: '', number: '' }])}>Add a contact</ActionButton>}
    {!config.demoContacts && <>
      <Text style={styles.label}>ECHO PIN</Text>
      <TextInput style={styles.input} value={pin} onChangeText={setPin} placeholder="From whoever set up your Echo" placeholderTextColor={palette.muted} keyboardType="number-pad" secureTextEntry maxLength={12} accessibilityLabel="Echo PIN" />
    </>}
    {!!problem && <Notice urgent icon="alert" title="Not saved">{problem}</Notice>}
    <ActionButton icon="check" onPress={save} disabled={sending}>{sending ? 'Saving…' : 'Save contacts'}</ActionButton>
    <ActionButton secondary icon="arrow" onPress={() => onDone('')} disabled={sending}>Cancel</ActionButton>
  </View>;
}

const styles = StyleSheet.create({
  editor: { gap: 14 },
  label: { fontFamily: 'Outfit', fontSize: 12, letterSpacing: 1.6, color: palette.muted, marginTop: 4 },
  help: { fontFamily: 'Manrope', fontSize: 13, lineHeight: 20, color: palette.muted },
  card: { backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 24, padding: 18, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  order: { fontFamily: 'Outfit', fontSize: 12, letterSpacing: 1.4, color: palette.muted },
  remove: { fontFamily: 'Manrope', fontSize: 13, color: palette.brand },
  input: { fontFamily: 'Manrope', fontSize: 17, color: palette.text, backgroundColor: palette.raised, borderWidth: 1, borderColor: palette.line, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, minHeight: 50 },
});
