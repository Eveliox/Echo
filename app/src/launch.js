// Brief brand introduction; never wait indefinitely for a font or image.
export function shouldRevealApp({ elapsedMs, assetsReady, emergency, nativeHidden = true }) {
  return emergency || (nativeHidden && (elapsedMs >= 1800 || (assetsReady && elapsedMs >= 900)));
}
