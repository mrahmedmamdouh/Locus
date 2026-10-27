import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Device from 'expo-device';
import { floorCenterM, type Floor, type Reading, type WifiScan, type WifiScanStatus } from '@locus/altitude-core';
import { useAppState } from '../state/AppState';
import { useSensors } from '../state/SensorContext';
import { useNow } from '../hooks/useNow';
import { liveEstimate } from '../logic/live';
import { buildReading, readingOutcome, type SourceOutcome } from '../logic/reading';
import { deviceModelLabel } from '../logic/device';
import { makeId } from '../logic/ids';
import { THROTTLE_TIP, WIFI_SCAN_TIMEOUT_MS, describeWifiScan, shouldShowThrottleTip, toWifiScan } from '../logic/wifi';
import { scanWifi, wifiScanSupported } from '../native/wifi';
import { fmt, fmtSigned } from '../logic/numbers';
import { DRIFT_WARNING_SECONDS, formatElapsed, secondsBetween } from '../logic/time';
import { Banner, Button, Card, Field, H1, H2, Muted, Row, Stat } from '../ui/kit';
import { colors, space } from '../ui/theme';
import { CalibrationPanel } from './CalibrationPanel';
import { SensorBanners } from './SensorBanners';

const RECORD_MS = 5_000;
const LIVE_WINDOW_MS = 2_000;

export function TestScreen() {
  const { activeSession, venues, setActiveSession, settings } = useAppState();
  const [recalibrating, setRecalibrating] = useState(false);
  const venue = activeSession ? (venues.find((v) => v.id === activeSession.venueId) ?? null) : null;

  useEffect(() => setRecalibrating(false), [activeSession?.id]);

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg }} keyboardShouldPersistTaps="handled">
      <H1>Floor test</H1>
      <SensorBanners />
      {activeSession && !venue ? (
        <Banner tone="warn">The venue of the active session was deleted. Start a new session.</Banner>
      ) : null}
      {activeSession && activeSession.demo !== settings.demoMode ? (
        <Banner tone="warn">
          Demo mode changed since this session was calibrated. Recalibrate so the baseline matches the current sensor.
        </Banner>
      ) : null}
      {!activeSession || !venue || recalibrating ? (
        <CalibrationPanel
          initialVenueId={activeSession?.venueId ?? null}
          onCancel={recalibrating ? () => setRecalibrating(false) : undefined}
        />
      ) : (
        <ActiveSession
          key={activeSession.id}
          onRecalibrate={() => setRecalibrating(true)}
          onEnd={() => setActiveSession(null)}
        />
      )}
    </ScrollView>
  );
}

function ActiveSession({ onRecalibrate, onEnd }: { onRecalibrate: () => void; onEnd: () => void }) {
  const { activeSession, venues, readings, addReading, settings, setRecordingInProgress } = useAppState();
  const { baro, location, simHeightRef } = useSensors();
  const now = useNow(1000);
  const session = activeSession!;
  const venue = venues.find((v) => v.id === session.venueId)!;
  const floorsTopDown = useMemo(() => [...venue.floors].sort((a, b) => b.index - a.index), [venue.floors]);

  const [trueFloor, setTrueFloor] = useState<Floor | null>(null);
  const [note, setNote] = useState('');
  const [recording, setRecording] = useState<{ secondsLeft: number; samples: number } | null>(null);
  const [last, setLast] = useState<Reading | null>(null);
  const [lastWifi, setLastWifi] = useState<WifiScan | null>(null);
  /** Wi-Fi statuses of this session's recordings, for the throttling tip. */
  const [wifiHistory, setWifiHistory] = useState<WifiScanStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  /** Synchronous guard: state updates are async, so a fast double tap could otherwise start two recordings. */
  const recordingRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (recordingRef.current) setRecordingInProgress(false);
    };
  }, [setRecordingInProgress]);

  // Demo mode: the simulated phone "moves" to the floor the tester selects.
  useEffect(() => {
    if (settings.demoMode && trueFloor) simHeightRef.current = floorCenterM(trueFloor);
  }, [settings.demoMode, trueFloor, simHeightRef]);

  const elapsed = secondsBetween(session.calibration.timestamp, now);
  const drifting = elapsed >= DRIFT_WARNING_SECONDS;
  const sessionCount = readings.filter((r) => r.sessionId === session.id).length;

  const live = liveEstimate({
    session,
    floors: venue.floors,
    pressures: baro.recent(LIVE_WINDOW_MS).map((s) => s.pressure),
    latestOsRelAlt: baro.latest?.osRelAlt ?? null,
    epoch: baro.epoch,
    gps: location.latest,
  });
  const baroUsable = session.calibration.baselinePressureHpa !== null && (baro.status === 'available' || baro.status === 'simulated');
  const gpsUsable = session.calibration.baselineGpsAltM !== null || location.latest !== null;
  const canRecord = !!trueFloor && !recording && (baroUsable || location.latest !== null);

  const record = async () => {
    if (!trueFloor || recordingRef.current) return;
    recordingRef.current = true;
    setRecordingInProgress(true);
    setError(null);
    setLast(null);
    setLastWifi(null);
    const start = Date.now();
    setRecording({ secondsLeft: RECORD_MS / 1000, samples: 0 });
    // Wi-Fi scan runs in parallel with the barometer window (Android only; never rejects).
    const wantWifi = wifiScanSupported && settings.recordWifi;
    const wifiPromise = wantWifi ? scanWifi(WIFI_SCAN_TIMEOUT_MS) : Promise.resolve(null);
    try {
      const windowPromise = baroUsable
        ? await baro.collect(RECORD_MS, (count) => {
            if (mounted.current) {
              setRecording({ secondsLeft: Math.max(0, Math.ceil((RECORD_MS - (Date.now() - start)) / 1000)), samples: count });
            }
          })
        : await new Promise<{ pressures: number[]; osRelAlts: number[]; epoch: string | null }>((resolve) =>
            setTimeout(() => resolve({ pressures: [], osRelAlts: [], epoch: null }), 1000),
          );
      const [window, rawWifi] = await Promise.all([windowPromise, wifiPromise]);
      const readingId = makeId('r');
      const now = new Date();
      const wifi = toWifiScan(
        rawWifi,
        {
          readingId,
          sessionId: session.id,
          venueId: venue.id,
          trueFloorIndex: trueFloor.index,
          scannedAt: new Date(start).toISOString(),
        },
        wifiScanSupported && !settings.recordWifi,
      );
      // Read the GPS fix AFTER the window from the ref (not the fix captured when Record was tapped);
      // buildReading only keeps it if it was taken during the window.
      const reading = buildReading({
        id: readingId,
        session,
        venue,
        trueFloor,
        baro: window,
        gps: location.getLatest(),
        windowStart: new Date(start),
        now,
        deviceModel: deviceModelLabel({ modelName: Device.modelName, brand: Device.brand, modelId: Device.modelId }),
        platform: Platform.OS,
        note,
        demo: settings.demoMode,
        wifi,
      });
      // Saved even if this screen unmounted meanwhile: a reading is never silently dropped.
      // The scan is stored only where Wi-Fi can be scanned (not for 'unsupported').
      addReading(reading, wifi.status === 'unsupported' ? null : wifi);
      if (mounted.current) {
        setLast(reading);
        setLastWifi(wifi);
        setWifiHistory((h) => [...h.slice(-9), wifi.status]);
        setNote('');
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Could not record the reading.');
    } finally {
      recordingRef.current = false;
      setRecordingInProgress(false);
      if (mounted.current) setRecording(null);
    }
  };

  return (
    <View>
      <Card>
        <Row>
          <View style={{ flex: 1 }}>
            <H2>{venue.name}</H2>
            <Muted>
              Calibrated {formatElapsed(elapsed)} ago · {session.calibration.temperatureC} °C · {sessionCount} reading(s)
            </Muted>
            <Muted>
              Baseline: {fmt(session.calibration.baselinePressureHpa, 2, 'hPa')} · GPS alt {fmt(session.calibration.baselineGpsAltM, 1, 'm')}
            </Muted>
          </View>
        </Row>
        <View style={{ height: space.md }} />
        {drifting ? (
          <Banner tone="warn">
            Over 20 minutes since calibration: weather and air-conditioning drift may grow. Walk back to the entrance and recalibrate.
          </Banner>
        ) : null}
        <Row>
          <Button title="Recalibrate" variant="secondary" onPress={onRecalibrate} style={{ flex: 1 }} disabled={!!recording} />
          <Button title="End session" variant="secondary" onPress={onEnd} style={{ flex: 1 }} disabled={!!recording} />
        </Row>
      </Card>

      <Card>
        <H2>Live</H2>
        <Row>
          <Stat
            label="Barometer height"
            value={baroUsable ? fmtSigned(live.baroRelAltM, 1, 'm') : 'n/a'}
            sub={baroUsable ? 'relative to entrance, 2 s median' : 'no barometer'}
            big
          />
          <Stat
            label="Estimated floor"
            value={live.baroFloor?.label ?? (live.baroRelAltM !== null && baroUsable ? 'Off table' : '—')}
            sub={live.baroFloor === null && live.baroRelAltM !== null && baroUsable ? 'off the floor table: recalibrate?' : 'from barometer'}
            big
          />
        </Row>
        <Row>
          {Platform.OS === 'ios' ? (
            <Stat label="iOS altimeter" value={fmtSigned(live.osRelAltM, 1, 'm')} sub="CoreMotion" />
          ) : null}
          <Stat
            label="GPS height"
            value={gpsUsable ? fmtSigned(live.gpsRelAltM, 1, 'm') : 'n/a'}
            sub={
              location.latest
                ? `±${fmt(location.latest.altitudeAccuracy, 0)} m vert · ±${fmt(location.latest.accuracy, 0)} m horiz · floor ${live.gpsFloor?.label ?? (live.gpsRelAltM !== null ? 'off the floor table' : '—')}`
                : 'waiting for fix'
            }
          />
        </Row>
        <Muted>Pressure now: {fmt(baro.latest?.pressure, 3, 'hPa')}</Muted>
      </Card>

      <Card>
        <H2>1. Which floor are you really on?</H2>
        <Muted>Check the mall signs. This is the ground truth.</Muted>
        <View style={st.floorGrid}>
          {floorsTopDown.map((f) => {
            const on = trueFloor?.index === f.index;
            return (
              <Pressable
                key={f.index}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`True floor ${f.label}`}
                onPress={() => !recording && setTrueFloor(f)}
                style={[st.floorBtn, on && st.floorBtnOn]}
              >
                <Text style={[st.floorText, on && { color: colors.primaryText }]}>{f.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <H2>2. Note (optional)</H2>
        <Field label="Where exactly? e.g. near escalator, atrium, shop name" value={note} onChangeText={setNote} editable={!recording} />
        <H2>3. Record</H2>
        <Muted>Stand still for 5 seconds while recording.</Muted>
        <View style={{ height: space.sm }} />
        {error ? <Banner tone="bad">{error}</Banner> : null}
        <Button
          title={recording ? `Recording… ${recording.secondsLeft} s (${recording.samples} samples)` : trueFloor ? `Record on floor ${trueFloor.label}` : 'Select the true floor first'}
          onPress={() => void record()}
          disabled={!canRecord && !recording}
          big
        />
      </Card>

      {last ? <ResultCard reading={last} floors={venue.floors} wifi={lastWifi} wifiHistory={wifiHistory} /> : null}
    </View>
  );
}

function ResultCard({
  reading,
  floors,
  wifi,
  wifiHistory,
}: {
  reading: Reading;
  floors: Floor[];
  wifi: WifiScan | null;
  wifiHistory: WifiScanStatus[];
}) {
  const o = readingOutcome(reading, floors);
  const primary = o.baro.correct !== null ? o.baro : o.gps;
  const tone = primary.correct === null ? 'neutral' : primary.correct ? 'good' : 'bad';
  const bg = tone === 'good' ? colors.goodBg : tone === 'bad' ? colors.badBg : colors.card;
  const fg = tone === 'good' ? colors.good : tone === 'bad' ? colors.bad : colors.text;
  return (
    <Card style={{ backgroundColor: bg, borderColor: fg }}>
      <Text style={[st.resultTitle, { color: fg }]}>
        {primary.correct === null ? 'Saved (no estimate)' : primary.correct ? 'Correct floor' : 'Wrong floor'}
      </Text>
      <Muted>True floor {reading.trueFloorLabel} (centre {fmt(reading.trueFloorCenterM, 1, 'm')})</Muted>
      <SourceLine name="Barometer" o={o.baro} />
      <SourceLine name="GPS" o={o.gps} />
      {reading.osRelAltM !== null ? <SourceLine name="iOS altimeter" o={o.os} /> : null}
      {wifi && wifi.status !== 'unsupported' ? <Text style={st.wifiLine}>Wi-Fi: {describeWifiScan(wifi)}</Text> : null}
      {wifi?.status === 'location-off' ? (
        <Banner tone="warn">Android needs Location turned on to scan Wi-Fi. Turn Location on in the quick settings.</Banner>
      ) : null}
      {wifi?.status === 'no-permission' ? (
        <Banner tone="warn">Wi-Fi scanning needs the precise location permission. Allow it in Android settings for Locus.</Banner>
      ) : null}
      {wifi?.status === 'wifi-off' ? <Banner tone="warn">Turn Wi-Fi on (you do not need to connect to a network).</Banner> : null}
      {shouldShowThrottleTip(wifiHistory) ? <Banner tone="warn">{THROTTLE_TIP}</Banner> : null}
      <Muted>
        {reading.sampleCount} barometer samples · saved {new Date(reading.timestamp).toLocaleTimeString()}
      </Muted>
    </Card>
  );
}

function SourceLine({ name, o }: { name: string; o: SourceOutcome }) {
  const color = o.correct === null ? colors.muted : o.correct ? colors.good : colors.bad;
  return (
    <Text style={[st.sourceLine, { color }]}>
      {name}:{' '}
      {o.offTable
        ? `Off the floor table · error ${fmtSigned(o.errorM, 2, 'm')}`
        : o.estFloorLabel === null
          ? 'no data'
          : `floor ${o.estFloorLabel} · error ${fmtSigned(o.errorM, 2, 'm')}`}
      {o.correct === null ? '' : o.correct ? '  ✓' : '  ✗'}
    </Text>
  );
}

const st = StyleSheet.create({
  floorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginVertical: space.md },
  floorBtn: {
    minWidth: 72,
    minHeight: 64,
    paddingHorizontal: space.md,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  floorBtnOn: { backgroundColor: colors.selected, borderColor: colors.selected },
  floorText: { fontSize: 24, fontWeight: '700', color: colors.text },
  resultTitle: { fontSize: 24, fontWeight: '700', marginBottom: space.xs },
  sourceLine: { fontSize: 17, fontWeight: '600', marginVertical: 2 },
  wifiLine: { fontSize: 15, color: colors.text, marginVertical: 4 },
});
