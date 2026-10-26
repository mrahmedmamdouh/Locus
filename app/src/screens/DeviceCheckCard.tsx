import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DeviceCheck } from '@locus/altitude-core';
import { useAppState } from '../state/AppState';
import { useDeviceCheck } from '../hooks/useDeviceCheck';
import { deviceCheckVerdict } from '../logic/deviceCheck';
import { Body, Button, Card, H2, Muted } from '../ui/kit';
import { colors, space } from '../ui/theme';

/** Run a device capability check and show the result for this phone. */
export function DeviceCheckCard() {
  const { deviceChecks, addDeviceCheck, updateSettings, recordingInProgress } = useAppState();
  const onDone = useCallback(
    (c: DeviceCheck) => {
      addDeviceCheck(c);
      updateSettings({ deviceCheckPromptDone: true });
    },
    [addDeviceCheck, updateSettings],
  );
  const { run, running, progress } = useDeviceCheck(onDone);
  const [error, setError] = useState<string | null>(null);
  const last = deviceChecks.length ? deviceChecks[deviceChecks.length - 1]! : null;

  const start = () => {
    setError(null);
    run().catch((e: unknown) => setError(e instanceof Error ? e.message : 'Device check failed.'));
  };

  return (
    <Card>
      <H2>Device check</H2>
      <Muted>
        Records which altitude sources this phone really has (barometer, GPS altitude), so every phone counts in sensor coverage,
        including phones without a barometer. Takes about 8 seconds; keep the phone still.
      </Muted>
      <View style={{ height: space.md }} />
      {running && progress ? (
        <View accessibilityLiveRegion="polite">
          <Body>{progress.step}</Body>
          <View style={st.track}>
            <View style={[st.fill, { width: `${Math.round(progress.fraction * 100)}%` }]} />
          </View>
          <Muted>
            Barometer samples: {progress.baroSamples} · GPS: {progress.gps}
          </Muted>
          <View style={{ height: space.md }} />
        </View>
      ) : null}
      {!running && last ? <DeviceCheckResult check={last} /> : null}
      {error ? <Text style={{ color: colors.bad, marginBottom: space.sm }}>{error}</Text> : null}
      <Button
        title={last ? 'Run device check again' : 'Run device check'}
        variant={last ? 'secondary' : 'primary'}
        onPress={start}
        busy={running}
        disabled={recordingInProgress}
      />
    </Card>
  );
}

export function DeviceCheckResult({ check }: { check: DeviceCheck }) {
  const v = deviceCheckVerdict(check);
  return (
    <View style={[st.result, { borderLeftColor: v.canRunBarometerTest ? colors.good : colors.warn }]}>
      <Text style={st.verdict}>{v.barometer}</Text>
      <Body>{v.gps}</Body>
      <Text style={[st.conclusion, { color: v.canRunBarometerTest ? colors.good : colors.warn }]}>{v.conclusion}</Text>
      <Muted>
        {check.deviceModel} · {check.platform} {check.osVersion} · {new Date(check.timestamp).toLocaleString()}
        {check.notes ? `\n${check.notes}` : ''}
      </Muted>
    </View>
  );
}

const st = StyleSheet.create({
  track: { height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden', marginVertical: space.sm },
  fill: { height: 8, backgroundColor: colors.primary },
  result: { borderLeftWidth: 4, paddingLeft: space.md, marginBottom: space.md },
  verdict: { fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 2 },
  conclusion: { fontSize: 16, fontWeight: '700', marginVertical: space.xs },
});
