import { ensureBackend } from "./agentClient";
import type { BillingUsageSummary } from "../types";

export async function loadTodayBillingUsage(): Promise<BillingUsageSummary> {
  const baseUrl = await ensureBackend();
  const response = await fetch(`${baseUrl}/api/billing/usage/today`, {
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Backend returned ${response.status}`);
  }

  return response.json() as Promise<BillingUsageSummary>;
}
