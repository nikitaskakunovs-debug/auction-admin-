import type { Metadata } from "next";
import { ConditionsList } from "@/components/ConditionsList";

export const metadata: Metadata = { title: "Condition reference" };

/** Public reference page for the 16 condition grades — linked from every lot. */
export default function ConditionsPage() {
  return <ConditionsList />;
}
