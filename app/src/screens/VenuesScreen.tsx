import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Venue } from '@locus/altitude-core';
import { useAppState } from '../state/AppState';
import { Banner, Body, Button, Card, H1, Muted } from '../ui/kit';
import { colors, space } from '../ui/theme';
import { VenueEditor } from './VenueEditor';
import { confirm } from '../ui/confirm';

export function VenuesScreen() {
  const { venues, readings, deleteVenue } = useAppState();
  const [editing, setEditing] = useState<Venue | 'new' | null>(null);

  if (editing) {
    return <VenueEditor venue={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />;
  }

  const onDelete = async (v: Venue) => {
    const n = readings.filter((r) => r.venueId === v.id).length;
    const ok = await confirm(
      `Delete ${v.name}?`,
      n > 0
        ? `Its ${n} saved reading(s) stay on the phone and in exports; only the venue setup is removed.`
        : 'The venue setup will be removed.',
      'Delete',
      true,
    );
    if (ok) deleteVenue(v.id);
  };

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg }}>
      <H1>Venues</H1>
      <Muted>Set up each mall once: its floors and their height bands relative to the entrance where you calibrate.</Muted>
      <View style={{ height: space.md }} />
      {venues.length === 0 ? (
        <Banner tone="info">No venues yet. Add the mall you are testing in.</Banner>
      ) : (
        [...venues]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((v) => {
            const sorted = [...v.floors].sort((a, b) => a.index - b.index);
            const n = readings.filter((r) => r.venueId === v.id).length;
            return (
              <Card key={v.id}>
                <Pressable onPress={() => setEditing(v)} accessibilityRole="button">
                  <Text style={s.name}>{v.name}</Text>
                  <Muted>
                    {v.city}, {v.country} · {v.floors.length} floors ({sorted[0]?.label} to {sorted[sorted.length - 1]?.label}) · {n} reading(s)
                  </Muted>
                </Pressable>
                <View style={s.actions}>
                  <Button title="Edit" variant="secondary" onPress={() => setEditing(v)} style={{ flex: 1 }} />
                  <Button title="Delete" variant="danger" onPress={() => void onDelete(v)} style={{ flex: 1 }} />
                </View>
              </Card>
            );
          })
      )}
      <Button title="Add venue" onPress={() => setEditing('new')} big />
      <View style={{ height: space.lg }} />
      <Body>Tip: measure the floor height if you can (count stair steps × step height). Malls are often 4.5–6 m.</Body>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  name: { fontSize: 18, fontWeight: '600', color: colors.text, marginBottom: 2 },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
});
