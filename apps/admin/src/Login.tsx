import { useState } from "react";
import { api, ApiError, type AdminUser, type LoginChallenge, type TotpSetup } from "./api.js";
import { useAuth } from "./auth.js";
import { AT } from "./theme.js";
import { ABtn, AIcon, AInput } from "./ui.js";

type Stage = "password" | "totp" | "enroll" | "recovery";

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", background: AT.side }}>
      <div style={{ width: 380, background: AT.panel, borderRadius: AT.radius, padding: 26 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <span style={{ width: 34, height: 34, borderRadius: 9, background: AT.ink, color: "#fff", display: "grid", placeItems: "center" }}>
            <AIcon name="gavel" size={18} color="#fff" />
          </span>
          <h1 style={{ fontFamily: AT.body, fontSize: 17, fontWeight: 700, color: AT.ink }}>{title}</h1>
        </div>
        <p style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, marginBottom: 18 }}>{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

const errText = (e: unknown, fallback: string): string =>
  e instanceof ApiError && typeof e.body.error === "string" ? e.body.error : fallback;

export function LoginScreen() {
  const { onAuthenticated } = useAuth();
  const [stage, setStage] = useState<Stage>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
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
      const ch: LoginChallenge = await api.loginPassword(email.trim().toLowerCase(), password);
      setChallengeToken(ch.challengeToken);
      if (ch.challenge === "totp") {
        setStage("totp");
      } else {
        setSetup(await api.setup2fa(ch.challengeToken));
        setStage("enroll");
      }
    } catch (e) {
      setError(errText(e, "Invalid email or password.") === "too_many_attempts" ? "Too many attempts — try again later." : "Invalid email or password.");
    } finally {
      setBusy(false);
    }
  };

  const submitTotp = async () => {
    setBusy(true);
    setError(null);
    try {
      onAuthenticated(await api.completeTotp(challengeToken, code.trim()));
    } catch {
      setError("Incorrect code. Enter the current 6-digit code (or a recovery code).");
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
      setError("That code didn't match. Check your authenticator and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (stage === "password") {
    return (
      <Panel title="Auction Admin" subtitle="Baltic auction house · operations panel">
        <form onSubmit={(e) => { e.preventDefault(); void submitPassword(); }} style={{ display: "grid", gap: 10 }}>
          <AInput value={email} onChange={setEmail} placeholder="email@company.com" type="email" autoFocus />
          <AInput value={password} onChange={setPassword} placeholder="Password" type="password" />
          {error && <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.danger }}>{error}</div>}
          <ABtn type="submit" kind="dark" full disabled={busy || !email || !password}>
            {busy ? "Signing in…" : "Continue"}
          </ABtn>
        </form>
      </Panel>
    );
  }

  if (stage === "totp") {
    return (
      <Panel title="Two-factor code" subtitle="Enter the 6-digit code from your authenticator app.">
        <form onSubmit={(e) => { e.preventDefault(); void submitTotp(); }} style={{ display: "grid", gap: 10 }}>
          <AInput value={code} onChange={setCode} placeholder="123456" autoFocus />
          {error && <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.danger }}>{error}</div>}
          <ABtn type="submit" kind="dark" full disabled={busy || code.trim().length < 6}>
            {busy ? "Verifying…" : "Verify"}
          </ABtn>
        </form>
      </Panel>
    );
  }

  if (stage === "enroll") {
    return (
      <Panel title="Set up two-factor" subtitle="This account requires an authenticator. Add the key below, then enter the code it shows.">
        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, marginBottom: 4 }}>Secret key (manual entry)</div>
            <code style={{ display: "block", fontFamily: "monospace", fontSize: 13, letterSpacing: 1, background: AT.app, borderRadius: 8, padding: "10px 12px", wordBreak: "break-all", color: AT.ink }}>
              {setup?.secret}
            </code>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); void submitEnable(); }} style={{ display: "grid", gap: 10 }}>
            <AInput value={code} onChange={setCode} placeholder="Code from app" autoFocus />
            {error && <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.danger }}>{error}</div>}
            <ABtn type="submit" kind="dark" full disabled={busy || code.trim().length < 6}>
              {busy ? "Enabling…" : "Enable two-factor"}
            </ABtn>
          </form>
        </div>
      </Panel>
    );
  }

  // recovery
  return (
    <Panel title="Save your recovery codes" subtitle="Store these somewhere safe. Each code works once if you lose your authenticator.">
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, background: AT.app, borderRadius: 8, padding: 12 }}>
          {recovery.map((c) => (
            <code key={c} style={{ fontFamily: "monospace", fontSize: 13, color: AT.ink }}>{c}</code>
          ))}
        </div>
        <ABtn kind="dark" full onClick={() => { if (pendingUser) onAuthenticated(pendingUser); }}>
          I've saved them — continue
        </ABtn>
      </div>
    </Panel>
  );
}
