import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import type { Marker, MarkerImage } from '../types';

interface MarkersContextValue {
  markers: Marker[];
  addMarker: (latitude: number, longitude: number) => void;
  images: MarkerImage[];
  addImage: (markerId: number, uri: string) => void;
  deleteImage: (markerId: number, imageId: number) => void;
}

const MarkersContext = createContext<MarkersContextValue | null>(null);

export function MarkersProvider({ children }: { children: ReactNode }) {
  const [markers, setMarkers] = useState<Marker[]>([]);
  const nextId = useRef(1);
  const [images, setImages] = useState<MarkerImage[]>([]);
  const nextImageId = useRef(1);

  function addMarker(latitude: number, longitude: number) {
    const marker: Marker = { id: nextId.current++, latitude, longitude };
    setMarkers((current) => [...current, marker]);
  }

  function addImage(markerId: number, uri: string) {
    if (!markers.some((marker) => marker.id === markerId)) return;
    const image: MarkerImage = { id: nextImageId.current++, markerId, uri };
    setImages((current) => [...current, image]);
  }

  function deleteImage(markerId: number, imageId: number) {
    setImages((current) => current.filter(
      (image) => !(image.markerId === markerId && image.id === imageId),
    ));
  }

  return (
    <MarkersContext.Provider value={{ markers, addMarker, images, addImage, deleteImage }}>
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
