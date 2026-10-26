import { Linking, View } from 'react-native';
import { useSensors } from '../state/SensorContext';
import { useAppState } from '../state/AppState';
import { Banner, Body, Button, Card, H2, Muted } from '../ui/kit';
import { space } from '../ui/theme';

/** Hardware + permission status, with the location rationale and a way to grant it. */
export function SensorBanners() {
  const { baro, location } = useSensors();
  const { settings } = useAppState();
  const demo = settings.demoMode;

  return (
    <View>
      {demo ? (
        <Banner tone="warn">
          Demo mode is ON: pressure and GPS are simulated. Readings are labelled "DEMO" in notes. Turn it off in Settings for real tests.
        </Banner>
      ) : null}
      {!demo && baro.status === 'unavailable' ? (
        <Banner tone="bad">
          This phone has no barometer, so it cannot take part in the barometer test. You can still record GPS-only readings
          (barometer columns will be empty).
        </Banner>
      ) : null}
      {!demo && baro.status === 'permission-denied' ? (
        <Card>
          <H2>Motion &amp; Fitness is off</H2>
          <Body>
            iPhone reads the barometer through Motion &amp; Fitness, and that permission is denied, so the barometer cannot be used.
            Readings would be GPS-only (barometer columns empty), which is not useful for this test.
          </Body>
          <View style={{ height: space.sm }} />
          <Muted>To fix: Settings › Privacy &amp; Security › Motion &amp; Fitness › turn on Fitness Tracking and Locus. Then come back and tap Check again.</Muted>
          <View style={{ height: space.md }} />
          <Button title="Open Settings" variant="secondary" onPress={() => void Linking.openSettings()} />
          <View style={{ height: space.sm }} />
          <Button title="Check again" variant="secondary" onPress={baro.recheckPermission} />
        </Card>
      ) : null}
      {!demo && location.permission !== 'granted' && location.permission !== 'unknown' ? (
        <Card>
          <H2>Location for GPS comparison</H2>
          <Body>
            Locus compares the barometer with GPS altitude. We read your location only while this screen is open, and it is saved
            only on this phone inside your readings (latitude, longitude, altitude). Nothing is uploaded.
          </Body>
          <View style={{ height: space.sm }} />
          {location.permission === 'denied' ? (
            <Muted>Location is off: running in barometer-only mode. GPS columns will be empty.</Muted>
          ) : null}
          <View style={{ height: space.md }} />
          {location.permission === 'denied' && !location.canAskAgain ? (
            <Button title="Open Settings to allow location" variant="secondary" onPress={() => void Linking.openSettings()} />
          ) : (
            <Button title="Allow location" variant="secondary" onPress={() => void location.requestPermission()} />
          )}
        </Card>
      ) : null}
      {location.error && !demo ? <Banner tone="warn">GPS: {location.error}</Banner> : null}
    </View>
  );
}
