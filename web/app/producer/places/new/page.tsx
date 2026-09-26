import { redirect } from "next/navigation";

// Backward-compatibility only (PO, 2026-09-26): the standalone "new Place"
// page was consolidated into the canonical /producer/places page, whose
// "+ Tambah Place" action opens the add form in place (view state "new").
// This route keeps old links working by handing off to the canonical page —
// no duplicated form, no second dashboard.
export default function NewPlaceRedirectPage() {
  redirect("/producer/places");
}
