export type PlaceCategory = "Kopi" | "Teh" | "Kuliner";

export type PlaceType = "production" | "experience";

export type ClaimStatus = "unverified" | "claimed" | "verified";

export type ProducerReference = {
  id: string;
  displayName: string;
};

export type Place = {
  id: string;
  name: string;
  shortDescription: string;
  category: PlaceCategory;
  type: PlaceType;
  area: string;
  timezone: string;
  currency: string;
  latitude: number | null;
  longitude: number | null;
  producer: ProducerReference | null;
  claimStatus: ClaimStatus;
};

const placeIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const places: Place[] = [
  {
    id: "kopi-dari-kebun",
    name: "Kopi dari Kebun",
    shortDescription: "Temukan cerita dan produksi lokal dari tempat ini.",
    category: "Kopi",
    type: "production",
    area: "Bandung",
    timezone: "Asia/Jakarta",
    currency: "IDR",
    latitude: null,
    longitude: null,
    producer: null,
    claimStatus: "unverified",
  },
  {
    id: "rumah-teh-lokal",
    name: "Rumah Teh Lokal",
    shortDescription: "Temukan cerita dan produksi lokal dari tempat ini.",
    category: "Teh",
    type: "experience",
    area: "Lembang",
    timezone: "Asia/Jakarta",
    currency: "IDR",
    latitude: null,
    longitude: null,
    producer: null,
    claimStatus: "unverified",
  },
  {
    id: "dapur-rasa",
    name: "Dapur Rasa",
    shortDescription: "Temukan cerita dan produksi lokal dari tempat ini.",
    category: "Kuliner",
    type: "production",
    area: "Bandung",
    timezone: "Asia/Jakarta",
    currency: "IDR",
    latitude: null,
    longitude: null,
    producer: null,
    claimStatus: "unverified",
  },
];

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function isValidCurrency(currency: string): boolean {
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency }).format(0);
    return /^[A-Z]{3}$/.test(currency);
  } catch {
    return false;
  }
}

export function validatePlace(place: Place): void {
  if (!place.id || !placeIdPattern.test(place.id)) {
    throw new Error(`Invalid Place id: ${place.id}`);
  }

  if (!place.name.trim() || !place.shortDescription.trim() || !place.area.trim()) {
    throw new Error(`Place ${place.id} is missing required identity fields`);
  }

  if (place.latitude !== null && (!Number.isFinite(place.latitude) || place.latitude < -90 || place.latitude > 90)) {
    throw new Error(`Invalid latitude for Place ${place.id}`);
  }

  if (place.longitude !== null && (!Number.isFinite(place.longitude) || place.longitude < -180 || place.longitude > 180)) {
    throw new Error(`Invalid longitude for Place ${place.id}`);
  }

  if (!isValidTimezone(place.timezone)) {
    throw new Error(`Invalid timezone for Place ${place.id}`);
  }

  if (!isValidCurrency(place.currency)) {
    throw new Error(`Invalid currency for Place ${place.id}`);
  }
}

export function validatePlaces(placeList: readonly Place[]): void {
  const ids = new Set<string>();

  for (const place of placeList) {
    validatePlace(place);

    if (ids.has(place.id)) {
      throw new Error(`Duplicate Place id: ${place.id}`);
    }

    ids.add(place.id);
  }
}

validatePlaces(places);

export function getPlaceById(id: string): Place | undefined {
  return places.find((place) => place.id === id);
}