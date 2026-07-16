import { useEffect, useRef, useState } from "react";
import { AT } from "../theme.js";

/**
 * In-browser QR scanning with the phone camera — no app install, works in
 * Safari (iPhone) and Chrome (Android) over HTTPS. Uses the platform's native
 * BarcodeDetector when available (fast, hardware-assisted on Android) and
 * falls back to jsQR frame decoding everywhere else. Both are bundled — no
 * network dependency, so it keeps working on flaky warehouse wifi.
 */

/** Pull a lookup code out of whatever the QR encodes (raw id/SKU, or a URL). */
export function normalizeScan(text: string): string {
  const t = text.trim();
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      const qp = u.searchParams.get("code");
      if (qp) return qp.trim();
      const seg = u.pathname.split("/").filter(Boolean).pop();
      if (seg) return seg.trim();
    } catch {
      /* fall through to raw text */
    }
  }
  return t;
}

/** Minimal typing for the (not-yet-standard-lib) BarcodeDetector API. */
interface BarcodeHit {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<BarcodeHit[]>;
}
interface BarcodeDetectorCtor {
  new (opts: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

export function CameraScanner({ hint, onCode, onClose }: {
  hint: string;
  onCode: (raw: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let done = false;
    const canvas = document.createElement("canvas");

    const finish = (text: string) => {
      if (done || !text) return;
      done = true;
      navigator.vibrate?.(80); // haptic "beep" — ignored where unsupported
      onCode(text);
    };

    const start = async () => {
      try {
        // Rear camera preferred; front is a usable fallback on desktops.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch {
        setError("Camera access was blocked. Allow the camera for this site in your browser settings — or close this and type the code.");
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);

      // Native path (Android Chrome et al.) — hardware-assisted and accurate.
      let detector: BarcodeDetectorLike | null = null;
      const BD = (window as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      if (BD) {
        try {
          const formats = await BD.getSupportedFormats?.();
          if (!formats || formats.includes("qr_code")) detector = new BD({ formats: ["qr_code"] });
        } catch {
          detector = null;
        }
      }

      // jsQR is code-split: only warehouse phones without a native detector
      // ever download it — the admin bundle stays lean for everyone else.
      const jsQR = detector ? null : (await import("jsqr")).default;

      const tick = async () => {
        if (done || !video.videoWidth) return;
        if (detector) {
          try {
            const hits = await detector.detect(video);
            if (hits.length > 0 && hits[0]!.rawValue) finish(hits[0]!.rawValue);
            return;
          } catch {
            detector = null; // native path broke — jsQR loads on the next tick
          }
        }
        const decode = jsQR ?? (await import("jsqr")).default;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const hit = decode(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        if (hit?.data) finish(hit.data);
      };

      // ~6 decode attempts/second — instant in practice, easy on the battery.
      timer = setInterval(() => void tick(), 160);
    };

    void start();
    return () => {
      done = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "#000", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", color: "#fff" }}>
        <span style={{ fontSize: 15, fontWeight: 700, fontFamily: AT.body }}>{hint}</span>
        <button onClick={onClose} style={{ all: "unset", cursor: "pointer", fontSize: 15, fontWeight: 800, padding: "6px 10px", color: "#fff" }}>
          ✕ Close
        </button>
      </div>
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <video ref={videoRef} playsInline muted style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        {/* Aiming frame */}
        <div style={{
          position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          width: "min(62vw, 300px)", aspectRatio: "1", border: "3px solid rgba(255,255,255,0.9)",
          borderRadius: 18, boxShadow: "0 0 0 2000px rgba(0,0,0,0.35)",
        }} />
        {error && (
          <div style={{
            position: "absolute", left: 16, right: 16, bottom: 24, background: "#7A1B1E", color: "#fff",
            borderRadius: 12, padding: "12px 14px", fontSize: 14, fontWeight: 600, fontFamily: AT.body,
          }}>{error}</div>
        )}
      </div>
    </div>
  );
}
