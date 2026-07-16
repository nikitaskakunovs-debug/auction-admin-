import { useState } from "react";
import { api, ApiError, type AdminUser, type TotpSetup } from "./api.js";
import { useAuth } from "./auth.js";
import { useT } from "./i18n.js";
import { LangSwitch } from "./LangSwitch.js";
import { AT } from "./theme.js";
import { ABtn, AIcon, AInput } from "./ui.js";

type Stage = "password" | "totp" | "enroll" | "recovery" | "forgot" | "forgotSent" | "reset" | "resetDone";

/** An emailed reset link lands on `#/reset?token=…` while logged out. */
function resetTokenFromHash(): string | null {
  const m = /^#\/reset\?token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  return m ? m[1]! : null;
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", background: AT.side }}>
      <div style={{ display: "grid", gap: 14, justifyItems: "center" }}>
        <div style={{ width: 380, background: AT.panel, borderRadius: AT.radius, padding: 26, boxShadow: "0 18px 60px rgba(0,0,0,0.35)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span style={{ width: 34, height: 34, borderRadius: 9, background: AT.ink, color: "#fff", display: "grid", placeItems: "center" }}>
              <AIcon name="gavel" size={18} color="#fff" />
            </span>
            <h1 style={{ fontFamily: AT.body, fontSize: 17, fontWeight: 700, color: AT.ink }}>{title}</h1>
          </div>
          <p style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, marginBottom: 18 }}>{subtitle}</p>
          {children}
        </div>
        <LangSwitch dark />
      </div>
    </div>
  );
}

const errText = (e: unknown, fallback: string): string =>
  e instanceof ApiError && typeof e.body.error === "string" ? e.body.error : fallback;

const linkStyle: React.CSSProperties = {
  fontFamily: AT.body,
  fontSize: 12.5,
  color: AT.inkSoft,
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  textDecoration: "underline",
  justifySelf: "start",
};

export function LoginScreen() {
  const { onAuthenticated } = useAuth();
  const { t } = useT();
  const [resetToken] = useState<string | null>(() => resetTokenFromHash());
  const [stage, setStage] = useState<Stage>(resetToken ? "reset" : "password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [newPassword, setNewPassword] = useState("");
  const [challengeToken, setChallengeToken] = useState("");
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [recovery, setRecovery] = useState<string[]>([]);
  const [pendingUser, setPendingUser] = useState<AdminUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitPassword = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.loginPassword(email.trim().toLowerCase(), password);
      if ("user" in r) {
        // Trusted device: the server signed us in without the code step.
        onAuthenticated(r.user);
        return;
      }
      setChallengeToken(r.challengeToken);
      if (r.challenge === "totp") {
        setStage("totp");
      } else {
        setSetup(await api.setup2fa(r.challengeToken));
        setStage("enroll");
      }
    } catch (e) {
      setError(errText(e, "") === "too_many_attempts" ? t("login.tooMany") : t("login.invalid"));
    } finally {
      setBusy(false);
    }
  };

  const submitTotp = async () => {
    setBusy(true);
    setError(null);
    try {
      onAuthenticated(await api.completeTotp(challengeToken, code.trim(), remember));
    } catch {
      setError(t("login.badCode"));
    } finally {
      setBusy(false);
    }
  };

  const submitEnable = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.enable2fa(code.trim(), challengeToken);
      setRecovery(r.recoveryCodes);
      setPendingUser(r.user ?? null);
      setStage("recovery");
    } catch {
      setError(t("login.codeMismatch"));
    } finally {
      setBusy(false);
    }
  };

  const submitForgot = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(email.trim().toLowerCase());
      setStage("forgotSent");
    } catch {
      setError(t("login.error"));
    } finally {
      setBusy(false);
    }
  };

  const submitReset = async () => {
    if (!resetToken) return;
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(resetToken, newPassword);
      window.location.hash = "";
      setStage("resetDone");
    } catch (e) {
      setError(errText(e, "") === "weak_password" ? t("login.weakPassword") : t("login.badResetLink"));
    } finally {
      setBusy(false);
    }
  };

  if (stage === "password") {
    return (
      <Panel title="Izsoli.lv" subtitle={t("login.subtitle")}>
        <form onSubmit={(e) => { e.preventDefault(); void submitPassword(); }} style={{ display: "grid", gap: 10 }}>
          <AInput value={email} onChange={setEmail} placeholder={t("login.email")} type="email" autoFocus />
          <AInput value={password} onChange={setPassword} placeholder={t("login.password")} type="password" />
          {error && <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.danger }}>{error}</div>}
          <ABtn type="submit" kind="dark" full disabled={busy || !email || !password}>
            {busy ? t("login.signingIn") : t("login.continue")}
          </ABtn>
          <button type="button" style={linkStyle} onClick={() => { setError(null); setStage("forgot"); }}>
            {t("login.forgot")}
          </button>
        </form>
      </Panel>
    );
  }

  if (stage === "totp") {
    return (
      <Panel title={t("login.totpTitle")} subtitle={t("login.totpSub")}>
        <form onSubmit={(e) => { e.preventDefault(); void submitTotp(); }} style={{ display: "grid", gap: 10 }}>
          <AInput value={code} onChange={setCode} placeholder="123456" autoFocus />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: AT.body, fontSize: 12.5, color: AT.ink, cursor: "pointer" }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {t("login.trustDevice")}
          </label>
          {error && <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.danger }}>{error}</div>}
          <ABtn type="submit" kind="dark" full disabled={busy || code.trim().length < 6}>
            {busy ? t("login.verifying") : t("login.verify")}
          </ABtn>
        </form>
      </Panel>
    );
  }

  if (stage === "enroll") {
    return (
      <Panel title={t("login.enrollTitle")} subtitle={t("login.enrollSub")}>
        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, marginBottom: 4 }}>{t("login.secretKey")}</div>
            <code style={{ display: "block", fontFamily: "monospace", fontSize: 13, letterSpacing: 1, background: AT.app, borderRadius: 8, padding: "10px 12px", wordBreak: "break-all", color: AT.ink }}>
              {setup?.secret}
            </code>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); void submitEnable(); }} style={{ display: "grid", gap: 10 }}>
            <AInput value={code} onChange={setCode} placeholder={t("login.codeFromApp")} autoFocus />
            {error && <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.danger }}>{error}</div>}
            <ABtn type="submit" kind="dark" full disabled={busy || code.trim().length < 6}>
              {busy ? t("login.enabling") : t("login.enable")}
            </ABtn>
          </form>
        </div>
      </Panel>
    );
  }

  if (stage === "forgot") {
    return (
      <Panel title={t("login.forgotTitle")} subtitle={t("login.forgotSub")}>
        <form onSubmit={(e) => { e.preventDefault(); void submitForgot(); }} style={{ display: "grid", gap: 10 }}>
          <AInput value={email} onChange={setEmail} placeholder={t("login.email")} type="email" autoFocus />
          {error && <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.danger }}>{error}</div>}
          <ABtn type="submit" kind="dark" full disabled={busy || !email}>
            {busy ? t("login.sending") : t("login.sendLink")}
          </ABtn>
          <button type="button" style={linkStyle} onClick={() => { setError(null); setStage("password"); }}>
            {t("login.backToSignIn")}
          </button>
        </form>
      </Panel>
    );
  }

  if (stage === "forgotSent") {
    return (
      <Panel title={t("login.sentTitle")} subtitle={t("login.sentSub")}>
        <ABtn kind="dark" full onClick={() => setStage("password")}>
          {t("login.backToSignIn")}
        </ABtn>
      </Panel>
    );
  }

  if (stage === "reset") {
    return (
      <Panel title={t("login.resetTitle")} subtitle={t("login.resetSub")}>
        <form onSubmit={(e) => { e.preventDefault(); void submitReset(); }} style={{ display: "grid", gap: 10 }}>
          <AInput value={newPassword} onChange={setNewPassword} placeholder={t("login.newPassword")} type="password" autoFocus />
          {error && <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.danger }}>{error}</div>}
          <ABtn type="submit" kind="dark" full disabled={busy || newPassword.length < 10}>
            {busy ? t("login.saving") : t("login.setPassword")}
          </ABtn>
        </form>
      </Panel>
    );
  }

  if (stage === "resetDone") {
    return (
      <Panel title={t("login.doneTitle")} subtitle={t("login.doneSub")}>
        <ABtn kind="dark" full onClick={() => setStage("password")}>
          {t("login.goToSignIn")}
        </ABtn>
      </Panel>
    );
  }

  // recovery
  return (
    <Panel title={t("login.recoveryTitle")} subtitle={t("login.recoverySub")}>
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, background: AT.app, borderRadius: 8, padding: 12 }}>
          {recovery.map((c) => (
            <code key={c} style={{ fontFamily: "monospace", fontSize: 13, color: AT.ink }}>{c}</code>
          ))}
        </div>
        <ABtn kind="dark" full onClick={() => { if (pendingUser) onAuthenticated(pendingUser); }}>
          {t("login.recoverySaved")}
        </ABtn>
      </div>
    </Panel>
  );
}
