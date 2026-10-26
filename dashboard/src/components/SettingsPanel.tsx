import type { AltitudeSource } from '@locus/altitude-core';
import { SOURCE_LABEL } from '../lib/data';
import { DEFAULT_SETTINGS, LIMITS, PARSE, type Settings } from '../lib/settings';
import { Card, NumberField, Segmented } from './common';

const SOURCE_OPTIONS: { value: AltitudeSource; label: string }[] = [
  { value: 'baro', label: SOURCE_LABEL.baro },
  { value: 'gps', label: SOURCE_LABEL.gps },
  { value: 'os', label: 'iOS OS' },
];

export function SettingsPanel({
  settings,
  onChange,
  loadedReadings = 0,
  fallbackReadings = 0,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  /** Included readings currently loaded. */
  loadedReadings?: number;
  /** Of those, readings without a per-floor height (judged against the fallback). */
  fallbackReadings?: number;
}) {
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
              iOS OS altitude has no on-device floor estimate; a reading counts as the correct floor when it is
              within half of that floor&rsquo;s height.
            </span>
          ) : null}
        </div>
        <div className="field-group span-2">
          <NumberField
            label="Fallback floor height (m) — used only for files without per-floor heights"
            value={settings.floorHeightM}
            parse={PARSE.floorHeightM}
            onCommit={(floorHeightM) => onChange({ ...settings, floorHeightM })}
            hint="Readings that recorded their floor's own height are judged against that instead."
            error={`Enter ${LIMITS.floorHeightM.min}–${LIMITS.floorHeightM.max} m.`}
          />
          <span className="field-hint" data-testid="fallback-count">
            {loadedReadings === 0
              ? 'No readings loaded.'
              : `${fallbackReadings.toLocaleString()} of ${loadedReadings.toLocaleString()} loaded readings use the fallback.`}
          </span>
        </div>
        <NumberField
          label="Min floor accuracy"
          suffix="%"
          value={accuracyPct}
          parse={PARSE.minFloorAccuracyPct}
          onCommit={(pct) => onChange({ ...settings, gate: { ...gate, minFloorAccuracy: pct / 100 } })}
          hint="Share of readings on the correct floor."
          error="Enter 0–100."
        />
        <NumberField
          label="p90 error below"
          suffix="× floor height"
          value={gate.maxP90FractionOfFloor}
          parse={PARSE.maxP90FractionOfFloor}
          onCommit={(maxP90FractionOfFloor) => onChange({ ...settings, gate: { ...gate, maxP90FractionOfFloor } })}
          hint={`Each reading's error is divided by its own floor's height (fallback: ${(gate.maxP90FractionOfFloor * settings.floorHeightM).toFixed(2)} m).`}
          error={`Enter ${LIMITS.maxP90FractionOfFloor.min}–${LIMITS.maxP90FractionOfFloor.max}.`}
        />
        <NumberField
          label="Min readings"
          value={gate.minReadings}
          step={1}
          parse={PARSE.minReadings}
          onCommit={(minReadings) => onChange({ ...settings, gate: { ...gate, minReadings } })}
          hint="Readings with a value for the chosen source."
          error="Enter a whole number ≥ 1."
        />
        <NumberField
          label="Min venues"
          value={gate.minVenues}
          step={1}
          parse={PARSE.minVenues}
          onCommit={(minVenues) => onChange({ ...settings, gate: { ...gate, minVenues } })}
          hint={`Distinct malls with at least ${gate.minReadingsPerVenue.toLocaleString()} readings each.`}
          error="Enter a whole number ≥ 1."
        />
        <NumberField
          label="Min readings per venue"
          value={gate.minReadingsPerVenue}
          step={1}
          parse={PARSE.minReadingsPerVenue}
          onCommit={(minReadingsPerVenue) => onChange({ ...settings, gate: { ...gate, minReadingsPerVenue } })}
          hint="A venue only counts towards Min venues with this many readings for the chosen source."
          error="Enter a whole number ≥ 1."
        />
      </div>
    </Card>
  );
}
