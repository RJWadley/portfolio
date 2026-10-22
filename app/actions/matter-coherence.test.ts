import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it } from "remix/test";
import { cacheSeparatingAxes, indexCompoundBounds } from "../ui/public/matter-coherence.js";

function matter() {
  const context: any = { console, setTimeout, clearTimeout };
  runInNewContext(readFileSync("public/vendor/matter.min.js", "utf8"), context);
  return context.Matter;
}

describe("collision coherence", () => {
  it("rechecks a cached separation and restores Matter on disposal", () => {
    const M = matter(), scope = new AbortController(), original = M.Collision._overlapAxes;
    let calls = 0;
    const measured = (...args: any[]) => { calls++; original(...args); };
    M.Collision._overlapAxes = measured;
    cacheSeparatingAxes(M, scope.signal);
    const a = M.Bodies.rectangle(0, 0, 20, 20), b = M.Bodies.rectangle(50, 0, 20, 20);
    assert.equal(M.Collision.collides(a, b), null);
    const first = calls;
    assert.equal(M.Collision.collides(a, b), null);
    assert.equal(calls, first);
    M.Body.setPosition(b, { x: 10, y: 0 });
    assert.ok(M.Collision.collides(a, b));
    assert.ok(calls > first);
    scope.abort();
    assert.equal(M.Collision._overlapAxes, measured);
  });
  it("prepares changing faces before SAT, skips disjoint faces, and restores on disposal", () => {
    const M = matter(), scope = new AbortController(), original = M.Collision.collides;
    cacheSeparatingAxes(M, scope.signal);
    indexCompoundBounds(M, scope.signal);
    const near = M.Bodies.rectangle(0, 0, 20, 20), far = M.Bodies.rectangle(100, 0, 20, 20),
      a = M.Body.create({ parts: [near, far] }), b = M.Bodies.rectangle(15, 0, 20, 20);
    let prepared = 0, distant = 0;
    near.prepareGlyphCollision = () => {
      prepared++;
      near.axes = M.Axes.fromVertices(near.vertices);
    };
    far.prepareGlyphCollision = () => { distant++; };
    // The broadphase already has current vertices/bounds; stale SAT axes must
    // never be consumed, including on the first candidate after a deformation.
    near.axes = [{ x: 0, y: 0 }];
    const detector = M.Detector.create({ bodies: [a, b] });
    const found = M.Detector.collisions(detector);
    assert.equal(found.length, 1);
    assert.equal(found[0].depth, 5);
    assert.equal(prepared, 1);
    assert.equal(distant, 0);
    // Direct callers (the extra floor solve) need the same preparation.
    M.Collision.collides(near, b);
    assert.equal(prepared, 2);
    scope.abort();
    assert.equal(M.Collision.collides, original);
  });
  it("matches Matter through translations, rotations and outline scaling", () => {
    const M = matter(), scope = new AbortController(), original = M.Collision._overlapAxes;
    cacheSeparatingAxes(M, scope.signal);
    const cached = M.Collision._overlapAxes;
    let seed = 20261020;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let sides = 3; sides <= 12; sides++) {
      const a = M.Bodies.polygon(0, 0, sides, 25), b = M.Bodies.polygon(0, 0, 15 - sides, 20);
      for (let pose = 0; pose < 300; pose++) {
        M.Body.setPosition(b, { x: random() * 100 - 50, y: random() * 100 - 50 });
        M.Body.setAngle(a, random() * Math.PI * 2);
        M.Body.setAngle(b, random() * Math.PI * 2);
        if (pose % 20 === 0) M.Body.scale(a, 0.9 + random() * 0.2, 0.9 + random() * 0.2);
        M.Collision._overlapAxes = original;
        const expected = M.Collision.collides(a, b);
        M.Collision._overlapAxes = cached;
        const actual = M.Collision.collides(a, b);
        assert.equal(!!actual, !!expected, `sides=${sides} pose=${pose}`);
        if (expected) {
          assert.equal(actual.depth, expected.depth);
          assert.equal(actual.normal.x, expected.normal.x);
          assert.equal(actual.normal.y, expected.normal.y);
        }
      }
    }
    scope.abort();
  });
  it("preserves compound collision order and contacts while refitting bounds", () => {
    const M = matter(), scope = new AbortController(), original = M.Detector.collisions;
    const originalAxes = M.Collision._overlapAxes;
    cacheSeparatingAxes(M, scope.signal);
    const cachedAxes = M.Collision._overlapAxes;
    indexCompoundBounds(M, scope.signal);
    const indexed = M.Detector.collisions;
    const bodies = Array.from({ length: 8 }, (_, i) => M.Body.create({
      parts: Array.from({ length: 2 + i * 3 }, (_, j) => M.Bodies.rectangle(
        i * 12 + Math.cos(j) * 35, Math.sin(j) * 35, 8 + j % 4, 8 + j % 5)),
    }));
    const detector = M.Detector.create({ bodies });
    for (let pose = 0; pose < 200; pose++) {
      for (let i = 0; i < bodies.length; i++) {
        M.Body.translate(bodies[i], { x: Math.sin(pose + i) * 3, y: Math.cos(pose * 0.3 + i) * 3 });
        M.Body.rotate(bodies[i], 0.01 * (i + 1));
        if (pose % 20 === 0) M.Body.scale(bodies[i], 1.01, 0.99);
      }
      const snapshot = (collisions: any[]) => collisions.map(c => [c.bodyA.id, c.bodyB.id, c.depth, c.normal.x, c.normal.y]);
      M.Collision._overlapAxes = originalAxes;
      const expected = snapshot(original(detector));
      M.Collision._overlapAxes = cachedAxes;
      const actual = snapshot(indexed(detector));
      assert.deepEqual(actual, expected, `compound pose=${pose}`);
    }
    scope.abort();
    assert.equal(M.Detector.collisions, original);
  });

});
