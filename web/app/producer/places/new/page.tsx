import { redirect } from "next/navigation";

// Backward-compatibility only (PO, mockup work 2026-09-26): the add-Place
// form opens from the dashboard workspace ("Place milikmu" → "Tambahkan
// Place baru") — there is no standalone new-Place page. Old links hand off
// to the dashboard.
export default function NewPlaceRedirectPage() {
  redirect("/producer");
}
