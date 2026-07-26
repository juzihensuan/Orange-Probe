const regionNames = new Intl.DisplayNames(["zh-CN", "en"], { type: "region" });

export function normalizeCountryCode(value) {
  const code = String(value || "").trim().toUpperCase();
  if (code === "UK") return "GB";
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

function countryLocation(countryCode) {
  try {
    return regionNames.of(countryCode) || countryCode;
  } catch {
    return countryCode;
  }
}

async function countryIsLookup() {
  const response = await fetch("https://api.country.is/", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`country.is HTTP ${response.status}`);
  const payload = await response.json();
  const countryCode = normalizeCountryCode(payload?.country);
  if (!countryCode) throw new Error("country.is returned no country code");
  return { countryCode, location: countryLocation(countryCode) };
}

async function ipWhoLookup() {
  const response = await fetch("https://ipwho.is/", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`ipwho.is HTTP ${response.status}`);
  const payload = await response.json();
  const countryCode = normalizeCountryCode(payload?.country_code);
  if (payload?.success === false || !countryCode) throw new Error("ipwho.is returned no country code");
  return { countryCode, location: countryLocation(countryCode) };
}

export async function resolveRegion({ automatic = true, fallback = "" } = {}) {
  const fallbackText = String(fallback || "").trim();
  if (!automatic) {
    const countryCode = normalizeCountryCode(fallbackText);
    return { countryCode, location: countryCode ? countryLocation(countryCode) : fallbackText || "Remote" };
  }
  try {
    return await Promise.any([countryIsLookup(), ipWhoLookup()]);
  } catch {
    const countryCode = normalizeCountryCode(fallbackText);
    return { countryCode, location: countryCode ? countryLocation(countryCode) : fallbackText || "Remote" };
  }
}
