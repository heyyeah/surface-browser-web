import * as THREE from "three";

const MAX_SEGMENT_TURN_RADIANS = THREE.MathUtils.degToRad(42);

class SeededRng {
  constructor(seed = 42) {
    this.state = seed >>> 0;
  }

  next() {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0xffffffff;
  }

  range(min, max) {
    return min + (max - min) * this.next();
  }
}

export class TunnelPath {
  constructor({ seed = 42, minRadius = 30, maxRadius = 60 } = {}) {
    this.minRadius = minRadius;
    this.maxRadius = maxRadius;
    this.rng = new SeededRng(seed);

    this.firstPoint = new THREE.Vector3(0, 0, 0);
    const halfRadius = minRadius + (maxRadius - minRadius) / 2;
    this.secondPoint = new THREE.Vector3(0, 0, -halfRadius);
    this.thirdPoint = this.#disturbPoint();

    this.firstNormal = this.#computeNormal(this.firstPoint, this.firstPoint, this.secondPoint);
    this.secondNormal = this.#computeNormal(this.firstPoint, this.secondPoint, this.thirdPoint);

    this.segmentLength = this.#computeArcLength(
      this.firstPoint,
      this.firstNormal,
      this.secondPoint,
      this.secondNormal
    );
    this.currentDistance = 0;
  }

  advance(increment) {
    let remaining = this.currentDistance + increment;

    while (remaining > this.segmentLength) {
      remaining -= this.segmentLength;
      this.#advanceSegment();
    }

    this.currentDistance = remaining;
    const t = this.currentDistance / this.segmentLength;
    const position = this.#hermitePosition(t, this.firstPoint, this.firstNormal, this.secondPoint, this.secondNormal);
    const direction = this
      .#hermiteTangent(t, this.firstPoint, this.firstNormal, this.secondPoint, this.secondNormal)
      .normalize();

    return { position, direction };
  }

  #advanceSegment() {
    this.firstPoint = this.secondPoint.clone();
    this.secondPoint = this.thirdPoint.clone();
    this.firstNormal = this.secondNormal.clone();

    this.thirdPoint = this.#disturbPoint();
    this.secondNormal = this.#computeNormal(this.firstPoint, this.secondPoint, this.thirdPoint);
    this.segmentLength = this.#computeArcLength(
      this.firstPoint,
      this.firstNormal,
      this.secondPoint,
      this.secondNormal
    );
  }

  #disturbPoint() {
    const radius = this.rng.range(this.minRadius, this.maxRadius);
    const direction = this.#nextSegmentDirection();
    return this.secondPoint.clone().add(direction.multiplyScalar(radius));
  }

  #nextSegmentDirection() {
    const theta = this.rng.range(0, Math.PI * 2);
    const phi = this.rng.range(0, Math.PI * 2);
    const candidate = new THREE.Vector3(
      Math.sin(theta) * Math.cos(phi),
      Math.sin(theta) * Math.sin(phi),
      -Math.cos(theta)
    ).normalize();
    const previousDirection = this.secondPoint.clone().sub(this.firstPoint);

    if (previousDirection.lengthSq() < 1e-6) {
      return candidate;
    }

    previousDirection.normalize();
    const turnAngle = previousDirection.angleTo(candidate);
    if (turnAngle <= MAX_SEGMENT_TURN_RADIANS) {
      return candidate;
    }

    const turnAxis = new THREE.Vector3().crossVectors(previousDirection, candidate);
    if (turnAxis.lengthSq() < 1e-8) {
      turnAxis.copy(Math.abs(previousDirection.y) < 0.9
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0)
      ).cross(previousDirection);
    }
    turnAxis.normalize();

    return previousDirection
      .clone()
      .applyAxisAngle(turnAxis, MAX_SEGMENT_TURN_RADIANS)
      .normalize();
  }

  #computeNormal(p0, p1, p2) {
    const dir = p2.clone().sub(p0).normalize();
    const dist = p2.distanceTo(p1);
    return dir.multiplyScalar(dist);
  }

  #computeArcLength(p0, t0, p1, t1) {
    const subdivisions = 4;
    let totalLength = 0;
    let prev = p0.clone();
    for (let i = 1; i <= subdivisions; i += 1) {
      const t = i / subdivisions;
      const pt = this.#hermitePosition(t, p0, t0, p1, t1);
      totalLength += pt.distanceTo(prev);
      prev = pt;
    }
    return Math.max(totalLength, 0.0001);
  }

  #hermitePosition(t, p0, t0, p1, t1) {
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 1 - 3 * t2 + 2 * t3;
    const h10 = t - 2 * t2 + t3;
    const h01 = 3 * t2 - 2 * t3;
    const h11 = t3 - t2;
    return p0
      .clone()
      .multiplyScalar(h00)
      .add(t0.clone().multiplyScalar(h10))
      .add(p1.clone().multiplyScalar(h01))
      .add(t1.clone().multiplyScalar(h11));
  }

  #hermiteTangent(t, p0, t0, p1, t1) {
    const t2 = t * t;
    const dh00 = -6 * t + 6 * t2;
    const dh10 = 1 - 4 * t + 3 * t2;
    const dh01 = 6 * t - 6 * t2;
    const dh11 = 3 * t2 - 2 * t;
    return p0
      .clone()
      .multiplyScalar(dh00)
      .add(t0.clone().multiplyScalar(dh10))
      .add(p1.clone().multiplyScalar(dh01))
      .add(t1.clone().multiplyScalar(dh11));
  }
}
