import { useState } from 'react';
import type { AltitudeSource } from '@locus/altitude-core';
import { BREAKDOWN_LABEL, type BreakdownKey, type BreakdownRow } from '../lib/analysis';
import { SOURCE_LABEL } from '../lib/data';
import { Card, Segmented, SummaryTable } from './common';

const KEYS: BreakdownKey[] = ['venue', 'device', 'platform', 'floor'];

export function Breakdowns({
  breakdowns,
  source,
}: {
  breakdowns: Record<BreakdownKey, BreakdownRow[]>;
  source: AltitudeSource;
}) {
  const [key, setKey] = useState<BreakdownKey>('venue');
  return (
    <Card
      title="Breakdowns"
      subtitle={`${SOURCE_LABEL[source]} accuracy split by group, to spot a weak venue, device or floor.`}
      actions={
        <Segmented
          label="Break down by"
          options={KEYS.map((k) => ({ value: k, label: BREAKDOWN_LABEL[k] }))}
          value={key}
          onChange={setKey}
        />
      }
    >
      <SummaryTable
        caption={`${SOURCE_LABEL[source]} accuracy by ${BREAKDOWN_LABEL[key].toLowerCase()}`}
        groupLabel={BREAKDOWN_LABEL[key]}
        rows={breakdowns[key]}
      />
    </Card>
  );
}
