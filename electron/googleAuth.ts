const manualGoogleAuthUrlMarkers = [
  "accounts.google.com",
  "signin",
  "challenge",
  "password"
];

const manualGoogleAuthTextMarkers = [
  "verify it's you",
  "verify it’s you",
  "to continue, first verify",
  "to continue first verify",
  "confirm it's you",
  "confirm it’s you",
  "2-step verification",
  "two-step verification",
  "enter your password",
  "use your passkey",
  "get a verification code",
  "choose an account"
];

export function isManualGoogleAuthChallenge(url: string | null | undefined, pageText = "") {
  const normalizedUrl = String(url || "").toLowerCase();
  if (manualGoogleAuthUrlMarkers.some((marker) => normalizedUrl.includes(marker))) {
    return true;
  }

  const normalizedText = pageText.replace(/\s+/g, " ").toLowerCase();
  return manualGoogleAuthTextMarkers.some((marker) => normalizedText.includes(marker));
}
