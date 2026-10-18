import * as THREE from "three";

export function buildCurvedPlaneGeometry({
  radius,
  arcLength,
  height,
  segments = 10
}) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  const angleSpan = arcLength / radius;
  const startAngle = -angleSpan / 2;
  const angleIncrement = angleSpan / segments;

  const topZ = height / 2;
  const bottomZ = -height / 2;

  for (let row = 0; row <= 1; row += 1) {
    const z = row === 0 ? topZ : bottomZ;
    const v = row === 0 ? 1 : 0;
    for (let col = 0; col <= segments; col += 1) {
      const angle = startAngle + col * angleIncrement;
      const x = Math.sin(angle) * radius;
      const y = Math.cos(angle) * radius;

      positions.push(x, y, z);
      normals.push(-Math.sin(angle), -Math.cos(angle), 0);
      uvs.push(col / segments, v);
    }
  }

  for (let col = 0; col < segments; col += 1) {
    const top0 = col;
    const top1 = col + 1;
    const bottom0 = col + segments + 1;
    const bottom1 = col + segments + 2;

    indices.push(top0, bottom0, top1, bottom0, bottom1, top1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  return geometry;
}
