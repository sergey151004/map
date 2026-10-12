export interface Marker {
  id: number;
  latitude: number;
  longitude: number;
}

export interface MarkerImage {
  id: number;
  markerId: number;
  uri: string;
}

// Параметры URL приходят строками, даже если ID в приложении числовой.
export type MarkerRouteParams = {
  id?: string | string[];
};
