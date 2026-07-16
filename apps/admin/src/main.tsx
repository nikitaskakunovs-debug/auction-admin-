import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AuthProvider } from "./auth.js";
import { initSentry } from "./sentry.js";
import { ConfirmProvider, ToastProvider } from "./ui.js";

initSentry();

createRoot(document.getElementById("root")!).render(
  <AuthProvider>
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </AuthProvider>,
);
