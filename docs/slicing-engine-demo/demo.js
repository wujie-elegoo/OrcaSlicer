import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const RECORD = new URLSearchParams(location.search).has("record");
if (RECORD) document.body.classList.add("record");

const LAYER_H = 1.2;
const WALL_W = 0.48;
const INNER_W = 0.44;
const INFILL_SP = 2.4;
const DURATION = 52;

const COL = {
  mesh: 0xc5d0de,
  plate: 0x121a28,
  grid: 0x2a3a55,
  slice: 0x4fc3f7,
  outer: 0xff6a2b,
  inner: 0x3ddc97,
  infill: 0xf5c542,
  support: 0x8b7cff,
  nozzle: 0xffe082,
  bead: 0xff9f43,
};

const STAGES = [
  { t: 0, name: "模型", caption: "待切片模型：底座带孔，中间立柱，右侧悬空伸出。Z 轴向上，和切片器预览同一套坐标。" },
  { t: 4, name: "切层 posSlice", caption: "水平面沿 Z 扫过。每个三角形与平面求交得到线段，再接成闭合轮廓（ExPolygon = 外环 + 孔）。" },
  { t: 14, name: "层堆叠", caption: "一层层 2D 切片堆起来。之后所有墙、填充、支撑都只在这些多边形上做，不再回到三角网格。" },
  { t: 18, name: "墙 posPerimeters", caption: "Classic：轮廓向内等距偏移，像洋葱皮。外墙半个线宽，再每圈一个 spacing。窄处 Arachne 会改成变线宽。" },
  { t: 27, name: "填充 posInfill", caption: "先分类顶/底/内部，再在剩余区域铺图案。这里用直线填充：旋转、画平行线、clip 回多边形。" },
  { t: 33, name: "支撑 posSupportMaterial", caption: "和下一层比，悬空且不是桥的区域需要支撑。普通支撑是投影柱；树状支撑会从尖点往下长并合并。" },
  { t: 39, name: "路径 psGCodeExport", caption: "喷头按层走：支撑 → 墙 → 填充。这就是 G-code 预览里那条彩色路径。" },
];

function aabb(xmin, xmax, ymin, ymax) {
  return { xmin, xmax, ymin, ymax };
}
function inset(r, d) {
  return aabb(r.xmin + d, r.xmax - d, r.ymin + d, r.ymax - d);
}
function valid(r, min = 0.12) {
  return r.xmax - r.xmin > min && r.ymax - r.ymin > min;
}
function loopOf(r) {
  return [
    [r.xmin, r.ymin],
    [r.xmax, r.ymin],
    [r.xmax, r.ymax],
    [r.xmin, r.ymax],
    [r.xmin, r.ymin],
  ];
}
function areaOf(r) {
  return Math.max(0, r.xmax - r.xmin) * Math.max(0, r.ymax - r.ymin);
}

function sliceAt(z) {
  const hole = z < 8.01 ? { x: 0, y: 0, r: 4.4 } : null;
  if (z < 8) return { islands: [aabb(-18, 18, -12, 12)], hole };
  if (z < 22) return { islands: [aabb(-6, 6, -6, 6), aabb(12.15, 13.2, -7.5, 7.5)], hole: null };
  if (z <= 30.01) return { islands: [aabb(-6, 22, -6, 6)], hole: null };
  return null;
}

function wallsForIsland(rect, hole, arachne) {
  const walls = [];
  const minDim = Math.min(rect.xmax - rect.xmin, rect.ymax - rect.ymin);
  if (arachne && minDim < WALL_W * 2.4) {
    const mid = inset(rect, minDim * 0.28);
    if (valid(mid, 0.04)) walls.push({ loop: loopOf(mid), role: "outer", width: Math.min(1.05, minDim * 0.9) });
    return walls;
  }
  const first = inset(rect, WALL_W * 0.5);
  if (!valid(first)) {
    if (arachne && valid(rect, 0.2)) {
      const mid = inset(rect, minDim * 0.28);
      if (valid(mid, 0.04)) walls.push({ loop: loopOf(mid), role: "outer", width: minDim * 0.9 });
    }
    return walls;
  }
  walls.push({ loop: loopOf(first), role: "outer", width: WALL_W });
  if (hole) {
    walls.push({ loop: circle(hole.x, hole.y, hole.r + WALL_W * 0.5, 28), role: "outer", width: WALL_W });
  }
  const second = inset(first, (WALL_W + INNER_W) * 0.5);
  if (arachne && !valid(second, INNER_W * 1.2)) return walls;
  if (valid(second)) {
    walls.push({ loop: loopOf(second), role: "inner", width: INNER_W });
    if (hole) {
      walls.push({
        loop: circle(hole.x, hole.y, Math.max(0.55, hole.r + WALL_W + INNER_W * 0.5), 28),
        role: "inner",
        width: INNER_W,
      });
    }
  }
  return walls;
}

function wallsFor(slice, arachne) {
  if (!slice) return [];
  const walls = [];
  slice.islands.forEach((island, idx) => {
    walls.push(...wallsForIsland(island, idx === 0 ? slice.hole : null, arachne));
  });
  return walls;
}

function infillRegions(slice) {
  const d = WALL_W + INNER_W + 0.08;
  return slice.islands
    .map((island, idx) => {
      const r = inset(island, d);
      if (!valid(r, 1.0)) return null;
      return { rect: r, hole: idx === 0 && slice.hole ? { ...slice.hole, r: slice.hole.r + d } : null };
    })
    .filter(Boolean);
}

function circle(cx, cy, r, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

function clipLineToRect(x0, y0, x1, y1, r) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - r.xmin, r.xmax - x0, y0 - r.ymin, r.ymax - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  if (t0 > t1) return null;
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

function splitByHole(seg, hole) {
  if (!hole || !seg) return seg ? [seg] : [];
  const [x0, y0, x1, y1] = seg;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const fx = x0 - hole.x;
  const fy = y0 - hole.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - hole.r * hole.r;
  const disc = b * b - 4 * a * c;
  if (disc <= 0 || a === 0) {
    const midInside = (fx + dx * 0.5) ** 2 + (fy + dy * 0.5) ** 2 < hole.r * hole.r;
    return midInside ? [] : [seg];
  }
  const s = Math.sqrt(disc);
  let tA = (-b - s) / (2 * a);
  let tB = (-b + s) / (2 * a);
  if (tA > tB) [tA, tB] = [tB, tA];
  const out = [];
  if (tA > 0.001) out.push([x0, y0, x0 + dx * Math.min(1, tA), y0 + dy * Math.min(1, tA)]);
  if (tB < 0.999) out.push([x0 + dx * Math.max(0, tB), y0 + dy * Math.max(0, tB), x1, y1]);
  return out.filter((s) => Math.hypot(s[2] - s[0], s[3] - s[1]) > 0.15);
}

function infillLines(region, zIndex) {
  if (!region) return [];
  const ang = (zIndex % 2 === 0 ? 45 : -45) * Math.PI / 180;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const r = region.rect;
  const cx = (r.xmin + r.xmax) / 2;
  const cy = (r.ymin + r.ymax) / 2;
  const span = Math.hypot(r.xmax - r.xmin, r.ymax - r.ymin) + 4;
  const lines = [];
  for (let o = -span; o <= span; o += INFILL_SP) {
    const x0 = cx + c * -span - s * o;
    const y0 = cy + s * -span + c * o;
    const x1 = cx + c * span - s * o;
    const y1 = cy + s * span + c * o;
    const clipped = clipLineToRect(x0, y0, x1, y1, r);
    for (const seg of splitByHole(clipped, region.hole)) lines.push(seg);
  }
  return lines;
}

function supportCells(z) {
  if (z < 22) return [];
  const cells = [];
  for (let x = 7.2; x <= 21.2; x += 3.2) {
    for (let y = -4.8; y <= 4.8; y += 3.2) {
      cells.push({ x, y, z0: 0.15, z1: z - 0.05 });
    }
  }
  return cells;
}

function layers() {
  const out = [];
  for (let z = LAYER_H * 0.5; z < 30.01; z += LAYER_H) {
    const slice = sliceAt(z);
    if (!slice) continue;
    out.push({ z, slice, index: out.length });
  }
  return out;
}

const LAYERS = layers();

function buildSolid() {
  const g = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({
    color: COL.mesh,
    roughness: 0.38,
    metalness: 0.08,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide,
  });
  const baseShape = new THREE.Shape();
  baseShape.moveTo(-18, -12);
  baseShape.lineTo(18, -12);
  baseShape.lineTo(18, 12);
  baseShape.lineTo(-18, 12);
  baseShape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, 4.4, 0, Math.PI * 2, true);
  baseShape.holes.push(hole);
  const base = new THREE.Mesh(new THREE.ExtrudeGeometry(baseShape, { depth: 8, bevelEnabled: false }), mat);
  g.add(base);
  const stem = new THREE.Mesh(new THREE.BoxGeometry(12, 12, 14), mat);
  stem.position.set(0, 0, 8 + 7);
  g.add(stem);
  const head = new THREE.Mesh(new THREE.BoxGeometry(28, 12, 8), mat);
  head.position.set(8, 0, 22 + 4);
  g.add(head);
  const rib = new THREE.Mesh(new THREE.BoxGeometry(1.05, 15, 14), mat);
  rib.position.set(12.675, 0, 8 + 7);
  g.add(rib);
  g.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return g;
}

function makePlate() {
  const g = new THREE.Group();
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(90, 90, 1.2),
    new THREE.MeshStandardMaterial({ color: 0x1c2740, roughness: 0.82, metalness: 0.08 })
  );
  plate.position.z = -0.6;
  plate.receiveShadow = true;
  g.add(plate);
  const helper = new THREE.GridHelper(80, 16, COL.grid, COL.grid);
  helper.rotation.x = Math.PI / 2;
  helper.position.z = 0.02;
  g.add(helper);
  return g;
}

function polylineGeometry(points, z, closed = false) {
  const pts = points.map((p) => new THREE.Vector3(p[0], p[1], z));
  if (closed && pts.length) pts.push(pts[0].clone());
  return new THREE.BufferGeometry().setFromPoints(pts);
}

function tubeLoop(points, z, color, radius) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.15 });
  const yAxis = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < points.length - 1; i++) {
    const a = new THREE.Vector3(points[i][0], points[i][1], z);
    const b = new THREE.Vector3(points[i + 1][0], points[i + 1][1], z);
    const len = a.distanceTo(b);
    if (len < 0.04) continue;
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 8), mat);
    mesh.position.copy(a).lerp(b, 0.5);
    mesh.quaternion.setFromUnitVectors(yAxis, b.clone().sub(a).normalize());
    mesh.castShadow = true;
    group.add(mesh);
    const joint = new THREE.Mesh(new THREE.SphereGeometry(radius, 8, 8), mat);
    joint.position.copy(a);
    group.add(joint);
  }
  return group;
}

const canvas = document.getElementById("c");
window.addEventListener("error", (e) => {
  const d = document.createElement("div");
  d.style.cssText = "position:absolute;left:20px;bottom:80px;z-index:9;color:#ff8a8a;max-width:640px;font-size:13px;white-space:pre-wrap";
  d.textContent = "演示加载失败: " + (e.error && e.error.stack ? e.error.stack : e.message);
  document.body.appendChild(d);
});
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070b14);
scene.fog = new THREE.Fog(0x070b14, 140, 260);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
camera.up.set(0, 0, 1);
camera.position.set(54, -58, 34);
const controls = new OrbitControls(camera, canvas);
controls.target.set(2, 0, 12);
controls.enableDamping = true;
controls.enabled = !RECORD;

scene.add(new THREE.HemisphereLight(0xb9d4ff, 0x1a140c, 1.05));
const sun = new THREE.DirectionalLight(0xffffff, 1.35);
sun.position.set(40, -30, 70);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -50;
sun.shadow.camera.right = 50;
sun.shadow.camera.top = 50;
sun.shadow.camera.bottom = -50;
scene.add(sun);
scene.add(new THREE.AmbientLight(0x406080, 0.25));

scene.add(makePlate());
const solid = buildSolid();
scene.add(solid);
const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 30);
solid.traverse((o) => {
  if (o.material) {
    o.material = o.material.clone();
    o.material.clippingPlanes = [clipPlane];
    o.material.clipShadows = true;
  }
});

const slicePlane = new THREE.Mesh(
  new THREE.PlaneGeometry(70, 50),
  new THREE.MeshBasicMaterial({ color: COL.slice, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
);
slicePlane.rotation.x = 0;
scene.add(slicePlane);
const planeEdge = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.PlaneGeometry(70, 50)),
  new THREE.LineBasicMaterial({ color: COL.slice })
);
slicePlane.add(planeEdge);

const layerGroup = new THREE.Group();
scene.add(layerGroup);
const wallGroup = new THREE.Group();
scene.add(wallGroup);
const infillGroup = new THREE.Group();
scene.add(infillGroup);
const supportGroup = new THREE.Group();
scene.add(supportGroup);

const nozzle = new THREE.Group();
const nozzleBody = new THREE.Mesh(
  new THREE.ConeGeometry(1.1, 3.2, 16),
  new THREE.MeshStandardMaterial({ color: COL.nozzle, roughness: 0.3, metalness: 0.4 })
);
nozzleBody.rotation.x = Math.PI / 2;
nozzleBody.position.z = 1.8;
nozzle.add(nozzleBody);
nozzle.add(new THREE.Mesh(
  new THREE.CylinderGeometry(1.5, 1.5, 2.2, 16),
  new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.6, roughness: 0.3 })
));
nozzle.children[1].rotation.x = Math.PI / 2;
nozzle.children[1].position.z = 4.2;
nozzle.visible = false;
scene.add(nozzle);

const path = [];
let arachne = false;

function rebuildDerived() {
  layerGroup.clear();
  wallGroup.clear();
  infillGroup.clear();
  supportGroup.clear();
  path.length = 0;

  for (const layer of LAYERS) {
    for (const island of layer.slice.islands) {
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(island.xmax - island.xmin, island.ymax - island.ymin, LAYER_H * 0.16),
        new THREE.MeshStandardMaterial({
          color: COL.slice,
          transparent: true,
          opacity: 0.35,
          roughness: 0.5,
        })
      );
      slab.position.set((island.xmin + island.xmax) / 2, (island.ymin + island.ymax) / 2, layer.z);
      slab.userData.layer = layer.index;
      layerGroup.add(slab);
    }

    const walls = wallsFor(layer.slice, arachne);
    for (const w of walls) {
      const mesh = tubeLoop(w.loop, layer.z, w.role === "outer" ? COL.outer : COL.inner, Math.max(0.22, w.width * 0.55));
      if (!mesh) continue;
      mesh.userData.layer = layer.index;
      wallGroup.add(mesh);
      for (let i = 0; i < w.loop.length - 1; i++) {
        path.push({
          a: [w.loop[i][0], w.loop[i][1], layer.z],
          b: [w.loop[i + 1][0], w.loop[i + 1][1], layer.z],
          role: w.role,
          layer: layer.index,
        });
      }
    }

    for (const region of infillRegions(layer.slice)) {
      for (const seg of infillLines(region, layer.index)) {
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(seg[0], seg[1], layer.z),
          new THREE.Vector3(seg[2], seg[3], layer.z),
        ]);
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: COL.infill }));
        line.userData.layer = layer.index;
        infillGroup.add(line);
        path.push({ a: [seg[0], seg[1], layer.z], b: [seg[2], seg[3], layer.z], role: "infill", layer: layer.index });
      }
    }
  }

  for (const cell of supportCells(30)) {
    const h = Math.max(0.2, cell.z1 - cell.z0);
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.9, h),
      new THREE.MeshStandardMaterial({ color: COL.support, roughness: 0.55, transparent: true, opacity: 0.88 })
    );
    m.position.set(cell.x, cell.y, cell.z0 + h / 2);
    m.userData.layer = LAYERS.length - 1;
    m.castShadow = true;
    supportGroup.add(m);
    path.push({ a: [cell.x, cell.y, cell.z0], b: [cell.x, cell.y, cell.z1], role: "support", layer: 0 });
  }

  path.sort((u, v) => u.layer - v.layer || roleOrder(u.role) - roleOrder(v.role));
}

function roleOrder(role) {
  return { support: 0, outer: 1, inner: 2, infill: 3 }[role] ?? 9;
}

rebuildDerived();

const printed = new THREE.Group();
scene.add(printed);
const printedGeom = new THREE.BufferGeometry();
const printedLine = new THREE.LineSegments(
  printedGeom,
  new THREE.LineBasicMaterial({ vertexColors: true })
);
printed.add(printedLine);

function rebuildPrinted(count) {
  const n = Math.max(0, Math.min(count, path.length));
  const pos = new Float32Array(n * 6);
  const col = new Float32Array(n * 6);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const p = path[i];
    pos.set([...p.a, ...p.b], i * 6);
    if (p.role === "outer") c.setHex(COL.outer);
    else if (p.role === "inner") c.setHex(COL.inner);
    else if (p.role === "infill") c.setHex(COL.infill);
    else c.setHex(COL.support);
    col.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
  }
  printedGeom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  printedGeom.setAttribute("color", new THREE.BufferAttribute(col, 3));
  printedGeom.computeBoundingSphere();
}

const shots = [
  { t: 0, pos: [54, -58, 34], look: [4, 0, 10] },
  { t: 3.5, pos: [50, -54, 32], look: [4, 0, 11] },
  { t: 8, pos: [36, -18, 48], look: [3, 0, 12] },
  { t: 14, pos: [62, -12, 16], look: [4, 0, 14] },
  { t: 18, pos: [6, -8, 44], look: [4, 0, 14] },
  { t: 26, pos: [8, -10, 42], look: [4, 0, 12] },
  { t: 33, pos: [52, -50, 30], look: [8, 0, 12] },
  { t: 39, pos: [46, -48, 26], look: [6, 0, 10] },
  { t: 52, pos: [58, -56, 32], look: [5, 0, 11] },
];

function lerpShot(t) {
  let i = 0;
  while (i + 1 < shots.length && shots[i + 1].t < t) i++;
  const a = shots[i];
  const b = shots[Math.min(i + 1, shots.length - 1)];
  const u = a === b ? 0 : (t - a.t) / Math.max(0.001, b.t - a.t);
  const s = u * u * (3 - 2 * u);
  return {
    pos: a.pos.map((v, k) => v + (b.pos[k] - v) * s),
    look: a.look.map((v, k) => v + (b.look[k] - v) * s),
  };
}

let playing = true;
let t = 0;
let last = performance.now();

const elStage = document.getElementById("stageName");
const elCaption = document.getElementById("caption");
const elBarTitle = document.getElementById("barTitle");
const elBarText = document.getElementById("barText");
const elTime = document.getElementById("time");
const elSeek = document.getElementById("seek");
const btnPlay = document.getElementById("btnPlay");

function currentStage(time) {
  let s = STAGES[0];
  for (const st of STAGES) if (time >= st.t) s = st;
  return s;
}

function setVisibleByLayer(group, maxLayer, extra = 1) {
  group.children.forEach((ch) => {
    ch.visible = ch.userData.layer <= maxLayer && ch.userData.layer >= maxLayer - extra;
  });
}

function applyTime(time) {
  const stage = currentStage(time);
  elStage.textContent = stage.name;
  elCaption.textContent = stage.caption;
  elBarTitle.textContent = stage.name;
  elBarText.textContent = stage.caption;
  elTime.textContent = `${time.toFixed(1)}s`;
  elSeek.value = String((time / DURATION) * 1000);

  const shot = lerpShot(time);
  if (RECORD || !controls.enabled || playing) {
    camera.position.set(...shot.pos);
    controls.target.set(...shot.look);
  }

  const sliceT = THREE.MathUtils.clamp((time - 4) / 9, 0, 1);
  const zCut = THREE.MathUtils.lerp(30.4, 0, sliceT);
  clipPlane.constant = time < 4 ? 40 : time < 14 ? zCut : -1;
  solid.visible = time < 16;
  solid.traverse((o) => {
    if (o.material && o.material.opacity != null) o.material.opacity = time < 14 ? 0.9 : Math.max(0, 1 - (time - 14) / 2) * 0.9;
  });
  slicePlane.visible = time >= 4 && time < 15;
  slicePlane.position.z = zCut;

  const explode = THREE.MathUtils.smoothstep(time, 14, 17) * (1 - THREE.MathUtils.smoothstep(time, 17.5, 19));
  const showLayersUntil = time < 4 ? -1 : Math.floor(THREE.MathUtils.lerp(-1, LAYERS.length, sliceT));
  layerGroup.children.forEach((ch) => {
    const i = ch.userData.layer;
    ch.visible = time >= 4 && time < 20 && i <= showLayersUntil;
    ch.position.z = LAYERS[i].z + explode * i * 0.55;
    ch.material.opacity = 0.28 + explode * 0.25;
  });

  const wallStart = 18;
  const wallLayer = time < wallStart ? -1 : Math.floor(((time - wallStart) / 8) * LAYERS.length);
  wallGroup.children.forEach((ch) => {
    const i = ch.userData.layer;
    ch.visible = time >= wallStart && time < 40 && i <= wallLayer;
    if (time >= 39) ch.visible = false;
  });

  const infillStart = 27;
  const infillLayer = time < infillStart ? -1 : Math.floor(((time - infillStart) / 5.5) * LAYERS.length);
  infillGroup.children.forEach((ch) => {
    const i = ch.userData.layer;
    ch.visible = time >= infillStart && time < 40 && i <= infillLayer;
    if (time >= 39) ch.visible = false;
  });

  const supportStart = 33;
  supportGroup.visible = time >= supportStart && time < 40;
  const grow = THREE.MathUtils.clamp((time - supportStart) / 5, 0, 1);
  supportGroup.children.forEach((ch) => {
    ch.material.opacity = 0.15 + 0.73 * grow;
  });

  const printStart = 39;
  if (time >= printStart) {
    const u = THREE.MathUtils.clamp((time - printStart) / 12.5, 0, 1);
    const count = Math.floor(u * path.length);
    rebuildPrinted(count);
    printed.visible = true;
    wallGroup.visible = false;
    infillGroup.visible = false;
    supportGroup.visible = false;
    nozzle.visible = count > 0 && u < 0.995;
    if (count > 0) {
      const p = path[Math.min(count, path.length - 1)];
      nozzle.position.set(p.b[0], p.b[1], p.b[2] + 0.2);
    }
  } else {
    printed.visible = false;
    nozzle.visible = false;
    wallGroup.visible = true;
    infillGroup.visible = true;
  }

  if (time >= DURATION - 0.05) window.DEMO_DONE = true;
}

function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (playing) {
    t += dt;
    if (t > DURATION) {
      if (RECORD) {
        t = DURATION;
        playing = false;
        window.DEMO_DONE = true;
      } else t = 0;
    }
  }
  applyTime(t);
  controls.update();
  const w = canvas.clientWidth || innerWidth;
  const h = canvas.clientHeight || innerHeight;
  if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

btnPlay.onclick = () => {
  playing = !playing;
  btnPlay.textContent = playing ? "暂停" : "播放";
};
document.getElementById("btnReplay").onclick = () => {
  t = 0;
  playing = true;
  window.DEMO_DONE = false;
  btnPlay.textContent = "暂停";
};
elSeek.oninput = () => {
  t = (Number(elSeek.value) / 1000) * DURATION;
  playing = false;
  btnPlay.textContent = "播放";
  applyTime(t);
};
document.getElementById("btnClassic").onclick = () => {
  arachne = false;
  document.getElementById("btnClassic").classList.add("active");
  document.getElementById("btnArachne").classList.remove("active");
  rebuildDerived();
};
document.getElementById("btnArachne").onclick = () => {
  arachne = true;
  document.getElementById("btnArachne").classList.add("active");
  document.getElementById("btnClassic").classList.remove("active");
  rebuildDerived();
};
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    btnPlay.click();
  }
});

applyTime(0);
requestAnimationFrame(tick);
window.DEMO_READY = true;
window.setDemoTime = (sec, pause = true) => {
  t = sec;
  if (pause) {
    playing = false;
    btnPlay.textContent = "播放";
  }
  applyTime(t);
};
window.playDemo = () => {
  playing = true;
  btnPlay.textContent = "暂停";
};

