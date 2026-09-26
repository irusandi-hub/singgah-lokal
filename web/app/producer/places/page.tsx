import { redirect } from "next/navigation";

// Backward-compatibility only (PO, mockup work 2026-09-26): the Place working
// surface (roster "Place milikmu" + "+ Tambahkan Place baru" + add/edit
// forms) lives ON the Producer dashboard — there is NO second Place list
// page. Old links hand off to /producer; the per-Place editor routes under
// /producer/places/[placeId] stay reachable for deep links.
export default function ProducerPlacesRedirectPage() {
  redirect("/producer");
}
