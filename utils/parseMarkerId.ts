import type { MarkerRouteParams } from '../types';

export function parseMarkerId(value: MarkerRouteParams['id']): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
