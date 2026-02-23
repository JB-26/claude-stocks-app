export default function PlaceholderPanel() {
  return (
    <div
      data-testid="placeholder-panel"
      className="flex min-w-0 flex-col items-center justify-center gap-2 border border-zinc-800 px-6 py-16 text-center"
    >
      <p className="text-sm font-medium text-zinc-400">No company selected</p>
      <p className="text-xs text-zinc-500">
        Visit additional companies to populate this panel.
      </p>
    </div>
  );
}
