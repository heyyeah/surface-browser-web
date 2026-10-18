// Pure utility helpers shared across modules. No dependencies (clamp and
// disposeMaterial are self-contained; disposeMaterial recurses on itself).

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function disposeMaterial(material) {
  if (!material) {
    return;
  }
  if (Array.isArray(material)) {
    for (const entry of material) {
      disposeMaterial(entry);
    }
    return;
  }

  const disposedTextures = new Set();
  for (const value of Object.values(material)) {
    if (value && value.isTexture && !disposedTextures.has(value)) {
      value.dispose();
      disposedTextures.add(value);
    }
  }
  material.dispose();
}

export { clamp, disposeMaterial };
