"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Keeps the singleton Creator lease renewed while Developer Center is open.
 * The server decides whether this Creator still owns the slot; the client
 * never stores ownership state or credentials.
 */
export default function CreatorLeaseHeartbeat() {
  const router = useRouter();

  useEffect(() => {
    let stopped = false;

    async function heartbeat() {
      if (stopped) return;
      try {
        const response = await fetch("/api/creator/gate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ step: "heartbeat" }),
          cache: "no-store",
        });
        if (!response.ok && !stopped) {
          router.push("/developer-gate");
        }
      } catch {
        if (!stopped) router.push("/developer-gate");
      }
    }

    const intervalId = window.setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(intervalId);
    };
  }, [router]);

  return null;
}
