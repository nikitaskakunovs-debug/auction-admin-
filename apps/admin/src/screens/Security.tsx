import { useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import { AT } from "../theme.js";
import { ABtn, ABadge, ACard, AField, AInput } from "../ui.js";

const errorList = (e: unknown): string => {
  if (e instanceof ApiError) {
    if (Array.isArray(e.body.detail)) return (e.body.detail as string[]).join(" ");
    if (typeof e.body.error === "string") return e.body.error.replace(/_/g, " ");
  }
  return "Something went wrong.";
};

export function SecurityScreen() {
  const { user } = useAuth();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);

  const [recoveryPw, setRecoveryPw] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [recMsg, setRecMsg] = useState<string | null>(null);
  const [recBusy, setRecBusy] = useState(false);

  const changePassword = async () => {
    setPwMsg(null);
    if (next !== confirm) {
      setPwMsg({ ok: false, text: "New passwords don't match." });
      return;
    }
    setPwBusy(true);
    try {
      await api.changePassword(cur, next);
      setPwMsg({ ok: true, text: "Password changed. Other sessions were signed out." });
      setCur("");
      setNext("");
      setConfirm("");
    } catch (e) {
      setPwMsg({ ok: false, text: errorList(e) });
    } finally {
      setPwBusy(false);
    }
  };

  const regenerate = async () => {
    setRecMsg(null);
    setRecBusy(true);
    try {
      const r = await api.regenerateRecoveryCodes(recoveryPw);
      setCodes(r.recoveryCodes);
      setRecoveryPw("");
    } catch (e) {
      setRecMsg(errorList(e));
    } finally {
      setRecBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 560 }}>
      <div>
        <h2 style={{ fontFamily: AT.body, fontSize: 18, fontWeight: 700, color: AT.ink, margin: 0 }}>Security</h2>
        <p style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, margin: "4px 0 0" }}>
          Signed in as {user?.email}
        </p>
      </div>

      <ACard title="Two-factor authentication">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ABadge tone={user?.totpEnabled ? "ok" : "danger"}>{user?.totpEnabled ? "Enabled" : "Not enrolled"}</ABadge>
          <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
            Two-factor is required for every admin. It was set up on your first sign-in.
          </span>
        </div>
      </ACard>

      <ACard title="Change password">
        <div style={{ display: "grid", gap: 12 }}>
          <AField label="Current password">
            <AInput value={cur} onChange={setCur} type="password" placeholder="Current password" />
          </AField>
          <AField label="New password" hint="At least 12 characters, with three of: lower, upper, digit, symbol.">
            <AInput value={next} onChange={setNext} type="password" placeholder="New password" />
          </AField>
          <AField label="Confirm new password">
            <AInput value={confirm} onChange={setConfirm} type="password" placeholder="Repeat new password" />
          </AField>
          {pwMsg && (
            <div style={{ fontFamily: AT.body, fontSize: 12.5, color: pwMsg.ok ? AT.ink : AT.danger }}>{pwMsg.text}</div>
          )}
          <div>
            <ABtn kind="dark" onClick={() => void changePassword()} disabled={pwBusy || !cur || !next || !confirm}>
              {pwBusy ? "Saving…" : "Change password"}
            </ABtn>
          </div>
        </div>
      </ACard>

      <ACard title="Recovery codes">
        <div style={{ display: "grid", gap: 12 }}>
          <p style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, margin: 0 }}>
            Regenerating invalidates your old codes. Confirm your password to continue.
          </p>
          <AField label="Password">
            <AInput value={recoveryPw} onChange={setRecoveryPw} type="password" placeholder="Your password" />
          </AField>
          {recMsg && <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.danger }}>{recMsg}</div>}
          {codes.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, background: AT.app, borderRadius: 8, padding: 12 }}>
              {codes.map((c) => (
                <code key={c} style={{ fontFamily: "monospace", fontSize: 13, color: AT.ink }}>{c}</code>
              ))}
            </div>
          )}
          <div>
            <ABtn kind="soft" onClick={() => void regenerate()} disabled={recBusy || !recoveryPw}>
              {recBusy ? "Generating…" : "Regenerate recovery codes"}
            </ABtn>
          </div>
        </div>
      </ACard>
    </div>
  );
}
