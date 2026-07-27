function regionCountryCode(location: string, suppliedCode = "") {
  const code = suppliedCode.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(code)) return code === "uk" ? "gb" : code;
  const normalized = location.trim().toLowerCase();
  if (normalized.includes("hong kong") || normalized.includes("hong-kong") || normalized.includes("香港") || normalized === "hk") return "hk";
  if (normalized.includes("singapore") || normalized === "sg") return "sg";
  if (normalized.includes("frankfurt") || normalized.includes("germany") || normalized.includes("德国") || normalized === "de") return "de";
  if (normalized.includes("tokyo") || normalized.includes("japan") || normalized.includes("日本") || normalized === "jp") return "jp";
  if (normalized.includes("united states") || normalized.includes("usa") || normalized.includes("美国") || normalized === "us") return "us";
  if (normalized.includes("united kingdom") || normalized.includes("london") || normalized === "uk" || normalized === "gb") return "gb";
  if (normalized.includes("canada") || normalized.includes("加拿大") || normalized === "ca") return "ca";
  if (normalized.includes("australia") || normalized.includes("澳大利亚") || normalized === "au") return "au";
  if (normalized.includes("taiwan") || normalized.includes("台湾") || normalized === "tw") return "tw";
  if (normalized.includes("south korea") || normalized.includes("korea") || normalized.includes("韩国") || normalized === "kr") return "kr";
  return "";
}

export default function RegionFlag({ location, countryCode = "", className = "" }: { location: string; countryCode?: string; className?: string }) {
  const code = regionCountryCode(location, countryCode);
  return <span className={`region-flag ${code ? "flag-image" : "flag-generic"}${className ? ` ${className}` : ""}`} aria-label={location} title={location} role="img">{code ? <img src={`/flags/${code}.svg`} alt="" /> : <i />}</span>;
}
