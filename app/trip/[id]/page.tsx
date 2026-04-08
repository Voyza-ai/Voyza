export default function TripPage({ params }: { params: { id: string } }) {
  return (
    <main className="min-h-screen bg-[#0f0f1a] flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-medium text-white mb-2">Trip Details</h1>
        <p className="text-[#aaaaaa]">Trip ID: {params.id}</p>
        <p className="text-[#555555] text-sm mt-4">Coming in Phase 4</p>
      </div>
    </main>
  );
}
