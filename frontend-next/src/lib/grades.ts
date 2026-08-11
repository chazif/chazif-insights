// Grade / rating → Pill tone. Handles the several label vocabularies the backend emits:
// letter grades ("A", "A — Top Performer"), QS score labels ("Strong", "Below Avg", "Poor"),
// and component ratings ("Above average" / "Average" / "Below average").
export type Tone = "pos" | "warn" | "neg" | "neutral";

export function gradeTone(g: string | null | undefined): Tone {
  const s = (g || "").trim().toLowerCase();
  if (!s) return "neutral";
  const c = s[0];
  if (c === "a" && !s.startsWith("average") && !s.startsWith("above")) return "pos"; // "A — …"
  if (c === "b") return "pos";
  if (c === "c" || c === "d") return "warn";
  if (c === "f") return "neg";
  // word labels
  if (s.includes("above") || s.includes("strong") || s.includes("top")) return "pos";
  if (s.includes("below") || s.includes("poor")) return "neg";
  if (s.includes("average") || s.includes("low volume")) return s.includes("below") ? "neg" : "neutral";
  return "neutral";
}

// Score labels used on landing pages ("Strong" / "Above Avg" / "Average" / "Below Avg" / "Poor").
export function scoreTone(s: string | null | undefined): Tone {
  const t = (s || "").trim().toLowerCase();
  if (t.includes("strong") || t.includes("above")) return "pos";
  if (t.includes("below") || t.includes("poor")) return "neg";
  if (t.includes("average")) return "neutral";
  return gradeTone(s);
}

// Component rating tone (Above / Average / Below).
export function ratingTone(r: string | null | undefined): Tone {
  const s = (r || "").toLowerCase();
  if (s.includes("above")) return "pos";
  if (s.includes("below")) return "neg";
  return "neutral";
}

// Show a landing-page URL as path + query, dropping scheme + host (the client knows their domain).
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search || "/";
  } catch {
    return url;
  }
}
