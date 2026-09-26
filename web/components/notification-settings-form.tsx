"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  NOTIFICATION_CATEGORY_CATALOG,
  type NotificationCategory,
  type NotificationPreferences,
} from "@/lib/notifications-model";

/**
 * Notification Settings form — the preference surface (NOT the inbox).
 *
 * Exactly the six categories locked by migration 0024/0025 are rendered; no
 * category can be added from the UI. "Safety & Account" is shown locked ON:
 * it is mandatory (MASTER 10 §10) and the server ignores any attempt to turn
 * it off, so the UI states the same contract instead of pretending.
 *
 * Saving goes through PATCH /api/notification-preferences (server-side
 * authorization + canonical table). The applied values come from the server
 * response and the page is then refreshed, so a reload re-reads the database.
 */
export default function NotificationSettingsForm({ preferences }: { preferences: NotificationPreferences }) {
  const [values, setValues] = useState<NotificationPreferences>(preferences);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function save(next: NotificationPreferences) {
    setValues(next);
    setSaved(false);
    setError(null);
    setSaving(true);
    try {
      const response = await fetch("/api/notification-preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          live_place: next.live_place,
          visit_experience: next.visit_experience,
          help_support: next.help_support,
          system: next.system,
          promotional: next.promotional,
        }),
      });
      if (!response.ok) throw new Error("Preferences could not be saved");
      const payload = (await response.json()) as { preferences?: NotificationPreferences };
      if (payload.preferences) setValues(payload.preferences);
      setSaved(true);
      router.refresh();
    } catch {
      setError("Preferensi notifikasi belum tersimpan. Coba lagi.");
    } finally {
      setSaving(false);
    }
  }

  function toggle(category: NotificationCategory) {
    const current = values[category];
    void save({ ...values, [category]: !current });
  }

  return (
    <div>
      <ul className="mt-6 space-y-2">
        {NOTIFICATION_CATEGORY_CATALOG.map((entry) => {
          const enabled = values[entry.category];
          return (
            <li
              key={entry.category}
              className="flex items-center justify-between gap-4 rounded-2xl border border-black/10 bg-white p-4"
            >
              <div>
                <p className="text-sm font-semibold">
                  {entry.label}
                  {entry.mandatory ? (
                    <span className="ml-2 rounded-full bg-brand-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-primary">
                      Wajib
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs text-black/55">{entry.description}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={entry.label}
                disabled={!entry.editable || saving}
                onClick={() => toggle(entry.category)}
                className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:cursor-not-allowed ${
                  enabled ? "bg-brand-primary" : "bg-black/20"
                } ${!entry.editable ? "opacity-70" : ""}`}
              >
                <span
                  className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition ${
                    enabled ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-xs text-black/45" role="status">
        {saving
          ? "Menyimpan…"
          : error
            ? error
            : saved
              ? "Preferensi tersimpan."
              : `Default: kategori wajib aktif, Promotional nonaktif.`}
      </p>
    </div>
  );
}
