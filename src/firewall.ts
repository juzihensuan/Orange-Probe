interface FirewallBlockedPayload {
  blocked?: boolean;
  ip?: string;
}

let interceptorInstalled = false;
let blockedPageVisible = false;

export function showFirewallBlockedPage(ip?: string) {
  if (blockedPageVisible) return;
  blockedPageVisible = true;
  document.title = "UFW 提示";
  document.body.className = "ufw-blocked-body";

  const page = document.createElement("main");
  page.className = "ufw-blocked-page";
  const panel = document.createElement("section");
  panel.className = "ufw-blocked-panel";
  const label = document.createElement("span");
  label.className = "ufw-blocked-label";
  label.textContent = "UFW 提示";
  const title = document.createElement("h1");
  title.textContent = "你的 IP 已被封禁";
  const address = document.createElement("div");
  address.className = "ufw-blocked-address";
  const addressLabel = document.createElement("span");
  addressLabel.textContent = "IP";
  const addressValue = document.createElement("code");
  addressValue.textContent = String(ip || "未知");
  address.append(addressLabel, addressValue);
  panel.append(label, title, address);
  page.append(panel);
  document.body.replaceChildren(page);
}

export function installFirewallResponseInterceptor() {
  if (interceptorInstalled) return;
  interceptorInstalled = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (response.status === 403) {
      try {
        const payload = await response.clone().json() as FirewallBlockedPayload;
        if (payload.blocked) showFirewallBlockedPage(payload.ip);
      } catch {
        // Non-firewall 403 responses continue through the normal application flow.
      }
    }
    return response;
  };
}
