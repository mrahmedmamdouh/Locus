import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { summarize, typicalFloorHeightM, type AccuracySummary, type DeviceCheck, type Reading } from '@locus/altitude-core';
import { useAppState } from '../state/AppState';
import { exportDeviceChecksCsv, exportReadingsCsv } from '../logic/export';
import { deviceCheckVerdict } from '../logic/deviceCheck';
import { DEFAULT_FLOOR_HEIGHT_M } from '../logic/venueDraft';
import { fmt, fmtPct, fmtSigned } from '../logic/numbers';
import { Banner, Button, Card, Chip, H1, H2, Muted, Row } from '../ui/kit';
import { colors, space } from '../ui/theme';
import { confirm, notify } from '../ui/confirm';

type Scope = 'session' | 'all';

export function DataScreen() {
  const { readings, activeSession, venues, deleteReading, clearReadings, deviceChecks, deleteDeviceCheck } = useAppState();
  const [scope, setScope] = useState<Scope>(activeSession ? 'session' : 'all');
  const [busy, setBusy] = useState(false);

  const effectiveScope: Scope = activeSession ? scope : 'all';
  const list = useMemo(
    () =>
      (effectiveScope === 'session' && activeSession ? readings.filter((r) => r.sessionId === activeSession.id) : readings)
        .slice()
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    [readings, effectiveScope, activeSession],
  );

  /** Accuracy per venue (floor height differs per venue, so summaries are per venue). */
  const byVenue = useMemo(() => {
    const groups = new Map<string, Reading[]>();
    for (const r of list) {
      const g = groups.get(r.venueId);
      if (g) g.push(r);
      else groups.set(r.venueId, [r]);
    }
    return [...groups.entries()].map(([venueId, rs]) => {
      const venue = venues.find((v) => v.id === venueId);
      const h = (venue && typicalFloorHeightM(venue.floors)) ?? DEFAULT_FLOOR_HEIGHT_M;
      return {
        venueId,
        name: venue?.name ?? rs[0]!.venueName,
        n: rs.length,
        floorHeightM: h,
        baro: summarize(rs, 'baro', h),
        gps: summarize(rs, 'gps', h),
      };
    });
  }, [list, venues]);

  const doExport = async (rows: Reading[], label: string) => {
    if (rows.length === 0) {
      notify('Nothing to export', 'There are no readings yet.');
      return;
    }
    setBusy(true);
    try {
      await exportReadingsCsv(rows, label);
    } catch (e) {
      notify('Export failed', e instanceof Error ? e.message : 'Unknown error.');
    } finally {
      setBusy(false);
    }
  };

  const doExportChecks = async () => {
    if (deviceChecks.length === 0) {
      notify('Nothing to export', 'No device checks yet. Run one in Settings.');
      return;
    }
    setBusy(true);
    try {
      await exportDeviceChecksCsv(deviceChecks);
    } catch (e) {
      notify('Export failed', e instanceof Error ? e.message : 'Unknown error.');
    } finally {
      setBusy(false);
    }
  };

  const onDeleteCheck = async (c: DeviceCheck) => {
    const ok = await confirm('Delete device check?', `${c.deviceModel} at ${new Date(c.timestamp).toLocaleString()}`, 'Delete', true);
    if (ok) deleteDeviceCheck(c.id);
  };

  const checksNewestFirst = useMemo(
    () => deviceChecks.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    [deviceChecks],
  );

  const onClear = async () => {
    const ok = await confirm(
      'Delete ALL readings?',
      `This permanently deletes ${readings.length} reading(s) from this phone. Export first if you need them.`,
      'Delete all',
      true,
    );
    if (ok) clearReadings();
  };

  const onDelete = async (r: Reading) => {
    const ok = await confirm('Delete reading?', `Floor ${r.trueFloorLabel} at ${new Date(r.timestamp).toLocaleTimeString()}`, 'Delete', true);
    if (ok) deleteReading(r.id);
  };

  const sessionLabel = activeSession ? activeSession.venueName : 'session';

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg }}>
      <H1>Data</H1>
      <Muted>Readings stay on this phone until you export them as CSV and share (e.g. to Drive, email or WhatsApp).</Muted>
      <View style={{ height: space.md }} />
      {activeSession ? (
        <Row>
          <Chip label="Current session" selected={effectiveScope === 'session'} onPress={() => setScope('session')} />
          <Chip label={`All sessions (${readings.length})`} selected={effectiveScope === 'all'} onPress={() => setScope('all')} />
        </Row>
      ) : null}
      <View style={{ height: space.md }} />

      <Card>
        <H2>{list.length} reading(s)</H2>
        {byVenue.length === 0 ? <Muted>No readings yet. Record some on the Test tab.</Muted> : null}
        {byVenue.map((g) => (
          <View key={g.venueId} style={st.venueBlock}>
            <Text style={st.venueName}>
              {g.name} · {g.n} reading(s)
            </Text>
            <SummaryLine name="Barometer" s={g.baro} />
            <SummaryLine name="GPS" s={g.gps} />
            <Muted>“Within ½ floor” uses a {fmt(g.floorHeightM, 1)} m floor height.</Muted>
          </View>
        ))}
      </Card>

      <Card>
        <H2>Export CSV</H2>
        {effectiveScope === 'session' && activeSession ? (
          <Button
            title={`Export this session (${list.length})`}
            onPress={() => void doExport(list, sessionLabel)}
            busy={busy}
            disabled={list.length === 0}
          />
        ) : null}
        <View style={{ height: space.sm }} />
        <Button
          title={`Export all (${readings.length})`}
          variant={effectiveScope === 'session' ? 'secondary' : 'primary'}
          onPress={() => void doExport(readings, 'all')}
          busy={busy}
          disabled={readings.length === 0}
        />
        <View style={{ height: space.sm }} />
        <Button
          title={`Export device checks (${deviceChecks.length})`}
          variant="secondary"
          onPress={() => void doExportChecks()}
          busy={busy}
          disabled={deviceChecks.length === 0}
        />
        <View style={{ height: space.sm }} />
        <Muted>Readings and device checks are separate files; share both with the team.</Muted>
      </Card>

      <Card>
        <H2>Device checks ({deviceChecks.length})</H2>
        {deviceChecks.length === 0 ? <Muted>No device checks yet. Run one in Settings (takes ~8 s).</Muted> : null}
        {checksNewestFirst.map((c) => (
          <DeviceCheckRow key={c.id} c={c} onDelete={() => void onDeleteCheck(c)} />
        ))}
      </Card>

      {list.length > 0 ? <H2>Readings (newest first)</H2> : null}
      {list.map((r) => (
        <ReadingRow key={r.id} r={r} onDelete={() => void onDelete(r)} />
      ))}

      {readings.length > 0 ? (
        <View style={{ marginTop: space.lg }}>
          <Banner tone="warn">Clearing deletes every reading from every session on this phone.</Banner>
          <Button title="Clear all readings" variant="danger" onPress={() => void onClear()} />
        </View>
      ) : null}
      <View style={{ height: space.xl }} />
    </ScrollView>
  );
}

function SummaryLine({ name, s }: { name: string; s: AccuracySummary }) {
  if (s.n === 0) return <Text style={st.summary}>{name}: no data</Text>;
  return (
    <Text style={st.summary}>
      {name}: <Text style={{ fontWeight: '700' }}>{fmtPct(s.floorAccuracy)}</Text> correct floor (n={s.n}) · median |err|{' '}
      {fmt(s.medianAbsErrorM, 2, 'm')} · p90 {fmt(s.p90AbsErrorM, 2, 'm')} · within ½ floor {fmtPct(s.withinHalfFloor)}
    </Text>
  );
}

function DeviceCheckRow({ c, onDelete }: { c: DeviceCheck; onDelete: () => void }) {
  const v = deviceCheckVerdict(c);
  return (
    <View style={[st.row, { borderLeftColor: v.canRunBarometerTest ? colors.good : colors.warn, backgroundColor: colors.bg }]}>
      <View style={{ flex: 1 }}>
        <Text style={st.rowTitle}>
          {c.deviceModel} · {v.barometer}
        </Text>
        <Muted>
          {v.gps} · {v.conclusion}
          {'\n'}
          {new Date(c.timestamp).toLocaleString()} · {c.platform} {c.osVersion}
          {c.notes ? ` · ${c.notes}` : ''}
        </Muted>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Delete device check" onPress={onDelete} style={st.del} hitSlop={8}>
        <Text style={{ color: colors.bad, fontWeight: '600' }}>Delete</Text>
      </Pressable>
    </View>
  );
}

function ReadingRow({ r, onDelete }: { r: Reading; onDelete: () => void }) {
  // A barometer height off the floor table counts as wrong; no barometer height = no verdict.
  const ok = r.baroRelAltM === null ? null : r.estFloorIndexBaro === r.trueFloorIndex;
  const err = r.baroRelAltM === null ? null : r.baroRelAltM - r.trueFloorCenterM;
  const gpsErr = r.gpsRelAltM === null ? null : r.gpsRelAltM - r.trueFloorCenterM;
  return (
    <View style={[st.row, { borderLeftColor: ok === null ? colors.border : ok ? colors.good : colors.bad }]}>
      <View style={{ flex: 1 }}>
        <Text style={st.rowTitle}>
          True {r.trueFloorLabel} · baro est {r.estFloorIndexBaro ?? (r.baroRelAltM !== null ? 'off table' : '—')} ({fmtSigned(err, 2, 'm')}) · GPS est {r.estFloorIndexGps ?? (r.gpsRelAltM !== null ? 'off table' : '—')} (
          {fmtSigned(gpsErr, 1, 'm')})
        </Text>
        <Muted>
          {new Date(r.timestamp).toLocaleString()} · {r.venueName} · {Math.round(r.secondsSinceCalibration / 60)} min after calibration
          {r.notes ? ` · ${r.notes}` : ''}
        </Muted>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Delete reading" onPress={onDelete} style={st.del} hitSlop={8}>
        <Text style={{ color: colors.bad, fontWeight: '600' }}>Delete</Text>
      </Pressable>
    </View>
  );
}

const st = StyleSheet.create({
  venueBlock: { marginTop: space.sm, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  venueName: { fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: 2 },
  summary: { fontSize: 14, color: colors.text, lineHeight: 20, marginVertical: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 8,
    padding: space.md,
    marginBottom: space.sm,
    borderLeftWidth: 4,
  },
  rowTitle: { fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 2 },
  del: { paddingHorizontal: space.sm, paddingVertical: space.sm },
});
