import { createContext, useContext } from 'react';

export type Tab = 'test' | 'venues' | 'data' | 'settings';

/** Lets screens switch tabs (e.g. a banner that sends the tester to the device check). */
export const NavContext = createContext<(tab: Tab) => void>(() => undefined);

export const useGoTo = () => useContext(NavContext);
