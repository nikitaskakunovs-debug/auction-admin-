"use client";

import type { CSSProperties, ReactNode } from "react";

/** Формы входа и регистрации на дизайн-системе макета: карточка `.card-b`,
 *  поля `.fields`, кнопка `.btn`. Инлайновых цветов больше нет — тёмная тема
 *  работает сама. */
export const authInput: CSSProperties = {};
export const authButton: CSSProperties = {};

export function AuthCard({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="wrap" style={{ paddingTop: 40, paddingBottom: 80 }}>
      <div className="card-b auth-card">
        <h1>{title}</h1>
        {sub && <p className="note">{sub}</p>}
        {children}
      </div>
    </section>
  );
}
