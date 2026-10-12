import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import type { Marker } from '../types';

interface MarkersContextValue {
  markers: Marker[];
  addMarker: (latitude: number, longitude: number) => void;
}

const MarkersContext = createContext<MarkersContextValue | null>(null);

export function MarkersProvider({ children }: { children: ReactNode }) {
  const [markers, setMarkers] = useState<Marker[]>([]);
  const nextId = useRef(1);

  function addMarker(latitude: number, longitude: number) {
    const marker: Marker = { id: nextId.current++, latitude, longitude };
    setMarkers((current) => [...current, marker]);
  }

  return (
    <MarkersContext.Provider value={{ markers, addMarker }}>
      {children}
    </MarkersContext.Provider>
  );
}

export function useMarkers() {
  const context = useContext(MarkersContext);
  if (!context) {
    throw new Error('useMarkers должен использоваться внутри MarkersProvider');
  }
  return context;
}
