import React, {useEffect, useState} from 'react';
import {Pressable, SafeAreaView, StyleSheet, Text, View} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import {JXLProvider, useJXL, type Bytes} from './src/index.ts';
import {selfTest} from './src/selftest.ts';

const bytesOf = async (uri: string): Promise<Uint8Array> => new Uint8Array(await (await fetch(uri)).arrayBuffer());

function Screen() {
  const codec = useJXL();
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState('');
  const say = (line: string) => { console.log(`rapier-jxl: ${line}`); setLines(old => [...old.slice(-7), line]); };

  useEffect(() => {
    if (process.env.EXPO_PUBLIC_RAPIER_SELFTEST !== '1') return;
    selfTest(codec, say).then(() => setVerdict('SELFTEST PASS'), error => { say(String(error?.message ?? error)); setVerdict('SELFTEST FAIL'); });
  }, [codec]);

  const pick = async (kind: 'images' | 'videos') => {
    const chosen = await ImagePicker.launchImageLibraryAsync({mediaTypes: [kind]});
    return chosen.canceled ? null : chosen.assets[0].uri;
  };
  const run = (name: string, source: () => Promise<Bytes | null>, call: (bytes: Bytes) => Promise<Uint8Array>) => async () => {
    setBusy(true);
    try {
      const input = await source();
      if (!input) return;
      const started = Date.now(), out = await call(input);
      say(`${name}: ${input.byteLength} to ${out.length} bytes in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    } catch (error: any) { say(`${error?.code ?? 'Error'}: ${error?.message ?? error}`); } finally { setBusy(false); }
  };
  const photo = run('Photo', async () => { const uri = await pick('images'); return uri ? bytesOf(uri) : null; }, bytes => codec.encode(bytes, {quality: 80, effort: 3}));
  const jpeg = run('JPEG', async () => { const uri = await pick('images'); return uri ? bytesOf(uri) : null; }, async bytes => {
    const small = await codec.recompress(bytes), back = await codec.restore(small), original = new Uint8Array(bytes as Uint8Array);
    say(back.length === original.length && back.every((b, i) => b === original[i]) ? 'Restored the same JPEG.' : 'The restored JPEG differs.');
    return small;
  });
  const video = run('Video', async () => { const uri = await pick('videos'); return uri ? bytesOf(uri) : null; }, bytes => codec.animate(bytes));

  return (
    <SafeAreaView style={styles.page}>
      <Text style={styles.title}>rapier-jxl</Text>
      <View style={styles.row}>
        {[['Photo', photo], ['JPEG', jpeg], ['Video', video]].map(([label, action]) => (
          <Pressable key={label as string} disabled={busy} onPress={action as () => void} style={[styles.button, busy && styles.off]}>
            <Text style={styles.label}>{label as string}</Text>
          </Pressable>
        ))}
      </View>
      {verdict ? <Text style={styles.verdict}>{verdict}</Text> : null}
      {lines.map((line, i) => <Text key={i} style={styles.line}>{line}</Text>)}
    </SafeAreaView>
  );
}

export default function App() {
  return <JXLProvider><Screen /></JXLProvider>;
}

const styles = StyleSheet.create({
  page: {flex: 1, backgroundColor: '#fff', padding: 16, paddingTop: 48},
  title: {fontSize: 20, fontWeight: '600', color: '#000', marginBottom: 16},
  row: {flexDirection: 'row', gap: 8, marginBottom: 16},
  button: {flex: 1, backgroundColor: '#000', padding: 14, alignItems: 'center'},
  off: {opacity: 0.4},
  label: {color: '#fff', fontSize: 16},
  verdict: {fontSize: 18, fontWeight: '600', color: '#000', marginBottom: 8},
  line: {fontSize: 14, color: '#000', marginBottom: 4}
});
