import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AppStateProvider, useAppState } from './src/state/AppState';
import { SensorProvider } from './src/state/SensorContext';
import { TestScreen } from './src/screens/TestScreen';
import { VenuesScreen } from './src/screens/VenuesScreen';
import { DataScreen } from './src/screens/DataScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { Banner } from './src/ui/kit';
import { colors, space } from './src/ui/theme';

type Tab = 'test' | 'venues' | 'data' | 'settings';
const TABS: { key: Tab; label: string }[] = [
  { key: 'test', label: 'Test' },
  { key: 'venues', label: 'Venues' },
  { key: 'data', label: 'Data' },
  { key: 'settings', label: 'Settings' },
];

export default function App() {
  return (
    <SafeAreaProvider>
      <AppStateProvider>
        <Root />
      </AppStateProvider>
    </SafeAreaProvider>
  );
}

function Root() {
  const { ready, settings, storageError, venues } = useAppState();
  const [tab, setTab] = useState<Tab | null>(null);
  if (!ready) {
    return (
      <View style={[st.fill, st.center, { padding: space.lg }]}>
        {storageError ? <Banner tone="bad">{storageError}</Banner> : <ActivityIndicator size="large" color={colors.primary} />}
      </View>
    );
  }
  const current: Tab = tab ?? (venues.length === 0 ? 'venues' : 'test');
  return (
    <SensorProvider demo={settings.demoMode}>
      <SafeAreaView style={st.fill} edges={['top', 'left', 'right']}>
        <StatusBar style="dark" />
        {storageError ? (
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>
            <Banner tone="bad">{storageError}</Banner>
          </View>
        ) : null}
        <View style={st.fill}>
          {current === 'test' ? <TestScreen /> : null}
          {current === 'venues' ? <VenuesScreen /> : null}
          {current === 'data' ? <DataScreen /> : null}
          {current === 'settings' ? <SettingsScreen /> : null}
        </View>
      </SafeAreaView>
      <SafeAreaView edges={['bottom']} style={st.tabBar}>
        <View style={st.tabRow} accessibilityRole="tablist">
          {TABS.map((t) => {
            const on = t.key === current;
            return (
              <Pressable
                key={t.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => setTab(t.key)}
                style={st.tab}
              >
                <Text style={[st.tabText, on && st.tabTextOn]}>{t.label}</Text>
                {t.key === 'settings' && settings.demoMode ? <Text style={st.demo}>DEMO</Text> : null}
              </Pressable>
            );
          })}
        </View>
      </SafeAreaView>
    </SensorProvider>
  );
}

const st = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  tabBar: { backgroundColor: colors.card, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  tabRow: { flexDirection: 'row' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 56 },
  tabText: { fontSize: 15, color: colors.muted, fontWeight: '600' },
  tabTextOn: { color: colors.primary },
  demo: { fontSize: 10, color: colors.warn, fontWeight: '700' },
});
