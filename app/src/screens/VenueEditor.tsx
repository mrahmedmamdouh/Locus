import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import { typicalFloorHeightM, type Venue } from '@locus/altitude-core';
import { useAppState } from '../state/AppState';
import { useSensors } from '../state/SensorContext';
import { makeId } from '../logic/ids';
import { DEFAULT_BOUNDARY_RADIUS_M, parseBoundary } from '../logic/autoMode';
import { parseDecimal } from '../logic/numbers';
import {
  DEFAULT_FLOOR_HEIGHT_M,
  buildDrafts,
  floorHeightMismatch,
  floorsToDrafts,
  rescaleDrafts,
  venueProblems,
  type FloorDraft,
} from '../logic/venueDraft';
import { Banner, Button, Card, Chip, Field, H1, H2, Muted, Row } from '../ui/kit';
import { colors, space } from '../ui/theme';

const COUNTRIES = [
  { code: 'EG', label: 'Egypt' },
  { code: 'OM', label: 'Oman' },
];

export function VenueEditor({ venue, onDone }: { venue: Venue | null; onDone: () => void }) {
  const { upsertVenue } = useAppState();
  const { location } = useSensors();
  const [name, setName] = useState(venue?.name ?? '');
  const [city, setCity] = useState(venue?.city ?? '');
  const [country, setCountry] = useState(venue?.country ?? 'EG');
  const [below, setBelow] = useState('1');
  const [above, setAbove] = useState('2');
  const [height, setHeight] = useState(String((venue && typicalFloorHeightM(venue.floors)) ?? DEFAULT_FLOOR_HEIGHT_M));
  const [heightError, setHeightError] = useState<string | null>(null);
  const [lat, setLat] = useState(venue?.boundary ? String(venue.boundary.lat) : '');
  const [lon, setLon] = useState(venue?.boundary ? String(venue.boundary.lon) : '');
  const [radius, setRadius] = useState(String(venue?.boundary?.radiusM ?? DEFAULT_BOUNDARY_RADIUS_M));
  const [entrance, setEntrance] = useState<number>(venue?.entranceFloorIndex ?? 0);
  const [locating, setLocating] = useState(false);
  const [locateMsg, setLocateMsg] = useState<string | null>(null);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<FloorDraft[]>(() => {
    if (venue) return floorsToDrafts(venue.floors);
    return buildDrafts('1', '2', String(DEFAULT_FLOOR_HEIGHT_M)).drafts ?? [];
  });
  const [triedSave, setTriedSave] = useState(false);

  const check = useMemo(() => venueProblems({ name, city, country, floors: drafts }), [name, city, country, drafts]);
  const boundaryCheck = useMemo(() => parseBoundary(lat, lon, radius, parseDecimal), [lat, lon, radius]);
  const entranceProblem = drafts.some((d) => d.index === entrance) ? null : 'Entrance floor is not in the floor table.';
  const allProblems = [...check.problems, ...boundaryCheck.problems, ...(entranceProblem ? [entranceProblem] : [])];
  const mismatch = useMemo(() => floorHeightMismatch(drafts, height), [drafts, height]);
  const floorProblems = useMemo(
    () => venueProblems({ name: 'x', city: 'x', country: 'x', floors: drafts }).problems,
    [drafts],
  );

  const rebuild = () => {
    const res = buildDrafts(below, above, height);
    setBuilderError(res.error);
    if (res.drafts) setDrafts(res.drafts);
  };

  const applyHeight = () => {
    const res = rescaleDrafts(drafts, height);
    setHeightError(res.error);
    if (res.drafts) setDrafts(res.drafts);
  };

  const fillFromCurrentLocation = async () => {
    setLocating(true);
    setLocateMsg(null);
    try {
      let fix = location.getLatest();
      if (!fix || Date.now() - fix.timestamp > 30_000) {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (!perm.granted) throw new Error('Location permission is needed to use your current location.');
        const l = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        fix = { latitude: l.coords.latitude, longitude: l.coords.longitude, altitude: l.coords.altitude, accuracy: l.coords.accuracy, altitudeAccuracy: l.coords.altitudeAccuracy, timestamp: l.timestamp };
      }
      setLat(fix.latitude.toFixed(6));
      setLon(fix.longitude.toFixed(6));
      setLocateMsg(`Set from GPS (±${fix.accuracy !== null ? Math.round(fix.accuracy) : '?'} m). Stand near the middle of the mall for the best centre.`);
    } catch (e) {
      setLocateMsg(e instanceof Error ? e.message : 'Could not get your location.');
    } finally {
      setLocating(false);
    }
  };

  const editDraft = (index: number, patch: Partial<FloorDraft>) =>
    setDrafts((list) => list.map((d) => (d.index === index ? { ...d, ...patch } : d)));

  const save = () => {
    setTriedSave(true);
    if (!check.floors || allProblems.length > 0) return;
    upsertVenue({
      ...(venue ?? {}),
      id: venue?.id ?? makeId('v'),
      name: name.trim(),
      city: city.trim(),
      country,
      floors: check.floors,
      boundary: boundaryCheck.boundary,
      entranceFloorIndex: entrance,
    });
    onDone();
  };

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg }} keyboardShouldPersistTaps="handled">
      <H1>{venue ? 'Edit venue' : 'New venue'}</H1>
      <Card>
        <Field label="Venue name" value={name} onChangeText={setName} placeholder="e.g. City Stars" error={triedSave && !name.trim() ? 'Required' : null} />
        <Field label="City" value={city} onChangeText={setCity} placeholder="e.g. Cairo" error={triedSave && !city.trim() ? 'Required' : null} />
        <Text style={st.label}>Country</Text>
        <Row>
          {COUNTRIES.map((c) => (
            <Chip key={c.code} label={`${c.label} (${c.code})`} selected={country === c.code} onPress={() => setCountry(c.code)} />
          ))}
        </Row>
      </Card>

      <Card style={st.heightCard}>
        <H2>Floor height (m)</H2>
        <Text style={st.hint}>Measure it: ride one escalator up and read the live height.</Text>
        <TextInput
          style={st.heightInput}
          value={height}
          onChangeText={setHeight}
          keyboardType="decimal-pad"
          accessibilityLabel="Floor height in metres"
        />
        {heightError ? <Banner tone="bad">{heightError}</Banner> : null}
        {mismatch ? <Banner tone="warn">The floor table below does not use this height yet. Tap "Apply to floor table".</Banner> : null}
        <Button title="Apply to floor table (keeps labels)" variant={mismatch ? 'primary' : 'secondary'} onPress={applyHeight} />
      </Card>

      <Card>
        <H2>Quick floor builder</H2>
        <Muted>Entrance level is "G" at 0 m. Uses the floor height above. Each floor gets a band of ± half the floor height around its centre.</Muted>
        <View style={{ height: space.md }} />
        <Row>
          <Field label="Basements" value={below} onChangeText={setBelow} keyboardType="number-pad" />
          <Field label="Floors above G" value={above} onChangeText={setAbove} keyboardType="number-pad" />
        </Row>
        {builderError ? <Banner tone="bad">{builderError}</Banner> : null}
        <Button title="Build floor table" variant="secondary" onPress={rebuild} />
      </Card>

      <Card>
        <H2>Floors (top to bottom)</H2>
        <Muted>Edit labels to match the mall signs. zMin/zMax are meters relative to the entrance.</Muted>
        <View style={st.headerRow}>
          <Text style={[st.th, { width: 44 }]}>Index</Text>
          <Text style={[st.th, { flex: 1.2 }]}>Label</Text>
          <Text style={[st.th, { flex: 1 }]}>zMin m</Text>
          <Text style={[st.th, { flex: 1 }]}>zMax m</Text>
        </View>
        {drafts.map((d) => (
          <View key={d.index} style={st.row}>
            <Text style={[st.idx, { width: 44 }]}>{d.index}</Text>
            <TextInput style={[st.cell, { flex: 1.2 }]} value={d.label} onChangeText={(t) => editDraft(d.index, { label: t })} accessibilityLabel={`Label for floor index ${d.index}`} />
            <TextInput style={[st.cell, { flex: 1 }]} value={d.zMin} keyboardType="numbers-and-punctuation" onChangeText={(t) => editDraft(d.index, { zMin: t })} accessibilityLabel={`Bottom of floor ${d.label}`} />
            <TextInput style={[st.cell, { flex: 1 }]} value={d.zMax} keyboardType="numbers-and-punctuation" onChangeText={(t) => editDraft(d.index, { zMax: t })} accessibilityLabel={`Top of floor ${d.label}`} />
          </View>
        ))}
        {floorProblems.length > 0 ? (
          <View style={{ marginTop: space.md }}>
            <Banner tone="bad">{floorProblems.join('\n')}</Banner>
          </View>
        ) : (
          <Text style={st.ok}>Floor table is valid.</Text>
        )}
      </Card>

      <Card>
        <H2>Entrance floor</H2>
        <Muted>Which floor are the main entrances on? Auto mode assumes you are on this floor when you cross the mall boundary.</Muted>
        <View style={st.chips}>
          {drafts.map((d) => (
            <Chip key={d.index} label={d.label || String(d.index)} selected={entrance === d.index} onPress={() => setEntrance(d.index)} />
          ))}
        </View>
        {entranceProblem ? <Banner tone="bad">{entranceProblem}</Banner> : null}
      </Card>

      <Card>
        <H2>Mall boundary (Auto mode)</H2>
        <Muted>A circle around the mall. Entering it triggers the automatic entrance baseline. Leave empty if you do not use Auto mode.</Muted>
        <View style={{ height: space.md }} />
        <Button title={locating ? 'Locating…' : 'Use my current location'} variant="secondary" onPress={() => void fillFromCurrentLocation()} busy={locating} />
        {locateMsg ? <Muted>{locateMsg}</Muted> : null}
        <View style={{ height: space.md }} />
        <Row>
          <Field label="Centre latitude" value={lat} onChangeText={setLat} keyboardType="numbers-and-punctuation" placeholder="e.g. 23.5880" />
          <Field label="Centre longitude" value={lon} onChangeText={setLon} keyboardType="numbers-and-punctuation" placeholder="e.g. 58.3830" />
        </Row>
        <Field label="Radius (m)" value={radius} onChangeText={setRadius} keyboardType="number-pad" />
        {boundaryCheck.problems.length > 0 ? <Banner tone="bad">{boundaryCheck.problems.join('\n')}</Banner> : null}
      </Card>

      {triedSave && allProblems.length > 0 ? <Banner tone="bad">Fix before saving:{'\n'}{allProblems.join('\n')}</Banner> : null}
      <Row>
        <Button title="Cancel" variant="secondary" onPress={onDone} style={{ flex: 1 }} />
        <Button title="Save venue" onPress={save} disabled={allProblems.length > 0} style={{ flex: 2 }} />
      </Row>
      <View style={{ height: space.xl }} />
    </ScrollView>
  );
}

const st = StyleSheet.create({
  label: { fontSize: 13, color: colors.muted, marginBottom: space.xs, fontWeight: '500' },
  headerRow: { flexDirection: 'row', gap: space.sm, marginTop: space.md, marginBottom: space.xs },
  th: { fontSize: 12, color: colors.muted, fontWeight: '600' },
  row: { flexDirection: 'row', gap: space.sm, alignItems: 'center', marginBottom: space.sm },
  idx: { fontSize: 15, color: colors.muted, textAlign: 'center', fontVariant: ['tabular-nums'] },
  cell: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: space.sm,
    paddingVertical: 8,
    fontSize: 16,
    color: colors.text,
  },
  ok: { color: colors.good, marginTop: space.md, fontSize: 14 },
  heightCard: { borderColor: colors.primary, borderWidth: 2 },
  hint: { fontSize: 15, color: colors.text, marginBottom: space.sm, fontWeight: '500' },
  heightInput: {
    borderWidth: 2,
    borderColor: colors.primary,
    borderRadius: 10,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    fontSize: 32,
    fontWeight: '700',
    color: colors.text,
    marginBottom: space.md,
    fontVariant: ['tabular-nums'],
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
});
