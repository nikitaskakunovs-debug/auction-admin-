import { useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import { t as tNow, useT } from "../i18n.js";
import { AT } from "../theme.js";
import { ABtn, ABadge, ACard, AField, AInput } from "../ui.js";

const errorList = (e: unknown): string => {
  if (e instanceof ApiError) {
    if (Array.isArray(e.body.detail)) return (e.body.detail as string[]).join(" ");
    if (typeof e.body.error === "string") return e.body.error.replace(/_/g, " ");
  }
  return tNow("c.error");
};

export function SecurityScreen() {
  const { t } = useT();
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
      setPwMsg({ ok: false, text: t("ms.pwMismatch") });
      return;
    }
    setPwBusy(true);
    try {
      await api.changePassword(cur, next);
      setPwMsg({ ok: true, text: t("ms.pwChanged") });
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
        <h2 style={{ fontFamily: AT.body, fontSize: 18, fontWeight: 700, color: AT.ink, margin: 0 }}>{t("ms.secTitle")}</h2>
        <p style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, margin: "4px 0 0" }}>
          {t("ms.signedInAs")} {user?.email}
        </p>
      </div>

      <ACard title={t("ms.twoFactor")}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ABadge tone={user?.totpEnabled ? "ok" : "danger"}>{user?.totpEnabled ? t("ms.enabled") : t("ms.notEnrolled")}</ABadge>
          <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
            {t("ms.twoFactorNote")}
          </span>
        </div>
      </ACard>

      <ACard title={t("ms.changePassword")}>
        <div style={{ display: "grid", gap: 12 }}>
          <AField label={t("ms.currentPassword")}>
            <AInput value={cur} onChange={setCur} type="password" placeholder={t("ms.currentPassword")} />
          </AField>
          <AField label={t("ms.newPassword")} hint={t("ms.pwHint")}>
            <AInput value={next} onChange={setNext} type="password" placeholder={t("ms.newPassword")} />
          </AField>
          <AField label={t("ms.confirmNewPassword")}>
            <AInput value={confirm} onChange={setConfirm} type="password" placeholder={t("ms.repeatNewPassword")} />
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
