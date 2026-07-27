import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installFirewallResponseInterceptor } from "./firewall";
import "./styles.css";

installFirewallResponseInterceptor();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
