import { ensureBackend } from "./agentClient";
import type { BillingPricesResult } from "../types";

export async function loadBillingPrices(): Promise<BillingPricesResult> {
  const baseUrl = await ensureBackend();
  const response = await fetch(`${baseUrl}/api/billing/prices`, {
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Backend returned ${response.status}`);
  }

  return response.json() as Promise<BillingPricesResult>;
}
