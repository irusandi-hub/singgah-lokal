import VisitIntentDetail from "./VisitIntentDetail";

export default async function ProducerVisitIntentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VisitIntentDetail id={id} />;
}
