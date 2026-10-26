import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Venue } from '@locus/altitude-core';
import { useAppState } from '../state/AppState';
import { makeId } from '../logic/ids';
import {
  DEFAULT_FLOOR_HEIGHT_M,
  buildDrafts,
  floorsToDrafts,
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
  const [name, setName] = useState(venue?.name ?? '');
  const [city, setCity] = useState(venue?.city ?? '');
  const [country, setCountry] = useState(venue?.country ?? 'EG');
  const [below, setBelow] = useState('1');
  const [above, setAbove] = useState('2');
  const [height, setHeight] = useState(String(DEFAULT_FLOOR_HEIGHT_M));
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<FloorDraft[]>(() => {
    if (venue) return floorsToDrafts(venue.floors);
    return buildDrafts('1', '2', String(DEFAULT_FLOOR_HEIGHT_M)).drafts ?? [];
  });
  const [triedSave, setTriedSave] = useState(false);

  const check = useMemo(() => venueProblems({ name, city, country, floors: drafts }), [name, city, country, drafts]);
  const floorProblems = useMemo(
    () => venueProblems({ name: 'x', city: 'x', country: 'x', floors: drafts }).problems,
    [drafts],
  );

  const rebuild = () => {
    const res = buildDrafts(below, above, height);
    setBuilderError(res.error);
    if (res.drafts) setDrafts(res.drafts);
  };

  const editDraft = (index: number, patch: Partial<FloorDraft>) =>
    setDrafts((list) => list.map((d) => (d.index === index ? { ...d, ...patch } : d)));

  const save = () => {
    setTriedSave(true);
    if (!check.floors || check.problems.length > 0) return;
    upsertVenue({
      ...(venue ?? {}),
      id: venue?.id ?? makeId('v'),
      name: name.trim(),
      city: city.trim(),
      country,
      floors: check.floors,
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

      <Card>
        <H2>Quick floor builder</H2>
        <Muted>Entrance level is "G" at 0 m. Each floor gets a band of ± half the floor height around its centre.</Muted>
        <View style={{ height: space.md }} />
        <Row>
          <Field label="Basements" value={below} onChangeText={setBelow} keyboardType="number-pad" />
          <Field label="Floors above G" value={above} onChangeText={setAbove} keyboardType="number-pad" />
          <Field label="Floor height (m)" value={height} onChangeText={setHeight} keyboardType="decimal-pad" />
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

      {triedSave && check.problems.length > 0 ? <Banner tone="bad">Fix before saving:{'\n'}{check.problems.join('\n')}</Banner> : null}
      <Row>
        <Button title="Cancel" variant="secondary" onPress={onDone} style={{ flex: 1 }} />
        <Button title="Save venue" onPress={save} disabled={check.problems.length > 0} style={{ flex: 2 }} />
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
});
