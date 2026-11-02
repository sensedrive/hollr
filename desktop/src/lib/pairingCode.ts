// One-time pairing code (`hollr pair` shows it under the QR code), e.g. K7Q2-M9XA-3PLD-W8RT.
// Decoding and the exchange live in Rust (pairing_code.rs); this is the input side.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U

/** "k7q2 m9xa-3pld w8rt" → "K7Q2-M9XA-3PLD-W8RT" (while typing and on paste). */
export function formatCode(input: string): string {
  const clean = [...input.toUpperCase()]
    .map((c) => (c === "O" ? "0" : c === "I" || c === "L" ? "1" : c))
    .filter((c) => ALPHABET.includes(c))
    .slice(0, 16)
    .join("");
  return clean.match(/.{1,4}/g)?.join("-") ?? "";
}

/** All 16 characters there. */
export const isCompleteCode = (input: string) => formatCode(input).replaceAll("-", "").length === 16;

/** Pasted text that is a code and nothing else (not any long text that happens to yield 16 characters). */
export const isPastedCode = (text: string) => text.replace(/[\s-]/g, "").length === 16 && isCompleteCode(text);

/** 100.64.0.0/10 */
export function isTailscaleAddress(host: string): boolean {
  const parts = host.split(".").map(Number);
  return parts.length === 4 && parts.every(Number.isInteger) && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}
