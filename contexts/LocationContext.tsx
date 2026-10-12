import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { INITIAL_LOCATION_STATE, trackForegroundLocation, type ForegroundLocationState } from '../services/location';

interface LocationContextValue extends ForegroundLocationState {
  retry: () => void;
}

const LocationContext = createContext<LocationContextValue | null>(null);

export function LocationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(INITIAL_LOCATION_STATE);
  const tracker = useRef<ReturnType<typeof trackForegroundLocation> | null>(null);

  useEffect(() => {
    const current = trackForegroundLocation(setState);
    tracker.current = current;
    return () => {
      tracker.current = null;
      current.dispose();
    };
  }, []);

  const retry = useCallback(() => tracker.current?.retry(), []);

  return (
    <LocationContext.Provider value={{ ...state, retry }}>
      {children}
    </LocationContext.Provider>
  );
}

export function useLocation() {
  const context = useContext(LocationContext);
  if (!context) throw new Error('useLocation должен использоваться внутри LocationProvider');
  return context;
}
