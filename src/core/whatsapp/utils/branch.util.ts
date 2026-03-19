export type Branch = {
  id?: string | number;
  nombre?: string;
  lat: string | number;
  lng: string | number;
  servicios?: string[];
  turnos?: Array<{ dias: number[]; horaInicial: string; horaFinal: string }>;
  telefono?: string;
  localizacion?: string;
  [key: string]: unknown;
};

export type BranchWithDistance = Branch & {
  distancia: number;
};

type Coordinates = {
  lat: number;
  lng: number;
};

/**
 * Utilidad pura para escoger la sucursal más cercana por coordenadas.
 */
export function getNearestBranch(
  lat: number,
  lng: number,
  branches: Branch[],
): BranchWithDistance | null {
  if (!branches.length) return null;

  const origin: Coordinates = { lat, lng };
  let nearestBranch: BranchWithDistance | null = null;
  let minDistance = Infinity;

  for (const branch of branches) {
    const branchCoords: Coordinates = {
      lat: parseFloat(String(branch.lat)),
      lng: parseFloat(String(branch.lng)),
    };

    const distance = calculateEuclideanDistance(origin, branchCoords);

    if (distance < minDistance) {
      minDistance = distance;
      nearestBranch = { ...branch, distancia: distance };
    }
  }

  return nearestBranch;
}

function calculateEuclideanDistance(coords1: Coordinates, coords2: Coordinates): number {
  const dLat = coords2.lat - coords1.lat;
  const dLng = coords2.lng - coords1.lng;

  const latKm = dLat * 111.32;
  const lngKm = dLng * 111.32 * Math.cos((coords1.lat * Math.PI) / 180);

  return Math.sqrt(latKm * latKm + lngKm * lngKm);
}

