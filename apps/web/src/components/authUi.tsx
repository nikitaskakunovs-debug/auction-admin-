"use client";

import type { CSSProperties, ReactNode } from "react";

export const authInput: CSSProperties = {
  height: 44,
  borderRadius: 10,
  border: "1px solid rgba(10,10,10,0.15)",
  fontSize: 14.5,
  padding: "0 12px",
  outline: "none",
  background: "#fff",
};

export const authButton: CSSProperties = {
  all: "unset",
  cursor: "pointer",
  background: "#0A0A0A",
  color: "#fff",
  fontWeight: 700,
  fontSize: 14.5,
  borderRadius: 10,
  padding: "13px 0",
  textAlign: "center",
};

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ maxWidth: 400, margin: "40px auto", background: "#fff", border: "1px solid rgba(10,10,10,0.10)", borderRadius: 16, padding: 26, display: "grid", gap: 16 }}>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em" }}>{title}</h1>
      {children}
    </div>
  );
}
