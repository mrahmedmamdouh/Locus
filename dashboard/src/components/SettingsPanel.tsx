import type { AltitudeSource } from '@locus/altitude-core';
import { SOURCE_LABEL } from '../lib/data';
import { DEFAULT_SETTINGS, LIMITS, parseBounded, type Settings } from '../lib/settings';
import { Card, NumberField, Segmented } from './common';

// Module-level parsers keep NumberField's sync effect stable.
const parseFloorHeight = (s: string) => parseBounded(s, LIMITS.floorHeightM.min, LIMITS.floorHeightM.max);
const parseAccuracyPct = (s: string) =>
  parseBounded(s, LIMITS.minFloorAccuracyPct.min, LIMITS.minFloorAccuracyPct.max);
const parseP90Fraction = (s: string) =>
  parseBounded(s, LIMITS.maxP90FractionOfFloor.min, LIMITS.maxP90FractionOfFloor.max);
const parseMinReadings = (s: string) =>
  parseBounded(s, LIMITS.minReadings.min, LIMITS.minReadings.max, true);
const parseMinVenues = (s: string) => parseBounded(s, LIMITS.minVenues.min, LIMITS.minVenues.max, true);

const SOURCE_OPTIONS: { value: AltitudeSource; label: string }[] = [
  { value: 'baro', label: SOURCE_LABEL.baro },
  { value: 'gps', label: SOURCE_LABEL.gps },
  { value: 'os', label: 'iOS OS' },
];

export function SettingsPanel({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const { gate } = settings;
  const accuracyPct = Math.round(gate.minFloorAccuracy * 1000) / 10;
  return (
    <Card
      title="Settings"
      subtitle="Applies to the verdict, breakdowns and table."
      actions={
        <button type="button" className="btn btn-ghost" onClick={() => onChange(structuredClone(DEFAULT_SETTINGS))}>
          Reset to defaults
        </button>
      }
    >
      <div className="settings-grid">
        <div className="field span-2">
          <span className="field-label" id="source-label">
            Altitude source for the gate
          </span>
          <Segmented
            label="Altitude source for the gate"
            options={SOURCE_OPTIONS}
            value={settings.source}
            onChange={(source) => onChange({ ...settings, source })}
          />
          {settings.source === 'os' ? (
            <span className="field-hint">
              The CSV has no floor estimate for iOS OS altitude, so floor accuracy is unavailable and the gate
              cannot pass on this source.
            </span>
          ) : null}
        </div>
        <NumberField
          label="Floor height"
          suffix="m"
          value={settings.floorHeightM}
          parse={parseFloorHeight}
          onCommit={(floorHeightM) => onChange({ ...settings, floorHeightM })}
          hint="Slab-to-slab height used for error thresholds."
          error={`Enter ${LIMITS.floorHeightM.min}–${LIMITS.floorHeightM.max} m.`}
        />
        <NumberField
          label="Min floor accuracy"
          suffix="%"
          value={accuracyPct}
          parse={parseAccuracyPct}
          onCommit={(pct) => onChange({ ...settings, gate: { ...gate, minFloorAccuracy: pct / 100 } })}
          hint="Share of readings on the correct floor."
          error="Enter 0–100."
        />
        <NumberField
          label="p90 error below"
          suffix="× floor height"
          value={gate.maxP90FractionOfFloor}
          parse={parseP90Fraction}
          onCommit={(maxP90FractionOfFloor) => onChange({ ...settings, gate: { ...gate, maxP90FractionOfFloor } })}
          hint={`= ${(gate.maxP90FractionOfFloor * settings.floorHeightM).toFixed(2)} m at current floor height.`}
          error={`Enter ${LIMITS.maxP90FractionOfFloor.min}–${LIMITS.maxP90FractionOfFloor.max}.`}
        />
        <NumberField
          label="Min readings"
          value={gate.minReadings}
          step={1}
          parse={parseMinReadings}
          onCommit={(minReadings) => onChange({ ...settings, gate: { ...gate, minReadings } })}
          hint="Readings with a value for the chosen source."
          error="Enter a whole number ≥ 1."
        />
        <NumberField
          label="Min venues"
          value={gate.minVenues}
          step={1}
          parse={parseMinVenues}
          onCommit={(minVenues) => onChange({ ...settings, gate: { ...gate, minVenues } })}
          hint="Distinct malls tested."
          error="Enter a whole number ≥ 1."
        />
      </div>
    </Card>
  );
}
