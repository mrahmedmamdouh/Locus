import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import type { Venue } from '@locus/altitude-core';
import { useAppState } from '../state/AppState';
import { useSensors } from '../state/SensorContext';
import { buildCalibration } from '../logic/calibration';
import { makeId } from '../logic/ids';
import { fmt, parseDecimal } from '../logic/numbers';
import type { GpsFix, Session } from '../logic/types';
import { Banner, Body, Button, Card, Chip, Field, H2, Muted, Row, Stat } from '../ui/kit';
import { space } from '../ui/theme';

const BARO_MS = 10_000;
const GPS_TIMEOUT_MS = 15_000;

type Phase =
  | { kind: 'idle' }
  | { kind: 'baro'; secondsLeft: number; samples: number; pressure: number | null }
  | { kind: 'gps' };

/** Pick a venue, set the temperature, and calibrate at the entrance (starts a new session). */
export function CalibrationPanel(props: { initialVenueId: string | null; onCancel?: () => void }) {
  const { venues, settings, upsertSession, setActiveSession, updateSettings } = useAppState();
  const { baro, location, simHeightRef } = useSensors();
  const [venueId, setVenueId] = useState<string | null>(props.initialVenueId ?? venues[0]?.id ?? null);
  const [tempText, setTempText] = useState(String(settings.defaultTemperatureC));
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const skipGps = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      skipGps.current?.();
    };
  }, []);

  const venue: Venue | null = venues.find((v) => v.id === venueId) ?? null;
  const temperatureC = parseDecimal(tempText);
  const tempError = temperatureC === null || temperatureC < -40 || temperatureC > 60 ? 'Enter a temperature between -40 and 60 °C.' : null;
  const hasBaro = baro.status === 'available' || baro.status === 'simulated';
  const hasGps = settings.demoMode || location.permission === 'granted';
  const canCalibrate = !!venue && !tempError && phase.kind === 'idle' && (hasBaro || hasGps) && baro.status !== 'checking';

  const run = async () => {
    if (!venue || temperatureC === null) return;
    setError(null);
    simHeightRef.current = 0; // demo: the tester is at the entrance
    const startedMs = Date.now();
    let gpsSettled = false;
    const gpsPromise: Promise<GpsFix | null> = hasGps
      ? Promise.race([
          location.waitForFix(startedMs, GPS_TIMEOUT_MS),
          new Promise<null>((resolve) => {
            skipGps.current = () => resolve(null);
          }),
        ]).finally(() => {
          gpsSettled = true;
        })
      : Promise.resolve(null);

    const window = hasBaro
      ? await new Promise<Awaited<ReturnType<typeof baro.collect>>>((resolve) => {
          setPhase({ kind: 'baro', secondsLeft: BARO_MS / 1000, samples: 0, pressure: null });
          void baro
            .collect(BARO_MS, (count, latest) => {
              if (!mounted.current) return;
              const left = Math.max(0, Math.ceil((BARO_MS - (Date.now() - startedMs)) / 1000));
              setPhase({ kind: 'baro', secondsLeft: left, samples: count, pressure: latest?.pressure ?? null });
            })
            .then(resolve);
        })
      : { pressures: [], osRelAlts: [], epoch: null };
    if (!mounted.current) return;
    if (!gpsSettled) setPhase({ kind: 'gps' });
    const gps = await gpsPromise;
    skipGps.current = null;
    if (!mounted.current) return;

    try {
      const res = buildCalibration({ venueId: venue.id, baro: window, gps, temperatureC, now: new Date() });
      const session: Session = {
        id: makeId('s'),
        venueId: venue.id,
        venueName: venue.name,
        startedAt: res.calibration.timestamp,
        calibration: res.calibration,
        osRelAltBaselineM: res.osRelAltBaselineM,
        sensorEpoch: res.sensorEpoch,
        demo: settings.demoMode,
      };
      upsertSession(session);
      setActiveSession(session.id);
      updateSettings({ defaultTemperatureC: temperatureC });
      setPhase({ kind: 'idle' });
    } catch (e) {
      setError(
        e instanceof Error && /cannot calibrate/.test(e.message)
          ? 'No barometer data and no GPS fix. Move near the entrance doors for GPS, or use a phone with a barometer.'
          : e instanceof Error
            ? e.message
            : 'Calibration failed.',
      );
      setPhase({ kind: 'idle' });
    }
  };

  if (venues.length === 0) {
    return <Banner tone="info">Add a venue first (Venues tab), then come back to calibrate.</Banner>;
  }

  return (
    <Card>
      <H2>Calibrate at the entrance</H2>
      <Muted>
        Stand still at the main entrance (ground floor, this is 0 m). Hold the phone at chest height. Calibration takes 10 s of
        barometer readings plus a GPS fix if one is available (up to 15 s).
      </Muted>
      <View style={{ height: space.md }} />
      <Muted>Venue</Muted>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginVertical: space.sm }}>
        {venues.map((v) => (
          <Chip key={v.id} label={v.name} selected={v.id === venueId} onPress={() => phase.kind === 'idle' && setVenueId(v.id)} />
        ))}
      </View>
      <Field
        label="Indoor temperature (°C)"
        value={tempText}
        onChangeText={setTempText}
        keyboardType="numbers-and-punctuation"
        error={tempError}
        editable={phase.kind === 'idle'}
      />
      {!hasBaro && !hasGps && baro.status !== 'checking' ? (
        <Banner tone="bad">No barometer and no location permission: nothing to measure. Allow location or turn on Demo mode.</Banner>
      ) : null}
      {phase.kind === 'baro' ? (
        <Row>
          <Stat label="Time left" value={`${phase.secondsLeft} s`} big />
          <Stat label="Pressure" value={fmt(phase.pressure, 2, 'hPa')} sub={`${phase.samples} samples`} />
        </Row>
      ) : null}
      {phase.kind === 'gps' ? (
        <View style={{ marginBottom: space.md }}>
          <Body>Barometer done. Waiting for a GPS fix (up to 15 s)…</Body>
          <View style={{ height: space.sm }} />
          <Button title="Skip GPS" variant="secondary" onPress={() => skipGps.current?.()} />
        </View>
      ) : null}
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <Row>
        {props.onCancel && phase.kind === 'idle' ? (
          <Button title="Cancel" variant="secondary" onPress={props.onCancel} style={{ flex: 1 }} />
        ) : null}
        <Button
          title={phase.kind === 'idle' ? 'Calibrate at entrance' : 'Calibrating…'}
          onPress={() => void run()}
          disabled={!canCalibrate}
          busy={phase.kind !== 'idle'}
          big
          style={{ flex: 2 }}
        />
      </Row>
    </Card>
  );
}
