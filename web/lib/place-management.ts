import { type PlaceCategory, type PlaceType, validatePlaceInput } from "@/lib/places";
import type { PlaceMutation } from "@/lib/place-experience-repository";

const categories: PlaceCategory[] = ["Kopi", "Teh", "Kuliner"];
const types: PlaceType[] = ["production", "experience"];

export class PlaceInputError extends Error {}

export function parsePlaceMutation(raw: unknown, id?: string): PlaceMutation {
  if (!raw || typeof raw !== "object") throw new PlaceInputError("place_input_invalid");
  const body = raw as Record<string, unknown>;
  const text = (key: string): string => {
    const value = body[key];
    if (typeof value !== "string" || !value.trim()) throw new PlaceInputError("place_required_field_invalid");
    return value.trim();
  };
  const nullableNumber = (key: string, min: number, max: number): number | null => {
    const value = body[key];
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new PlaceInputError("place_coordinates_invalid");
    }
    return value;
  };
  const category = text("category") as PlaceCategory;
  const type = text("type") as PlaceType;
  if (!categories.includes(category) || !types.includes(type)) throw new PlaceInputError("place_type_or_category_invalid");
  const mutation: PlaceMutation = {
    id: id ?? text("id"),
    name: text("name"),
    shortDescription: text("shortDescription"),
    category,
    type,
    area: text("area"),
    address: text("address"),
    contactInformation: typeof body.contactInformation === "string" ? body.contactInformation.trim() : "",
    timezone: text("timezone"),
    currency: text("currency").toUpperCase(),
    latitude: nullableNumber("latitude", -90, 90),
    longitude: nullableNumber("longitude", -180, 180),
  };
  try {
    validatePlaceInput(mutation);
  } catch {
    throw new PlaceInputError("place_input_invalid");
  }
  return mutation;
}