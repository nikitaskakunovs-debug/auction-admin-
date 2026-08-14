"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

/** Тост макета. Состояние держим в модуле: звать say() может любая карточка. */
let push: ((m: string) => void) | null = null;
export function say(message: string) { push?.(message); }

export function Toast() {
  const [msg, setMsg] = useState("");
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    push = (m: string) => {
      setMsg(m); setOn(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setOn(false), 3200);
    };
    return () => { push = null; if (timer.current) clearTimeout(timer.current); };
  }, []);

  return (
    <div className={`toast${on ? " on" : ""}`} role="status" aria-live="polite">
      <Icon name="check" /><span>{msg}</span>
    </div>
  );
}
