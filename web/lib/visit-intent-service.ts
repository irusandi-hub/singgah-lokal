import { canManagePlace, type ProducerAccess } from "@/lib/producer";
import { createVisitIntent, respondToVisitIntent, type VisitIntentInput, type VisitIntent } from "@/lib/visit-intents";
import { getServerVisitIntentRepository, type VisitIntentRepository } from "@/lib/visit-intent-repository";

export class VisitIntentNotFoundError extends Error {
  constructor() {
    super("Visit Intent was not found");
  }
}

export class VisitIntentConflictError extends Error {
  constructor() {
    super("An equivalent active Visit Intent already exists");
  }
}

async function getRepository(repository?: VisitIntentRepository): Promise<VisitIntentRepository> {
  return repository ?? getServerVisitIntentRepository();
}

export async function submitVisitIntent(
  input: Omit<VisitIntentInput, "userId">,
  userId: string,
  idempotencyKey: string,
  now = new Date(),
  repository?: VisitIntentRepository,
): Promise<VisitIntent> {
  if (!idempotencyKey.trim()) {
    throw new Error("Idempotency key is required");
  }

  const dataRepository = await getRepository(repository);
  const replay = await dataRepository.findByIdempotencyKey(userId, idempotencyKey);
  if (replay) {
    return replay;
  }

  const place = await dataRepository.getPlaceById(input.placeId);
  const experience = await dataRepository.getExperienceById(input.experienceId);
  if (!place || !experience) {
    throw new Error("Place or Experience was not found");
  }

  const fullInput: VisitIntentInput = { ...input, userId };
  const duplicate = await dataRepository.findActiveDuplicate(userId, input.placeId, input.experienceId, input.requestedDate, input.requestedStartTime, input.requestedEndTime);
  if (duplicate) {
    throw new VisitIntentConflictError();
  }

  const intent = createVisitIntent(fullInput, place, experience, now);
  return dataRepository.insert(intent, idempotencyKey);
}

export async function getUserVisitIntent(id: string, userId: string, repository?: VisitIntentRepository): Promise<VisitIntent> {
  const intent = await (await getRepository(repository)).findById(id);
  if (!intent || intent.userId !== userId) {
    throw new VisitIntentNotFoundError();
  }
  return intent;
}

export async function respondAsProducer(
  id: string,
  access: ProducerAccess,
  nextStatus: "accepted" | "declined" | "requires_confirmation",
  note: string,
  now = new Date(),
  repository?: VisitIntentRepository,
): Promise<VisitIntent> {
  const dataRepository = await getRepository(repository);
  const intent = await dataRepository.findById(id);
  if (!intent) {
    throw new VisitIntentNotFoundError();
  }

  const place = await dataRepository.getPlaceById(intent.placeId);
  const experience = await dataRepository.getExperienceById(intent.experienceId);
  if (!place || !experience || !canManagePlace(place, access)) {
    throw new VisitIntentNotFoundError();
  }

  return dataRepository.update(respondToVisitIntent(intent, place, access, nextStatus, note, now));
}
