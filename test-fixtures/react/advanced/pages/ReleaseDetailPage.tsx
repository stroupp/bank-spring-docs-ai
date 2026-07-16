import { ApprovalPanel } from "../components/ApprovalPanel";

export function ReleaseDetailPage() {
  fetch("/api/treasury/releases/summary");
  return (
    <main>
      <input aria-label="Review comment" value={comment} onChange={setComment} />
      <textarea aria-label="Step-up token" value={stepUpToken} onChange={setStepUpToken} />
      <select aria-label="Release status" value={status ?? ""} onChange={setStatus} />
      <input aria-label="Dynamic release filter" value={values[fieldKey]} onChange={setDynamicValue} />
      <ApprovalPanel />
    </main>
  );
}
