import { createContext, useContext, useRef, type MutableRefObject, type ReactNode } from 'react';
import { useBarometer, type BarometerApi } from '../hooks/useBarometer';
import { useLocationFix, type LocationApi } from '../hooks/useLocationFix';

export interface Sensors {
  baro: BarometerApi;
  location: LocationApi;
  /** Demo mode only: the height (m above entrance) the simulator pretends the phone is at. */
  simHeightRef: MutableRefObject<number>;
}

const Ctx = createContext<Sensors | null>(null);

/** Sensors live at the app root so streams survive tab switches (keeps the iOS altitude origin stable). */
export function SensorProvider({ demo, children }: { demo: boolean; children: ReactNode }) {
  const simHeightRef = useRef(0);
  const baro = useBarometer({ demo, simHeightRef });
  const location = useLocationFix({ demo, simHeightRef });
  return <Ctx.Provider value={{ baro, location, simHeightRef }}>{children}</Ctx.Provider>;
}

export function useSensors(): Sensors {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSensors must be used inside SensorProvider');
  return v;
}
