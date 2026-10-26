/**
 * Pressure to altitude conversions.
 *
 * For floor detection we only need the height DIFFERENCE between the
 * calibration point and the current point, so we use the hypsometric
 * equation with the calibration pressure as the reference:
 *
 *   h = (R_d * T / g) * ln(p0 / p)
 *
 * At ~24 °C, 1 hPa is roughly 8.7 m, so a 4.5 m mall floor is ~0.5 hPa.
 */

/** Specific gas constant for dry air, J/(kg·K). */
export const R_DRY_AIR = 287.053;
/** Standard gravity, m/s². */
export const G0 = 9.80665;
/** Standard sea-level pressure, hPa. */
export const P_SEA_LEVEL_STD = 1013.25;
/** Default indoor temperature for air-conditioned malls in Cairo/Muscat. */
export const DEFAULT_INDOOR_TEMP_C = 24;

function assertPressure(p: number, name: string): void {
  if (!Number.isFinite(p) || p <= 0) {
    throw new RangeError(`${name} must be a positive finite number of hPa, got ${p}`);
  }
}

/**
 * Height of `pressureHpa` above the point where `baselinePressureHpa` was
 * measured, in meters. Positive = higher than baseline.
 */
export function relativeAltitudeFromPressure(
  pressureHpa: number,
  baselinePressureHpa: number,
  temperatureC: number = DEFAULT_INDOOR_TEMP_C,
): number {
  assertPressure(pressureHpa, 'pressureHpa');
  assertPressure(baselinePressureHpa, 'baselinePressureHpa');
  const tK = temperatureC + 273.15;
  if (tK <= 0) throw new RangeError(`temperatureC out of range: ${temperatureC}`);
  return ((R_DRY_AIR * tK) / G0) * Math.log(baselinePressureHpa / pressureHpa);
}

/**
 * Absolute altitude from pressure using the international barometric formula
 * (standard atmosphere). Only rough: weather moves it by tens of meters.
 * Used for display, never for floor decisions.
 */
export function absoluteAltitudeFromPressure(
  pressureHpa: number,
  seaLevelPressureHpa: number = P_SEA_LEVEL_STD,
): number {
  assertPressure(pressureHpa, 'pressureHpa');
  assertPressure(seaLevelPressureHpa, 'seaLevelPressureHpa');
  return 44330 * (1 - Math.pow(pressureHpa / seaLevelPressureHpa, 1 / 5.255));
}

/** Meters of height per hPa at the given temperature, near `pressureHpa`. */
export function metersPerHpa(
  pressureHpa: number = P_SEA_LEVEL_STD,
  temperatureC: number = DEFAULT_INDOOR_TEMP_C,
): number {
  assertPressure(pressureHpa, 'pressureHpa');
  return (R_DRY_AIR * (temperatureC + 273.15)) / (G0 * pressureHpa);
}
