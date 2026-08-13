import type { ReactNode } from "react";

/** Временная обёртка: страница ещё не переведена на макет 1:1,
 *  а <main> по макету больше не задаёт колонку. Удаляется вместе с портом. */
export default function Layout({ children }: { children: ReactNode }) {
  return <div className="wrap" style={{ paddingTop: 32, paddingBottom: 80 }}>{children}</div>;
}
