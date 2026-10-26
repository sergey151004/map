export interface Marker {
  id: number;
  latitude: number;
  longitude: number;
}

export interface MarkerImage {
  id: number;
  markerId: number;
  // Для копий приложения — путь marker-photos/... относительно Paths.document.
  uri: string;
}

// Параметры URL приходят строками, даже если ID в приложении числовой.
export type MarkerRouteParams = {
  id?: string | string[];
};
