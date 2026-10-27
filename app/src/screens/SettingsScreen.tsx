import { Platform, ScrollView, Switch, Text, View } from 'react-native';
import * as Device from 'expo-device';
import { useAppState } from '../state/AppState';
import { deviceModelLabel } from '../logic/device';
import { useSensors } from '../state/SensorContext';
import { wifiScanSupported } from '../native/wifi';
import { DeviceCheckCard } from './DeviceCheckCard';
import { Body, Card, H1, H2, Muted } from '../ui/kit';
import { colors, space } from '../ui/theme';

export function SettingsScreen() {
  const { settings, updateSettings, readings, sessions, deviceChecks, wifiScans } = useAppState();
  const { baro, location } = useSensors();
  const hw = baro.hardwareAvailable === null ? 'checking…' : baro.hardwareAvailable ? 'yes' : 'no';
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg }}>
      <H1>Settings</H1>
      <DeviceCheckCard />
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
          <View style={{ flex: 1 }}>
            <H2>Demo mode</H2>
            <Muted>
              Simulates pressure and GPS for web, simulators and training. Selecting a true floor moves the simulated phone there.
              Readings are prefixed "DEMO" in notes. Recalibrate after switching.
            </Muted>
          </View>
          <Switch
            value={settings.demoMode}
            onValueChange={(v) => updateSettings({ demoMode: v })}
            trackColor={{ true: colors.primary, false: colors.border }}
            accessibilityLabel="Demo mode"
          />
        </View>
      </Card>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
          <View style={{ flex: 1 }}>
            <H2>Record Wi-Fi scans</H2>
            <Muted>
              {wifiScanSupported
                ? 'Saves nearby access points (MAC address and signal, never network names) with each reading, to test Wi-Fi floor detection.'
                : Platform.OS === 'ios'
                  ? 'Not available on iPhone: iOS does not let apps scan Wi-Fi.'
                  : 'Not available in this build (needs the Locus Android app, not Expo Go or web).'}
            </Muted>
          </View>
          <Switch
            value={wifiScanSupported && settings.recordWifi}
            onValueChange={(v) => updateSettings({ recordWifi: v })}
            disabled={!wifiScanSupported}
            trackColor={{ true: colors.primary, false: colors.border }}
            accessibilityLabel="Record Wi-Fi scans"
          />
        </View>
      </Card>
      <Card>
        <H2>This phone</H2>
        <Body>Model: {deviceModelLabel({ modelName: Device.modelName, brand: Device.brand, modelId: Device.modelId })}</Body>
        <Body>Platform: {Platform.OS} {String(Platform.Version)}</Body>
        <Body>Barometer hardware: {hw}</Body>
        {baro.permissionDenied ? <Body>Motion &amp; Fitness permission: denied (barometer unusable)</Body> : null}
        <Body>Location permission: {location.permission}</Body>
        <Body>Stored: {sessions.length} session(s), {readings.length} reading(s), {deviceChecks.length} device check(s), {wifiScans.length} Wi-Fi scan(s)</Body>
      </Card>
      <Card>
        <H2>How to test</H2>
        <Body>
          1. Calibrate at the main entrance (ground floor).{'\n'}2. Walk to a floor, select the floor you are really on, stand still and
          tap Record.{'\n'}3. Cover every floor several times, in different spots (atrium, corridors, near escalators).{'\n'}4. Recalibrate
          at the entrance every ~20 minutes.{'\n'}5. Export CSV at the end of the visit and share it with the team.
        </Body>
      </Card>
    </ScrollView>
  );
}
