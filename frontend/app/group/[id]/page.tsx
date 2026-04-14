export default function GroupPage({ params }: { params: { id: string } }) {
  return (
    <main className="min-h-screen bg-[#0f0f1a] flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-medium text-white mb-2">Group Workspace</h1>
        <p className="text-[#aaaaaa]">Group ID: {params.id}</p>
        <p className="text-[#555555] text-sm mt-4">Coming in Phase 6</p>
      </div>
    </main>
  );
}
