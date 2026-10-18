import * as THREE from "three";
import { TunnelPath } from "./tunnel-path.js";

export function buildTunnel({
  rings = 2200,
  pathRings = 2400,
  segments = 16,
  radius = 2.0,
  distBetweenRings = 0.8
} = {}) {
  const path = new TunnelPath();
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const centers = [];
  const forwards = [];
  const ups = [];
  const rights = [];

  const textureRepeatV = 3.0;
  const distMod = textureRepeatV / (2.0 * Math.PI * radius);

  let currentUp = new THREE.Vector3(0, 1, 0);

  for (let ring = 0; ring < pathRings; ring += 1) {
    const { position: center, direction: forward } = path.advance(distBetweenRings);
    const fwd = forward.clone().normalize();
    let up = currentUp.clone();
    if (Math.abs(up.dot(fwd)) > 0.99) {
      up = Math.abs(new THREE.Vector3(1, 0, 0).dot(fwd)) < 0.9
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 0, 1);
    }
    const right = fwd.clone().cross(up).normalize();
    up = right.clone().cross(fwd).normalize();
    currentUp = up.clone();

    centers.push(center);
    forwards.push(fwd);
    ups.push(up);
    rights.push(right);

    if (ring >= rings) {
      continue;
    }

    const angleIncrement = (2.0 * Math.PI) / segments;
    const uCoord = ring * distBetweenRings * distMod;

    for (let seg = 0; seg <= segments; seg += 1) {
      const angle = (seg % segments) * angleIncrement;
      const localX = Math.cos(angle) * radius;
      const localY = Math.sin(angle) * radius;
      const worldPos = center.clone().add(right.clone().multiplyScalar(localX)).add(up.clone().multiplyScalar(localY));
      const normal = center.clone().sub(worldPos).normalize();

      positions.push(worldPos.x, worldPos.y, worldPos.z);
      normals.push(normal.x, normal.y, normal.z);
      const vCoord = (seg / segments) * textureRepeatV;
      uvs.push(uCoord, vCoord);
    }

    if (ring === 0) {
      continue;
    }

    const vertsPerRing = segments + 1;
    const currRingStart = ring * vertsPerRing;
    const prevRingStart = currRingStart - vertsPerRing;

    for (let seg = 0; seg < segments; seg += 1) {
      const curr0 = currRingStart + seg;
      const curr1 = currRingStart + seg + 1;
      const prev0 = prevRingStart + seg;
      const prev1 = prevRingStart + seg + 1;
      indices.push(prev0, curr0, prev1, prev1, curr0, curr1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  return {
    geometry,
    samples: {
      centers,
      forwards,
      ups,
      rights
    },
    config: {
      rings,
      pathRings,
      segments,
      radius,
      distBetweenRings
    }
  };
}

// `out` is optional. Pass { pos, forward, up, right } (four Vector3s) to write
// into it and avoid per-frame allocation; only do so when the result is
// consumed before the next call. Without it the returned vectors are fresh,
// since callers (getRingVectors) republish them and a shared buffer would alias.
export function sampleAlongPath(samples, progress, out = null) {
  const { centers, forwards, ups, rights } = samples;
  const maxIndex = centers.length - 2;
  if (maxIndex <= 1) {
    return null;
  }

  const wrapped = ((progress % maxIndex) + maxIndex) % maxIndex;
  const idx = Math.floor(wrapped);
  const alpha = wrapped - idx;

  const pos = (out ? out.pos.copy(centers[idx]) : centers[idx].clone())
    .lerp(centers[idx + 1], alpha);
  const forward = (out ? out.forward.copy(forwards[idx]) : forwards[idx].clone())
    .lerp(forwards[idx + 1], alpha).normalize();
  const up = (out ? out.up.copy(ups[idx]) : ups[idx].clone())
    .lerp(ups[idx + 1], alpha).normalize();
  const right = (out ? out.right.copy(rights[idx]) : rights[idx].clone())
    .lerp(rights[idx + 1], alpha).normalize();

  return out || { pos, forward, up, right };
}
