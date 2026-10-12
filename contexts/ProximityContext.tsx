import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useDatabase } from './DatabaseContext';
import { useLocation } from './LocationContext';
import { createProximityManager } from '../services/proximity';

const ProximityContext = createContext<{ error: string | null; retry: () => void } | null>(null);

export function ProximityProvider({ children }: { children: ReactNode }) {
  const { markers } = useDatabase();
  const { position } = useLocation();
  const manager = useRef<ReturnType<typeof createProximityManager> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const current = createProximityManager(setError);
    manager.current = current;
    return () => { manager.current = null; current.dispose(); };
  }, []);

  useEffect(() => {
    manager.current?.update(position?.coords ?? null, markers);
  }, [position, markers]);

  return (
    <ProximityContext.Provider value={{ error, retry: () => manager.current?.retry() }}>
      {children}
    </ProximityContext.Provider>
  );
}

export function useProximity() {
  const context = useContext(ProximityContext);
  if (!context) throw new Error('useProximity должен использоваться внутри ProximityProvider');
  return context;
}
