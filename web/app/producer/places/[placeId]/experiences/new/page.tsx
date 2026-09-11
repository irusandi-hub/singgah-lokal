"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ExperienceForm from "../ExperienceForm";

export default function NewExperiencePage({ params }: { params: Promise<{ placeId: string }> }) {
  const [placeId, setPlaceId] = useState(""); const [timezone, setTimezone] = useState("");
  useEffect(() => { params.then(({ placeId: id }) => { setPlaceId(id); fetch(`/api/producer/places/${id}`).then((response) => response.json()).then((place) => setTimezone(place.timezone)); }); }, [params]);
  return <main className="min-h-screen bg-[#f7f5ef] px-5 py-8 text-[#20231f] sm:px-8"><div className="mx-auto max-w-2xl"><Link className="text-sm font-bold text-[#7b5b38]" href={`/producer/places/${placeId}/experiences`}>← Kembali ke Experience</Link><h1 className="mt-6 text-3xl font-black">Tambah Experience</h1><section className="mt-6 rounded-xl border border-black/10 bg-white p-5"><ExperienceForm placeId={placeId} placeTimezone={timezone || "Asia/Jakarta"} /></section></div></main>;
}