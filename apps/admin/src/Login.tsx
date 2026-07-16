import { useState } from "react";
import { api, ApiError, type AdminUser, type TotpSetup } from "./api.js";
import { useAuth } from "./auth.js";
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
      setError(errText(e, "Invalid email or password.") === "too_many_attempts" ? "Too many attempts — try again later." : "Invalid email or password.");
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

  const submitForgot = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(email.trim().toLowerCase());
      setStage("forgotSent");
    } catch {
      setError("Something went wrong — try again.");
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
      setError(
        errText(e, "") === "weak_password"
          ? "That password is too weak — use 10+ characters, not based on your name or email."
          : "This reset link is invalid or has expired. Request a new one.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (stage === "password") {
    return (
      <Panel title="Izsoli.lv" subtitle="Operations panel · LV EE LT">
        <form onSubmit={(e) => { e.preventDefault(); void submitPassword(); }} style={{ display: "grid", gap: 10 }}>
          <AInput value={email} onChange={setEmail} placeholder="email@company.com" type="email" autoFocus />
          <AInput value={password} onChange={setPassword} placeholder="Password" type="password" />
          {error && <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.danger }}>{error}</div>}
          <ABtn type="submit" kind="dark" full disabled={busy || !email || !password}>
            {busy ? "Signing in…" : "Continue"}
          </ABtn>
          <button type="button" style={linkStyle} onClick={() => { setError(null); setStage("forgot"); }}>
            Forgot password?
          </button>
        </form>
      </Panel>
    );
  }

  if (stage === "totp") {
    return (
      <Panel title="Two-factor code" subtitle="Enter the 6-digit code from your authenticator app.">
        <form onSubmit={(e) => { e.preventDefault(); void submitTotp(); }} style={{ display: "grid", gap: 10 }}>
          <AInput value={code} onChange={setCode} placeholder="123456" autoFocus />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: AT.body, fontSize: 12.5, color: AT.ink, cursor: "pointer" }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Trust this browser for 30 days
          </label>
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

  if (stage === "forgot") {
    return (
      <Panel title="Reset password" subtitle="Enter your account email — we'll send a reset link.">
        <form onSubmit={(e) => { e.preventDefault(); void submitForgot(); }} style={{ display: "grid", gap: 10 }}>
          <AInput value={email} onChange={setEmail} placeholder="email@company.com" type="email" autoFocus />
          {error && <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.danger }}>{error}</div>}
          <ABtn type="submit" kind="dark" full disabled={busy || !email}>
            {busy ? "Sending…" : "Send reset link"}
          </ABtn>
          <button type="button" style={linkStyle} onClick={() => { setError(null); setStage("password"); }}>
            Back to sign in
          </button>
        </form>
      </Panel>
    );
  }

  if (stage === "forgotSent") {
    return (
      <Panel title="Check your email" subtitle="If that address has an account, a reset link is on its way. It stays valid for 30 minutes.">
        <ABtn kind="dark" full onClick={() => setStage("password")}>
          Back to sign in
        </ABtn>
      </Panel>
    );
  }

  if (stage === "reset") {
    return (
      <Panel title="Choose a new password" subtitle="Your previous sessions will be signed out everywhere.">
        <form onSubmit={(e) => { e.preventDefault(); void submitReset(); }} style={{ display: "grid", gap: 10 }}>
          <AInput value={newPassword} onChange={setNewPassword} placeholder="New password" type="password" autoFocus />
          {error && <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.danger }}>{error}</div>}
          <ABtn type="submit" kind="dark" full disabled={busy || newPassword.length < 10}>
            {busy ? "Saving…" : "Set new password"}
          </ABtn>
        </form>
      </Panel>
    );
  }

  if (stage === "resetDone") {
    return (
      <Panel title="Password updated" subtitle="Sign in with your new password. Your authenticator code still applies.">
        <ABtn kind="dark" full onClick={() => setStage("password")}>
          Go to sign in
        </ABtn>
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
