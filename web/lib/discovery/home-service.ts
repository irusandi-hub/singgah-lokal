import "server-only";

import { buildDiscoveryViewModel, type DiscoveryViewModel } from "./view-model";
import { getPublicPlaceExperienceRepository } from "@/lib/place-experience-repository";

/**
 * DISCOVERY HOME SERVICE — the ONLY server bridge between the canonical data
 * layer and the locked Discovery engine (docs/DISCOVERY_CONTRACT_v1.0.md).
 *
 * Home (and any future Admin view) calls THIS module; nothing outside the
 * engine may compute eligibility, score, stars, or ranking (Stage 2/3 rule:
 * no second scoring path in components). The service assembles the canonical
 * signal inputs through the ONE repository, feeds them to the engine via the
 * pure view-model mapping, and exposes stars/rank — never the numeric score
 * (contract §3: score never leaves the server).
 *
 * This is the single place that supplies the real clock to the engine.
 */
export async function loadDiscoveryViewModel(): Promise<DiscoveryViewModel> {
  const repository = await getPublicPlaceExperienceRepository();
  const [inputs, curatedPlaceIds] = await Promise.all([
    repository.listDiscoveryInputs(new Date()),
    repository.listCuratedPublishedPlaceIds(),
  ]);
  return buildDiscoveryViewModel(inputs, curatedPlaceIds, new Date());
}

export type { DiscoveryViewModel, DiscoveryPublicPlace } from "./view-model";
