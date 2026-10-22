const projectionScopes = new WeakMap();
// A cached separating axis can reject a convex pair without repeating its full
// SAT search. Reproject current vertices every time: rotation, morphing, and
// impulses cannot turn this cache into a stale collision answer. If separation
// disappears, Matter performs its original complete test and contact solve.
export function cacheSeparatingAxes(Matter, signal) {
  const Collision = Matter.Collision,
    originalCollides = Collision.collides,
    original = Collision._overlapAxes,
    cache = new WeakMap(),
    projections = new WeakMap(),
    scope = { active: false, epoch: 0 };
  projectionScopes.set(Matter, scope);
  function fullTest(result, a, b, axes) {
    if (!scope.active) return original(result, a, b, axes);
    let own = projections.get(axes);
    if (!own || own.min.length < axes.length) {
      const capacity = Math.max(8, axes.length);
      projections.set(axes, (own = {
        min: new Float64Array(capacity), max: new Float64Array(capacity), stamp: new Float64Array(capacity),
      }));
    }
    let smallest = Number.MAX_VALUE, selected = 0;
    for (let i = 0; i < axes.length; i++) {
      const x = axes[i].x, y = axes[i].y;
      let loA, hiA;
      if (own.stamp[i] === scope.epoch) { loA = own.min[i]; hiA = own.max[i]; }
      else {
        loA = hiA = a[0].x * x + a[0].y * y;
        for (let j = 1; j < a.length; j++) {
          const value = a[j].x * x + a[j].y * y;
          if (value > hiA) hiA = value;
          else if (value < loA) loA = value;
        }
        own.min[i] = loA; own.max[i] = hiA; own.stamp[i] = scope.epoch;
      }
      let loB = b[0].x * x + b[0].y * y, hiB = loB;
      for (let j = 1; j < b.length; j++) {
        const value = b[j].x * x + b[j].y * y;
        if (value > hiB) hiB = value;
        else if (value < loB) loB = value;
      }
      const ab = hiA - loB, ba = hiB - loA, distance = ab < ba ? ab : ba;
      if (distance < smallest) {
        smallest = distance; selected = i;
        if (distance <= 0) break;
      }
    }
    result.axis = axes[selected]; result.overlap = smallest;
  }
  function overlap(result, a, b, axes) {
    let row = cache.get(a);
    if (!row) cache.set(a, (row = new WeakMap()));
    let saved = row.get(b);
    if (saved && a.length && b.length) {
      const x = saved.x, y = saved.y;
      let loA = Infinity, hiA = -Infinity, loB = Infinity, hiB = -Infinity;
      for (let i = 0; i < a.length; i++) {
        const v = a[i].x * x + a[i].y * y;
        if (v < loA) loA = v;
        if (v > hiA) hiA = v;
      }
      for (let i = 0; i < b.length; i++) {
        const v = b[i].x * x + b[i].y * y;
        if (v < loB) loB = v;
        if (v > hiB) hiB = v;
      }
      const distance = Math.min(hiA - loB, hiB - loA);
      if (distance < -1e-8) {
        result.overlap = distance;
        result.axis = saved;
        return;
      }
    }
    fullTest(result, a, b, axes);
    if (result.overlap <= 0 && result.axis) {
      if (!saved) row.set(b, (saved = { x: 0, y: 0 }));
      saved.x = result.axis.x;
      saved.y = result.axis.y;
      // Either polygon's axis separates the same pair. Share it in both
      // directions so Matter's first pass can reuse a second-pass rejection.
      let reverse = cache.get(b);
      if (!reverse) cache.set(b, (reverse = new WeakMap()));
      reverse.set(a, saved);
    }
  }
  function preparedCollides(a, b, pairs) {
    a.prepareGlyphCollision?.(); b.prepareGlyphCollision?.();
    if (a.vertices.length < 3 || b.vertices.length < 3) return null;
    return originalCollides(a, b, pairs);
  }
  Collision.collides = preparedCollides;
  Collision._overlapAxes = overlap;
  signal.addEventListener('abort', () => {
    if (Collision._overlapAxes === overlap) Collision._overlapAxes = original;
    if (Collision.collides === preparedCollides) Collision.collides = originalCollides;
    if (projectionScopes.get(Matter) === scope) projectionScopes.delete(Matter);
  }, { once: true });
}

// Refit a small hierarchy of each compound's existing part AABBs. Matter's
// stock detector compares every A part with every B part after parent overlap;
// thin curved letters have many parts but only a few can touch. The hierarchy
// only culls disjoint bounds. Candidate order and Matter contacts are unchanged.
export function indexCompoundBounds(Matter, signal) {
  const Detector = Matter.Detector, original = Detector.collisions,
    projectionScope = projectionScopes.get(Matter),
    trees = new WeakMap(), stack = [], candidates = [];
  let generation = 0;
  const ascending = (a, b) => a - b;
  function treeFor(body) {
    let tree = trees.get(body);
    if (!tree || tree.parts !== body.parts) {
      const nodes = [];
      function build(ids) {
        if (ids.length === 1) {
          const node = { part: ids[0] };
          nodes.push(node);
          return node;
        }
        let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;
        for (const i of ids) {
          const p = body.parts[i].position;
          loX = Math.min(loX, p.x); hiX = Math.max(hiX, p.x);
          loY = Math.min(loY, p.y); hiY = Math.max(hiY, p.y);
        }
        const axis = hiX - loX >= hiY - loY ? 'x' : 'y';
        ids.sort((a, b) => body.parts[a].position[axis] - body.parts[b].position[axis]);
        const middle = ids.length >> 1,
          node = { left: build(ids.slice(0, middle)), right: build(ids.slice(middle)) };
        nodes.push(node);
        return node;
      }
      tree = { parts: body.parts, nodes, root: build(Array.from({length: body.parts.length - 1}, (_, i) => i + 1)), generation: -1 };
      trees.set(body, tree);
    }
    if (tree.generation !== generation) {
      for (const node of tree.nodes) {
        if (node.part !== undefined) {
          const b = body.parts[node.part].bounds;
          node.minX = b.min.x; node.maxX = b.max.x;
          node.minY = b.min.y; node.maxY = b.max.y;
        } else {
          const a = node.left, b = node.right;
          node.minX = Math.min(a.minX, b.minX); node.maxX = Math.max(a.maxX, b.maxX);
          node.minY = Math.min(a.minY, b.minY); node.maxY = Math.max(a.maxY, b.maxY);
        }
      }
      tree.generation = generation;
    }
    return tree.root;
  }
  function collisions(detector) {
    if (projectionScope) { projectionScope.epoch++; projectionScope.active = true; }
    try { return findCollisions(detector); }
    finally { if (projectionScope) projectionScope.active = false; }
  }
  function findCollisions(detector) {
    generation++;
    const bodies = detector.bodies, out = detector.collisions, pairs = detector.pairs,
      collides = Matter.Collision.collides;
    let count = 0;
    bodies.sort(Detector._compareBoundsX);
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i], ab = a.bounds, fixed = a.isStatic || a.isSleeping;
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j], bb = b.bounds;
        if (bb.min.x > ab.max.x) break;
        if (ab.max.y < bb.min.y || ab.min.y > bb.max.y ||
          (fixed && (b.isStatic || b.isSleeping)) || !Detector.canCollide(a.collisionFilter, b.collisionFilter)) continue;
        if (b.parts.length <= 4) {
          for (let ai = a.parts.length > 1 ? 1 : 0; ai < a.parts.length; ai++) {
            const p = a.parts[ai], pb = p.bounds;
            for (let bi = b.parts.length > 1 ? 1 : 0; bi < b.parts.length; bi++) {
              const q = b.parts[bi], qb = q.bounds;
              if (pb.min.x > qb.max.x || pb.max.x < qb.min.x || pb.max.y < qb.min.y || pb.min.y > qb.max.y) continue;
              const c = collides(p, q, pairs); if (c) out[count++] = c;
            }
          }
          continue;
        }
        const root = treeFor(b);
        if (a.parts.length > 4) {
          stack.length = candidates.length = 0;
          stack.push(treeFor(a), root);
          while (stack.length) {
            const nb = stack.pop(), na = stack.pop();
            if (na.minX > nb.maxX || na.maxX < nb.minX || na.maxY < nb.minY || na.minY > nb.maxY) continue;
            if (na.part !== undefined && nb.part !== undefined) {
              candidates.push(na.part * b.parts.length + nb.part);
            } else if (nb.part !== undefined || (na.part === undefined &&
              (na.maxX - na.minX + na.maxY - na.minY) >= (nb.maxX - nb.minX + nb.maxY - nb.minY))) {
              stack.push(na.left, nb, na.right, nb);
            } else stack.push(na, nb.left, na, nb.right);
          }
          candidates.sort(ascending);
          for (let k = 0; k < candidates.length; k++) {
            const key = candidates[k], ai = Math.floor(key / b.parts.length), bi = key % b.parts.length,
              c = collides(a.parts[ai], b.parts[bi], pairs);
            if (c) out[count++] = c;
          }
        } else for (let ai = a.parts.length > 1 ? 1 : 0; ai < a.parts.length; ai++) {
          const p = a.parts[ai], pb = p.bounds;
          stack.length = candidates.length = 0;
          stack.push(root);
          while (stack.length) {
            const node = stack.pop();
            if (pb.min.x > node.maxX || pb.max.x < node.minX || pb.max.y < node.minY || pb.min.y > node.maxY) continue;
            if (node.part !== undefined) candidates.push(node.part);
            else { stack.push(node.left, node.right); }
          }
          candidates.sort(ascending);
          for (let k = 0; k < candidates.length; k++) {
            const c = collides(p, b.parts[candidates[k]], pairs);
            if (c) out[count++] = c;
          }
        }
      }
    }
    out.length = count;
    return out;
  }
  Detector.collisions = collisions;
  signal.addEventListener('abort', () => {
    if (Detector.collisions === collisions) Detector.collisions = original;
  }, { once: true });
}
