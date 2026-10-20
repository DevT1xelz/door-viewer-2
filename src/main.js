import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import hdrClear from '../assets/quarry_01_1k.hdr';
import hdrGolden from '../assets/pedestrian_overpass_1k.hdr';
import hdrDusk from '../assets/venice_sunset_1k.hdr';

/* =====================================================================
   Входная дверь с боковым остеклением - 3D-просмотрщик (three.js).
   Размеры в метрах. Система координат: X вправо (с улицы), Y вверх, +Z - улица.
   ===================================================================== */

// ---------- окружение / устройство ----------
const canvas = document.getElementById('c');
const params = new URLSearchParams(location.search);
const isTouch = matchMedia('(pointer: coarse)').matches;
const isSmall = Math.min(innerWidth, innerHeight) < 700;
const mobileLike = isTouch || isSmall;
const DARK_UI = matchMedia('(prefers-color-scheme: dark)').matches;

const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance',
});
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;       // тени пересчитываем, когда что-то движется

const PR_MAX = Math.min(window.devicePixelRatio || 1, 2);          // в покое: полное разрешение
const PR_MOVE_MAX = Math.min(PR_MAX, mobileLike ? 1.25 : 1.5);       // при вращении/анимации: плотность ниже, чтобы не лагало
const PR_MOVE_MIN = 0.75;
let prMove = PR_MOVE_MAX;
let pixelRatio = PR_MAX;
renderer.setPixelRatio(pixelRatio);
if ('transmissionResolutionScale' in renderer) renderer.transmissionResolutionScale = 0.5;   // проход пропускания стекла в половину разрешения

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, 1, 0.2, 40);

// фон-градиент (в сцене, чтобы работала постобработка)
function backgroundTexture() {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 512;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(256, 170, 20, 256, 256, 420);
  if (DARK_UI) { grd.addColorStop(0, '#3a4049'); grd.addColorStop(0.6, '#23272d'); grd.addColorStop(1, '#14171b'); }
  else { grd.addColorStop(0, '#f3f5f8'); grd.addColorStop(0.58, '#d3d9e1'); grd.addColorStop(1, '#b1bac6'); }
  g.fillStyle = grd; g.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
scene.background = backgroundTexture();

// ---------- свет: направленное солнце (тени) + HDRI-окружение (отражения и рассеянный свет) ----------
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.target.position.set(0, 1.0, 0.2);
sun.castShadow = true;
const shadowRes = mobileLike ? 2048 : 4096;
sun.shadow.mapSize.set(shadowRes, shadowRes);
sun.shadow.camera.left = -3.4; sun.shadow.camera.right = 3.4;
sun.shadow.camera.top = 3.4; sun.shadow.camera.bottom = -2.4;
sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 18;
sun.shadow.bias = -0.00025;
sun.shadow.normalBias = 0.012;
sun.shadow.radius = 4;
sun.shadow.blurSamples = 16;
const room = new THREE.DirectionalLight(0xfff1e0, 1.5);   // свет помещения: освещает только тыльную сторону
room.position.set(-2.5, 3.2, -6.5);
room.target.position.set(0, 1.0, 0);
scene.add(sun, sun.target, room, room.target);

const pmrem = new THREE.PMREMGenerator(renderer);
// пресеты освещения: HDRI + параметры солнца, рассчитанные по энергии срезанного в панораме солнца
const PRESETS = [
  { id: 'soft',   label: 'Мягкий свет', hdr: hdrDusk,   clamp: 12, exposure: 1.18, desat: 0.55,
    sun: { az: [0.55, 0.835], elev: 38, color: [1.0, 0.96, 0.9], intensity: 1.1 } },
  { id: 'clear',  label: 'Ясно',        hdr: hdrClear,  clamp: 12, exposure: 0.92, desat: 0.25,
    sun: { az: [0.797, 0.579], elev: 30, color: [1.0, 0.92, 0.80], intensity: 4.0 } },
  { id: 'golden', label: 'Золотой час', hdr: hdrGolden, clamp: 12, exposure: 0.95, desat: 0.0,
    sun: { az: [0.625, 0.779], elev: 13, color: [1.0, 0.64, 0.32], intensity: 5.0 } },
];
let envTex = null, presetIndex = 0;

function makeEnvironment(u8, clampMax, desat = 0) {
  const loader = new HDRLoader().setDataType(THREE.FloatType);
  const d = loader.parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
  const f = d.data, half = new Uint16Array(f.length);
  for (let i = 0; i < f.length; i += 4) {
    // срезаем слишком яркое солнце (его заменяет направленный свет с тенями)
    const m = Math.max(f[i], f[i + 1], f[i + 2]);
    const k = m > clampMax ? clampMax / m : 1;
    let r = f[i] * k, g = f[i + 1] * k, b = f[i + 2] * k;
    if (desat > 0) {                                    // убираем цветовой оттенок панорамы (нейтральнее свет)
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l + (r - l) * (1 - desat); g = l + (g - l) * (1 - desat); b = l + (b - l) * (1 - desat);
    }
    half[i] = THREE.DataUtils.toHalfFloat(r);
    half[i + 1] = THREE.DataUtils.toHalfFloat(g);
    half[i + 2] = THREE.DataUtils.toHalfFloat(b);
    half[i + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const tex = new THREE.DataTexture(half, d.width, d.height, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = true;
  tex.needsUpdate = true;
  const rt = pmrem.fromEquirectangular(tex);
  tex.dispose();
  return rt.texture;
}

function applyPreset(i) {
  const p = PRESETS[i];
  presetIndex = i;
  const next = makeEnvironment(p.hdr, p.clamp, p.desat || 0);
  scene.environment = next;
  if (envTex) envTex.dispose();
  envTex = next;
  scene.environmentIntensity = 1.0;
  renderer.toneMappingExposure = p.exposure;
  const el = THREE.MathUtils.degToRad(p.sun.elev);
  const az = new THREE.Vector2(p.sun.az[0], p.sun.az[1]).normalize();
  sun.position.set(az.x * Math.cos(el), Math.sin(el), az.y * Math.cos(el)).multiplyScalar(9).add(sun.target.position);
  sun.color.setRGB(p.sun.color[0], p.sun.color[1], p.sun.color[2], THREE.LinearSRGBColorSpace);
  sun.intensity = p.sun.intensity;
  renderer.shadowMap.needsUpdate = true;
  needsRender = true;
  const b = document.getElementById('btnLight');
  if (b) b.textContent = 'Свет: ' + p.label;
}

// ---------- процедурные текстуры ----------
function valueNoise(size, seed, cellsX, cellsY, fineWeight) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size);
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const grid = new Float32Array(cellsX * cellsY);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const gy = (y / size) * cellsY, y0 = Math.floor(gy), ty = sm(gy - y0);
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * cellsX, x0 = Math.floor(gx), tx = sm(gx - x0);
      const a = grid[(y0 % cellsY) * cellsX + (x0 % cellsX)];
      const b = grid[(y0 % cellsY) * cellsX + ((x0 + 1) % cellsX)];
      const c = grid[((y0 + 1) % cellsY) * cellsX + (x0 % cellsX)];
      const d = grid[((y0 + 1) % cellsY) * cellsX + ((x0 + 1) % cellsX)];
      const coarse = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
      const v = Math.max(0, Math.min(1, coarse * (1 - fineWeight) + rnd() * fineWeight));
      const o = (y * size + x) * 4, g = (v * 255) | 0;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = g; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}
const noiseCanvas = (size, seed, cells, fine) => valueNoise(size, seed, cells, cells, fine);

// карта нормалей из карты высот (бесшовно)
function normalFromHeight(cv, strength) {
  const s = cv.width, src = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, s, s).data;
  const out = document.createElement('canvas');
  out.width = out.height = s;
  const octx = out.getContext('2d'), img = octx.createImageData(s, s);
  const H = (x, y) => src[(((y + s) % s) * s + ((x + s) % s)) * 4] / 255;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const nx = -(H(x + 1, y) - H(x - 1, y)) * strength;
    const ny = (H(x, y + 1) - H(x, y - 1)) * strength;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
    const o = (y * s + x) * 4;
    img.data[o] = (nx * inv * 0.5 + 0.5) * 255;
    img.data[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
    img.data[o + 2] = (inv * 0.5 + 0.5) * 255;
    img.data[o + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function roughFromHeight(cv, lo) {
  const s = cv.width, img = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, s, s);
  const out = document.createElement('canvas');
  out.width = out.height = s;
  const octx = out.getContext('2d'), o = octx.createImageData(s, s);
  for (let i = 0; i < s * s; i++) {
    const v = (lo + (1 - lo) * (img.data[i * 4] / 255)) * 255;
    o.data[i * 4] = o.data[i * 4 + 1] = o.data[i * 4 + 2] = v; o.data[i * 4 + 3] = 255;
  }
  octx.putImageData(o, 0, 0);
  return out;
}

function tintCanvas(cv, c0, c1) {              // серую карту -> градиент цвета (c0 тёмный, c1 светлый)
  const s = cv.width, ctx = cv.getContext('2d', { willReadFrequently: true }), img = ctx.getImageData(0, 0, s, s);
  const out = document.createElement('canvas');
  out.width = out.height = s;
  const octx = out.getContext('2d'), o = octx.createImageData(s, s);
  for (let i = 0; i < s * s; i++) {
    const t = img.data[i * 4] / 255;
    o.data[i * 4] = c0[0] + (c1[0] - c0[0]) * t;
    o.data[i * 4 + 1] = c0[1] + (c1[1] - c0[1]) * t;
    o.data[i * 4 + 2] = c0[2] + (c1[2] - c0[2]) * t;
    o.data[i * 4 + 3] = 255;
  }
  octx.putImageData(o, 0, 0);
  return out;
}

function repeatTex(cv, rx, ry, srgb) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------- параметры двери (метры). x - вправо с улицы, y - вверх, +z - улица ----------
const LEAF_W = 0.86, LEAF_H = 2.05, LEAF_T = 0.075;          // полотно
const GAP_HINGE = 0.0185, GAP_LOCK = 0.005, GAP_FLOOR = 0.065, HOFF = 0.002, BARREL_R = 0.0155;
const W_DOOR = LEAF_W + GAP_HINGE + GAP_LOCK;                // проём под полотно
const H_IN = LEAF_H + GAP_FLOOR + 0.005;                     // высота проёма
const SASH_W = 0.34, MULL_W = 0.04;                          // боковое остекление и стойка
const W_IN = SASH_W + MULL_W + W_DOOR;                       // внутренняя ширина всей конструкции
const X0 = -W_IN / 2, XS1 = X0 + SASH_W, XD0 = XS1 + MULL_W, XD1 = W_IN / 2;
const FD = 0.12, JW = 0.05;                                  // глубина коробки/стены, ширина профиля
const CASING_W = 0.08, CASING_T = 0.014, SILL_H = 0.06;      // наличник-рама, порог рамы
const Z_WB = FD / 2;                                         // тыльная плоскость стены (-0.06)
const Z_WF = 0.036;                                          // лицевая плоскость стены: наличник близко к полотну (зазор 1.6 см), петли видны с боков
const Z_CASING = Z_WF + CASING_T;
const Z_LEAF = 0.034;                                        // наружная (верхняя) плоскость рельефа полотна
const REL = 0.012;                                           // высота рельефа (рёбра, бортик)
const SINK = BARREL_R + 0.0005;                              // ось петли уходит вглубь: ствол целиком в зазоре, заподлицо с лицом
const PIVOT = new THREE.Vector3(XD1 - GAP_HINGE - HOFF, GAP_FLOOR, Z_LEAF - SINK);
const LEAF_X0 = XD0 + GAP_LOCK;                              // мировой X левой кромки полотна

// рифлёная панель и гладкая часть
const BW = 0.020, GB = 0.003;                                // бортик и зазор до него
const SMOOTH_END = 0.200, SEAM = 0.004;
const N_RIBS = 19, RIB_GAP = 0.0075;

// фурнитура (координаты полотна: xe от левой кромки с улицы, z от низа полотна)
const BAR_XE = 0.128, BAR_Z0 = 0.30, BAR_Z1 = 1.71, STANDOFF_Z = [0.46, 1.00, 1.54];
const PLATE_XE = 0.062, PLATE_A_Z = 1.21, PLATE_B_Z = 1.03, PLATE_C_Z = 0.85;   // сверху большой ключ, посередине щеколда, снизу мини-ключ
const PEEP_Z = 1.55;                                         // глазок
const LEVER_XE = 0.070, LEVER_Z = 1.02, THUMB_Z = 0.80;   // изнутри: ручка и барашек
const BOLT_Z = [0.45, 1.00, 1.55];
const HINGE_Z = [0.115, LEAF_H - 0.115];
const OPEN_ANGLE = THREE.MathUtils.degToRad(105);

// мини-стенд вокруг двери
const WALL_HALF = 1.30, WALL_H = 2.62, SIDING_ROWS = 11;
const SLAB_W = 3.8, SLAB_D = 3.2, SLAB_CZ = 0.6;

// ---------- текстуры ----------
const moireH = noiseCanvas(512, 11, 128, 0.45);
const moireNormal = repeatTex(normalFromHeight(moireH, 2.2), 4, 4, false);
const moireRough = repeatTex(roughFromHeight(moireH, 0.62), 4, 4, false);
const concreteH = noiseCanvas(512, 71, 24, 0.55);
const concreteNormal = repeatTex(normalFromHeight(concreteH, 2.6), SLAB_W / 1.5, SLAB_D / 1.5, false);
const concreteTone = repeatTex(tintCanvas(noiseCanvas(512, 72, 6, 0.1), [138, 137, 134], [160, 159, 155]), SLAB_W / 1.5, SLAB_D / 1.5, true);

// сайдинг: продольные волокна (вытянутый шум) + сучки-вариации
const woodH = valueNoise(512, 91, 6, 56, 0.16);
const woodColor = new THREE.CanvasTexture(tintCanvas(woodH, [172, 130, 84], [204, 164, 112]));
woodColor.wrapS = woodColor.wrapT = THREE.RepeatWrapping;
woodColor.colorSpace = THREE.SRGBColorSpace;
woodColor.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
const woodNormal = new THREE.CanvasTexture(normalFromHeight(woodH, 0.9));
woodNormal.wrapS = woodNormal.wrapT = THREE.RepeatWrapping;
woodNormal.anisotropy = woodColor.anisotropy;

// ---------- материалы ----------
const phys = (o) => new THREE.MeshPhysicalMaterial(o);
const NS = (v) => new THREE.Vector2(v, v);
const MAT = {
  // полотно: графитовая порошковая краска (сатин), мелкая структура
  door:    phys({ color: 0x43454a, roughness: 0.55, metalness: 0.0, roughnessMap: moireRough,
                  normalMap: moireNormal, normalScale: NS(0.35), specularIntensity: 0.9 }),
  deep:    phys({ color: 0x17181a, roughness: 0.7, metalness: 0.0 }),
  doorIn:  phys({ color: 0x45474b, roughness: 0.55, metalness: 0.0, roughnessMap: moireRough,
                  normalMap: moireNormal, normalScale: NS(0.35) }),
  // рама / наличник / стойка: светлее полотна
  frame:   phys({ color: 0x62656a, roughness: 0.58, metalness: 0.0, roughnessMap: moireRough,
                  normalMap: moireNormal, normalScale: NS(0.35), specularIntensity: 0.9 }),
  black:   phys({ color: 0x0c0c0d, roughness: 0.46, metalness: 0.1, normalMap: moireNormal, normalScale: NS(0.3) }),
  blackRim: phys({ color: 0x0a0a0b, roughness: 0.12, metalness: 0.7, envMapIntensity: 1.3 }),
  void:    phys({ color: 0x000000, roughness: 1.0, metalness: 0.0 }),
  blackGl: phys({ color: 0x050506, roughness: 0.16, metalness: 0.2, clearcoat: 0.5, clearcoatRoughness: 0.1 }),
  chrome:  phys({ color: 0xffffff, roughness: 0.035, metalness: 1.0 }),
  steel:   phys({ color: 0xb9bcc1, roughness: 0.3, metalness: 1.0, anisotropy: 0.75, anisotropyRotation: 0 }),
  rubber:  phys({ color: 0x080808, roughness: 0.88, metalness: 0.0, normalMap: moireNormal, normalScale: NS(0.4) }),
  wood:    phys({ color: 0xffffff, map: woodColor, normalMap: woodNormal, normalScale: NS(0.55), roughness: 0.8, metalness: 0.0, vertexColors: true }),
  woodCore: phys({ color: 0x4a3420, roughness: 0.9, metalness: 0.0 }),
  concrete: phys({ color: 0xffffff, map: concreteTone, normalMap: concreteNormal, normalScale: NS(0.8), roughness: 0.9, metalness: 0.0 }),
  slab:    phys({ color: 0x7c7e81, roughness: 0.92, metalness: 0.0 }),
  // тёмное тонированное стекло: в основном отражает окружение
  // прозрачное стекло (видно насквозь с обеих сторон), отражает окружение
  tint:    phys({ color: 0xf1f6f4, roughness: 0.0, metalness: 0.0, transmission: 1.0, thickness: 0.006, ior: 1.52, envMapIntensity: 1.2 }),
  glass:   phys({ color: 0xffffff, roughness: 0.0, metalness: 0.0, transmission: 1.0, thickness: 0.004, ior: 1.5 }),
};
const NO_SHADOW = new Set(['tint', 'glass']);
const glassMeshes = [];

// ---------- сборка геометрии: статичные детали склеиваются по материалам ----------
const acc = new Map();
const ni = (g) => (g.index ? g.toNonIndexed() : g);
function put(group, matName, geom) {
  const g = geom.index ? geom.toNonIndexed() : geom;
  const key = group.uuid + '|' + matName;
  let e = acc.get(key);
  if (!e) { e = { group, matName, list: [] }; acc.set(key, e); }
  e.list.push(g);
}
function flush() {
  for (const { group, matName, list } of acc.values()) {
    const merged = mergeGeometries(list, false);
    list.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(merged, MAT[matName]);
    mesh.castShadow = !NO_SHADOW.has(matName);
    mesh.receiveShadow = !NO_SHADOW.has(matName);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (NO_SHADOW.has(matName)) glassMeshes.push(mesh);
    group.add(mesh);
  }
  acc.clear();
}

function box(group, mat, w, h, d, x, y, z, r = 0.003, seg = 4) {
  const m = Math.min(w, h, d);
  const rr = Math.min(r, m * 0.45);
  const g = (rr > 0.0004) ? new RoundedBoxGeometry(w, h, d, seg, rr) : new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  put(group, mat, g);
  return g;
}
// бокс по границам в мировых/локальных осях
function bx(group, mat, x0, x1, y0, y1, z0, z1, r = 0.003) {
  return box(group, mat, x1 - x0, y1 - y0, z1 - z0, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, r);
}

function cyl(group, mat, r, len, axis, x, y, z, scaleY = 1, segs = 36) {
  const g = new THREE.CylinderGeometry(r, r, len, segs, 1);
  if (axis === 'z') g.rotateX(Math.PI / 2); else if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (scaleY !== 1) g.scale(1, scaleY, 1);
  g.translate(x, y, z);
  put(group, mat, g);
}

// проекция UV в метрах мира (для сайдинга, чтобы доски были одной шкалы)
function worldUV(g, su, sv, ou, ov) {
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    if (az >= ax && az >= ay) uv.setXY(i, p.getX(i) * su + ou, p.getY(i) * sv + ov);
    else if (ax >= ay) uv.setXY(i, p.getZ(i) * su + ou, p.getY(i) * sv + ov);
    else uv.setXY(i, p.getX(i) * su + ou, p.getZ(i) * sv + ov);
  }
  uv.needsUpdate = true;
}

// координаты полотна: xe - от левой кромки (вид с улицы), yy - вглубь от наружной плоскости, z - от низа полотна.
// Локальная система двери: начало в оси петель.
const lx = (xe) => xe - LEAF_W + HOFF;
function lbox(group, mat, xe0, xe1, yy0, yy1, z0, z1, r = 0.003, seg = 4) {
  return bx(group, mat, lx(xe0), lx(xe1), z0, z1, -yy1, -yy0, r);
}
function lcyl(group, mat, r, len, axis, xe, yy, z, scaleY = 1, segs = 36) {
  cyl(group, mat, r, len, axis, lx(xe), z, -yy, scaleY, segs);
}

// ---------- сцена ----------
const world = new THREE.Group();          // неподвижное: рама, стена, пол, петли
const doorPivot = new THREE.Group();      // ось петель (вращается)
doorPivot.position.copy(PIVOT);
const door = new THREE.Group();           // полотно: плоскость лица двери в z=0
door.position.z = SINK;
doorPivot.add(door);
scene.add(world, doorPivot);

const mech = {};                          // подвижные детали механизма

// ----- рама, наличник, стойка, порог -----
function buildFrame() {
  const zb = -Z_WB, zf = Z_WF - 0.002;
  const HT = H_IN + JW;
  // коробка (скрыта наличником, видны только внутренние грани проёма)
  bx(world, 'frame', X0 - JW, X0, 0, H_IN, zb, zf, 0.002);
  bx(world, 'frame', XD1, XD1 + JW, 0, H_IN, zb, zf, 0.002);
  bx(world, 'frame', X0 - JW, XD1 + JW, H_IN, HT, zb, zf, 0.002);
  bx(world, 'frame', X0, XD1, 0, SILL_H, zb, zf, 0.002);                     // порог рамы
  // стойка между остеклением и дверью (чуть выступает вперёд)
  bx(world, 'frame', XS1, XD0, SILL_H, H_IN, zb, 0.046, 0.0025);

  // упорная полка для полотна с внутренней стороны + уплотнитель
  const lz1 = zb + 0.018;
  bx(world, 'frame', XD0, XD0 + 0.028, SILL_H, H_IN, zb, lz1, 0.002);
  bx(world, 'frame', XD1 - 0.028, XD1, SILL_H, H_IN, zb, lz1, 0.002);
  bx(world, 'frame', XD0, XD1, H_IN - 0.028, H_IN, zb, lz1, 0.002);
  bx(world, 'rubber', XD0 + 0.010, XD0 + 0.020, SILL_H, H_IN - 0.028, lz1, lz1 + 0.007, 0.003);
  bx(world, 'rubber', XD1 - 0.020, XD1 - 0.010, SILL_H, H_IN - 0.028, lz1, lz1 + 0.007, 0.003);
  bx(world, 'rubber', XD0 + 0.010, XD1 - 0.010, H_IN - 0.020, H_IN - 0.010, lz1, lz1 + 0.007, 0.003);

  // наружный наличник-рама: широкая плоская рамка вокруг всей конструкции (как на фото)
  const zc0 = Z_WF, zc1 = Z_CASING, CW = CASING_W;
  bx(world, 'frame', X0 - CW, X0, 0, H_IN + CW, zc0, zc1, 0.002);
  bx(world, 'frame', XD1, XD1 + CW, 0, H_IN + CW, zc0, zc1, 0.002);
  bx(world, 'frame', X0, XD1, H_IN, H_IN + CW, zc0, zc1, 0.002);
  bx(world, 'frame', X0, XD1, 0, SILL_H, zc0, zc1, 0.002);
  // тонкий внутренний буртик наличника (светлая линия по периметру проёма)
  const tb = 0.005, zt = zc1 + 0.0025;
  bx(world, 'frame', X0, X0 + tb, SILL_H, H_IN, zc0, zt, 0.0012);
  bx(world, 'frame', X0, XD1, H_IN - tb, H_IN, zc0, zt, 0.0012);
  // внутренний наличник (с обратной стороны)
  const zi0 = -Z_WB - CASING_T, zi1 = -Z_WB;
  bx(world, 'frame', X0 - CW, X0, 0, H_IN + CW, zi0, zi1, 0.002);
  bx(world, 'frame', XD1, XD1 + CW, 0, H_IN + CW, zi0, zi1, 0.002);
  bx(world, 'frame', X0, XD1, H_IN, H_IN + CW, zi0, zi1, 0.002);
  bx(world, 'frame', X0, XD1, 0, SILL_H, zi0, zi1, 0.002);
}

// ----- боковое остекление (створка-рама + стеклопакет + штапики) -----
function buildSidelight() {
  const y0 = GAP_FLOOR, y1 = H_IN - 0.005, zf = 0.040, zb = 0.0;
  const st = 0.04, top = 0.05, bot = 0.055;
  bx(world, 'frame', X0, X0 + st, y0, y1, zb, zf, 0.002);
  bx(world, 'frame', XS1 - st, XS1, y0, y1, zb, zf, 0.002);
  bx(world, 'frame', X0 + st, XS1 - st, y1 - top, y1, zb, zf, 0.002);
  bx(world, 'frame', X0 + st, XS1 - st, y0, y0 + bot, zb, zf, 0.002);
  // тонкий внешний буртик створки
  const tb = 0.004, zt = zf + 0.002;
  bx(world, 'frame', X0, X0 + tb, y0, y1, zf, zt, 0.001);
  bx(world, 'frame', XS1 - tb, XS1, y0, y1, zf, zt, 0.001);
  bx(world, 'frame', X0, XS1, y1 - tb, y1, zf, zt, 0.001);
  bx(world, 'frame', X0, XS1, y0, y0 + tb, zf, zt, 0.001);

  const gx0 = X0 + st, gx1 = XS1 - st, gy0 = y0 + bot, gy1 = y1 - top;
  // стеклопакет: тёмное наружное + светлое внутреннее
  bx(world, 'tint', gx0 - 0.008, gx1 + 0.008, gy0 - 0.008, gy1 + 0.008, 0.024, 0.030, 0);
  bx(world, 'glass', gx0 - 0.008, gx1 + 0.008, gy0 - 0.008, gy1 + 0.008, 0.006, 0.012, 0);
  // штапики по периметру стекла
  const bw = 0.014, bz0 = 0.030, bz1 = 0.043;
  bx(world, 'frame', gx0, gx1, gy1 - bw + 0.006, gy1 + 0.006, bz0, bz1, 0.0012);
  bx(world, 'frame', gx0, gx1, gy0 - 0.006, gy0 + bw - 0.006, bz0, bz1, 0.0012);
  bx(world, 'frame', gx0 - 0.006, gx0 + bw - 0.006, gy0, gy1, bz0, bz1, 0.0012);
  bx(world, 'frame', gx1 - bw + 0.006, gx1 + 0.006, gy0, gy1, bz0, bz1, 0.0012);
}

// ----- стена из сайдинга: горизонтальные доски с фасками -----
function buildWall() {
  const HT = H_IN + JW, h = HT / SIDING_ROWS;
  const xl1 = X0 - JW, xr0 = XD1 + JW;
  let seed = 5;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const rows = Math.ceil(WALL_H / h);
  for (let r = 0; r < rows; r++) {
    const y0 = r * h, y1 = Math.min(WALL_H, (r + 1) * h);
    const segs = (y1 <= HT + 1e-6) ? [[-WALL_HALF, xl1], [xr0, WALL_HALF]] : [[-WALL_HALF, WALL_HALF]];
    for (const [a, b] of segs) {
      const g = new RoundedBoxGeometry(b - a, y1 - y0, Z_WF + Z_WB, 4, 0.0045);
      g.translate((a + b) / 2, (y0 + y1) / 2, (Z_WF - Z_WB) / 2);
      worldUV(g, 1 / 1.3, 1.0, rnd(), rnd() - y0);
      const tone = 0.90 + rnd() * 0.16;                       // у каждой доски свой оттенок
      const col = new Float32Array(g.attributes.position.count * 3).fill(tone);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      put(world, 'wood', g);
    }
  }
}

// ----- пол-площадка и порог -----
function buildFloor() {
  const geo = new THREE.BoxGeometry(SLAB_W, 0.07, SLAB_D);
  const slab = new THREE.Mesh(geo, [MAT.slab, MAT.slab, MAT.concrete, MAT.slab, MAT.slab, MAT.slab]);
  slab.position.set(0, -0.035, SLAB_CZ);
  slab.receiveShadow = true;
  world.add(slab);
}

// ----- полотно -----
// Панели одной стороны: бортик, гладкая панель у замковой кромки, 19 планок.
// Внутренняя сторона - зеркальная копия группы (одинаковые панели с обеих сторон).
function buildPanels(g) {
  const zi0 = BW + GB, zi1 = LEAF_H - BW - GB, xi0 = BW + GB, xi1 = LEAF_W - BW - GB;
  lbox(g, 'door', 0, LEAF_W, 0, REL, LEAF_H - BW, LEAF_H, 0.0018);
  lbox(g, 'door', 0, LEAF_W, 0, REL, 0, BW, 0.0018);
  lbox(g, 'door', 0, BW, 0, REL, BW + GB, LEAF_H - BW - GB, 0.0018);
  lbox(g, 'door', LEAF_W - BW, LEAF_W, 0, REL, BW + GB, LEAF_H - BW - GB, 0.0018);
  lbox(g, 'door', xi0, SMOOTH_END, 0, REL, zi0, zi1, 0.0022);
  const xf0 = SMOOTH_END + SEAM, avail = xi1 - xf0, pitch = avail / N_RIBS, rw = pitch - RIB_GAP;
  for (let k = 0; k < N_RIBS; k++) {
    const a = xf0 + k * pitch + RIB_GAP / 2;
    lbox(g, 'door', a, a + rw, 0, REL, zi0, zi1, 0.0016, 3);
  }
}

// небольшие подвижные детали собираем из готовых геометрий
function movingMesh(group, geoms, mat, x, y, z) {
  const m = new THREE.Mesh(geoms.length > 1 ? mergeGeometries(geoms.map(ni)) : geoms[0], MAT[mat]);
  m.position.set(x, y, z);
  m.castShadow = false;
  group.add(m);
  return m;
}
const cylG = (r, len, segs = 28) => { const g = new THREE.CylinderGeometry(r, r, len, segs); g.rotateX(Math.PI / 2); return g; };   // ось вдоль z (от лица)

// скруглённая квадратная накладка (для верхнего замка): xe, z - центр на полотне, zc - центр по глубине (z-local)
function padG(w, h, depth, radius, xe, z, zc) {
  const g = new RoundedBoxGeometry(w, h, depth, 6, radius);
  g.translate(lx(xe), z, zc);
  return g;
}

// барашек замка на квадратной накладке (вращается ключом); используется и снаружи, и изнутри
function addThumbturn(g, z) {
  lbox(g, 'black', PLATE_XE - 0.018, PLATE_XE + 0.018, -0.009, 0.002, z - 0.024, z + 0.024, 0.003);
  const turn = new THREE.Group();
  turn.position.set(lx(PLATE_XE), z, 0);
  const hub = cylG(0.0085, 0.012, 28); hub.translate(0, 0, 0.015);
  const bar = new RoundedBoxGeometry(0.011, 0.040, 0.009, 2, 0.003); bar.translate(0, 0, 0.0255);
  movingMesh(turn, [hub, bar], 'black', 0, 0, 0);
  g.add(turn);
  return turn;
}

// ----- наружная сторона: ручка-скоба, чёрный квадратный замок (большой ключ), барашек, замок под мини-ключ, глазок -----
function buildExteriorHW(g) {
  // ручка-скоба на трёх стойках
  const barW = 0.032, barD = 0.042, so = 0.052;
  lbox(g, 'black', BAR_XE - barW / 2, BAR_XE + barW / 2, -so - barD, -so, BAR_Z0, BAR_Z1, 0.0045, 5);
  for (const z of STANDOFF_Z) {
    lbox(g, 'black', BAR_XE - 0.011, BAR_XE + 0.011, -so, 0.002, z - 0.022, z + 0.022, 0.0025, 4);
    lcyl(g, 'black', 0.015, 0.003, 'z', BAR_XE, -0.0005, z, 1, 28);
  }

  // A (верх): замок под БОЛЬШОЙ ключ - КВАДРАТНАЯ накладка (чёрная): резиновая прокладка, глянцевый ободок,
  // выпуклая подушкой накладка и замочная скважина с бородкой
  const ax = PLATE_XE, az = PLATE_A_Z;
  put(g, 'rubber', padG(0.068, 0.068, 0.003, 0.0045, ax, az, 0.0005));
  put(g, 'blackRim', padG(0.062, 0.062, 0.0075, 0.0055, ax, az, 0.0030));
  put(g, 'blackGl', padG(0.052, 0.052, 0.0115, 0.0095, ax, az, 0.0066));
  const kx = lx(ax);
  for (const [w, h, dx] of [[0.020, 0.0034, 0], [0.0045, 0.0085, 0.0022], [0.0030, 0.0060, -0.0050]]) {
    const k = new THREE.BoxGeometry(w, h, 0.0012);
    k.translate(kx + dx, az, 0.0128);
    put(g, 'void', k);
  }

  // B (середина): поворотный барашек (копия внутреннего)
  mech.turnOut = addThumbturn(g, PLATE_B_Z);

  // C (низ): замок под МИНИ-ключ - маленькая круглая скважина, поворачивается ключом
  const cX = PLATE_XE, cZ = PLATE_C_Z;
  lbox(g, 'black', cX - 0.019, cX + 0.019, -0.009, 0.002, cZ - 0.021, cZ + 0.021, 0.003);
  lcyl(g, 'chrome', 0.0078, 0.0016, 'z', cX, -0.0092, cZ, 1, 32);
  const mini = new THREE.Group();
  mini.position.set(lx(cX), cZ, 0);
  const mdisc = cylG(0.0058, 0.0018, 28); mdisc.translate(0, 0, 0.0100);
  const mslit = new RoundedBoxGeometry(0.0016, 0.0078, 0.0010, 2, 0.0004); mslit.translate(0, 0, 0.0112);
  movingMesh(mini, [mdisc], 'blackGl', 0, 0, 0);
  movingMesh(mini, [mslit], 'deep', 0, 0, 0);
  g.add(mini);
  mech.mini = mini;

  // глазок: хромированный окуляр с тёмной линзой (на гладкой панели над замками)
  lcyl(g, 'chrome', 0.0105, 0.0055, 'z', PLATE_XE, -0.0028, PEEP_Z, 1, 40);
  lcyl(g, 'blackGl', 0.0066, 0.0066, 'z', PLATE_XE, -0.0035, PEEP_Z, 1, 32);
}

// ----- внутренняя сторона: ручка-рычаг, барашек замка, глазок -----
function buildInteriorHW(g) {
  // глазок (окуляр)
  lcyl(g, 'chrome', 0.0125, 0.0050, 'z', PLATE_XE, -0.0025, PEEP_Z, 1, 40);
  lcyl(g, 'black', 0.0092, 0.0120, 'z', PLATE_XE, -0.0080, PEEP_Z, 1, 32);
  lcyl(g, 'blackGl', 0.0060, 0.0022, 'z', PLATE_XE, -0.0145, PEEP_Z, 1, 28);

  // ручка-рычаг (поворачивается при открывании)
  lbox(g, 'black', LEVER_XE - 0.025, LEVER_XE + 0.025, -0.008, 0.002, LEVER_Z - 0.025, LEVER_Z + 0.025, 0.004);
  const lever = new THREE.Group();
  lever.position.set(lx(LEVER_XE), LEVER_Z, 0);
  const lbase = cylG(0.019, 0.007, 36); lbase.translate(0, 0, 0.0115);
  const lneck = cylG(0.0095, 0.028, 28); lneck.translate(0, 0, 0.029);
  const larm = new RoundedBoxGeometry(0.150, 0.022, 0.016, 4, 0.006); larm.translate(0.062, 0, 0.049);
  movingMesh(lever, [lbase, lneck, larm], 'black', 0, 0, 0);
  g.add(lever);
  mech.lever = lever;

  // барашек замка
  mech.turn = addThumbturn(g, THUMB_Z);
}

function buildLeaf() {
  // тёмное тело (видно в пазах между рёбрами обеих сторон) и окрашенные торцы
  lbox(door, 'deep', 0, LEAF_W, REL, LEAF_T - REL, 0, LEAF_H, 0.003);
  lbox(door, 'door', -0.0005, 0.0015, 0, LEAF_T, 0.0, LEAF_H, 0.0008, 2);
  lbox(door, 'door', LEAF_W - 0.0015, LEAF_W + 0.0005, 0, LEAF_T, 0.0, LEAF_H, 0.0008, 2);
  lbox(door, 'door', 0, LEAF_W, 0, LEAF_T, LEAF_H - 0.0015, LEAF_H + 0.0005, 0.0008, 2);
  lbox(door, 'door', 0, LEAF_W, 0, LEAF_T, -0.0005, 0.0015, 0.0008, 2);

  // наружная сторона и внутренняя (зеркальная копия панелей), у каждой своя фурнитура
  buildPanels(door);
  buildExteriorHW(door);
  const inner = new THREE.Group();
  inner.position.set(0, 0, -LEAF_T);
  inner.scale.set(1, 1, -1);
  door.add(inner);
  buildPanels(inner);
  buildInteriorHW(inner);

  // ---- засовы на торце замковой стороны (выдвигаются в стойку) ----
  const mkBolt = (z) => {
    const g = new RoundedBoxGeometry(0.040, 0.030, 0.014, 3, 0.002);
    const m = new THREE.Mesh(g, MAT.chrome);
    m.position.set(lx(0.0) - 0.007, z, -(LEAF_T * 0.42));
    m.castShadow = true;
    door.add(m);
    return { mesh: m, x0: m.position.x };
  };
  mech.bolts = BOLT_Z.map(mkBolt);
  // торцевая планка замка
  lbox(door, 'black', -0.0014, 0.0014, 0.040 - 0.014, 0.040 + 0.014, BOLT_Z[0] - 0.05, BOLT_Z[2] + 0.05, 0.0006, 2);

  // ---- петли: ось уходит вглубь, ствол целиком спрятан в зазоре между полотном и коробкой ----
  for (const hz of HINGE_Z) {
    const y = GAP_FLOOR + hz;
    bx(world, 'black', XD1 - 0.0045, XD1, y - 0.075, y + 0.075, PIVOT.z - 0.024, PIVOT.z + 0.024, 0.001);   // пластина на коробке
    for (const dy of [-0.055, 0, 0.055]) cyl(world, 'black', BARREL_R, 0.050, 'y', PIVOT.x, y + dy, PIVOT.z, 1, 48);
    cyl(world, 'steel', 0.0062, 0.172, 'y', PIVOT.x, y, PIVOT.z, 1, 20);
    cyl(world, 'black', BARREL_R + 0.0006, 0.007, 'y', PIVOT.x, y + 0.0885, PIVOT.z, 1, 48);
    cyl(world, 'black', BARREL_R + 0.0006, 0.007, 'y', PIVOT.x, y - 0.0885, PIVOT.z, 1, 48);
  }

  // ---- ответные планки в стойке (для засовов) ----
  for (const z of BOLT_Z) {
    const yy = GAP_FLOOR + z, zz = Z_LEAF - LEAF_T * 0.42;
    bx(world, 'black', XD0, XD0 + 0.003, yy - 0.04, yy + 0.04, zz - 0.016, zz + 0.016, 0.0008);
    bx(world, 'deep', XD0, XD0 + 0.0042, yy - 0.0175, yy + 0.0175, zz - 0.0075, zz + 0.0075, 0.0004);
  }
}

buildFrame();
buildSidelight();
buildWall();
buildFloor();
buildLeaf();
flush();

// ---------- анимация: отпереть -> открыть -> подержать -> закрыть -> запереть ----------
const T_OPEN_END = 5.0, T_TOTAL = 10.0;
const TR = {
  angle:   [[0, 0], [1.9, 0], [4.5, OPEN_ANGLE], [5.6, OPEN_ANGLE], [8.0, 0], [10, 0]],
  key:     [[0, 0], [0.4, 0], [1.2, Math.PI / 2], [8.3, Math.PI / 2], [9.1, 0], [10, 0]],        // мини-ключ, барашки снаружи и изнутри
  bolt:    [[0, 0], [0.7, 0], [1.4, 0.027], [8.3, 0.027], [9.0, 0], [10, 0]],                    // засовы замка на торце
  lever:   [[0, 0], [1.5, 0], [1.9, 0.5], [2.6, 0.5], [3.0, 0], [10, 0]],                        // внутренняя ручка
};
function sample(track, t) {
  if (t <= track[0][0]) return track[0][1];
  for (let i = 1; i < track.length; i++) {
    if (t <= track[i][0]) {
      const [t0, v0] = track[i - 1], [t1, v1] = track[i];
      const k = (t - t0) / (t1 - t0), e = k * k * (3 - 2 * k);
      return v0 + (v1 - v0) * e;
    }
  }
  return track[track.length - 1][1];
}
function applyPose(t) {
  doorPivot.rotation.y = sample(TR.angle, t);
  const key = sample(TR.key, t);
  mech.mini.rotation.z = -key;
  mech.turnOut.rotation.z = key;
  mech.turn.rotation.z = key;
  const b = sample(TR.bolt, t);
  for (const bolt of mech.bolts) bolt.mesh.position.x = bolt.x0 + b;
  mech.lever.rotation.z = -sample(TR.lever, t);
}

// ---------- постобработка: MSAA + GTAO (затемнение в стыках и пазах) + тон-маппинг ----------
let vw = 0, vh = 0;
const composerRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, composerRT);
composer.addPass(new RenderPass(scene, camera));
const gtao = new GTAOPass(scene, camera, 4, 4);
gtao.output = GTAOPass.OUTPUT.Default;
gtao.blendIntensity = 0.85;
gtao.updateGtaoMaterial({ radius: 0.11, distanceExponent: 1.3, thickness: 0.55, scale: 0.9, samples: 16, distanceFallOff: 1.0 });
gtao.updatePdMaterial({ lumaPhi: 8, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 16 });
// прозрачное/стеклянное в проходе нормалей и глубины не участвует (иначе стекло "закрывает" AO)
{
  const origRender = gtao.render.bind(gtao);
  gtao.render = (...args) => {
    for (const m of glassMeshes) m.visible = false;
    origRender(...args);
    for (const m of glassMeshes) m.visible = true;
  };
}
composer.addPass(gtao);
composer.addPass(new OutputPass());
if (params.get('ao') === '0') gtao.enabled = false;

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.09;
controls.enablePan = false;
controls.minDistance = 0.45;
controls.maxDistance = 8.0;
controls.minPolarAngle = 0.12;
controls.maxPolarAngle = Math.PI / 2 - 0.02;        // не уходим под пол
controls.rotateSpeed = isTouch ? 0.85 : 0.9;
controls.zoomSpeed = 0.9;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
controls.target.set(0, 1.05, 0);

const VIEWS = {
  outside: { pos: [2.35, 1.40, 3.70], tgt: [0.05, 1.08, 0.05] },
  inside:  { pos: [-2.35, 1.40, -3.70], tgt: [0.0, 1.08, -0.05] },
  handle:  { pos: [-0.62, 1.12, 0.88], tgt: [-0.14, 1.06, 0.04] },
};
let tween = null;
function aspect() { return camera.aspect || 1; }
function setView(name, instant = false) {
  let v = VIEWS[name];
  if (!v) return;
  if (name === 'handle' && camera.position.z < 0) v = { pos: [-0.62, 1.12, -0.88], tgt: [-0.14, 1.06, -0.04] };   // ручка с внутренней стороны
  const tgt = new THREE.Vector3(...v.tgt);
  const dir = new THREE.Vector3(...v.pos).sub(tgt);
  if (name !== 'handle') {
    // дистанция: стенд целиком на широком экране; на узком (портрет) подгоняем по ширине, чтобы дверь была крупной
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    dir.setLength(Math.min(controls.maxDistance, Math.max(5.9, 0.95 / (tanH * aspect()))));
  }
  tween = {
    t: 0, dur: 0.9,
    p0: camera.position.clone(), t0: controls.target.clone(),
    p1: tgt.clone().add(dir), t1: tgt,
  };
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  if (instant) {
    camera.position.copy(tween.p1); controls.target.copy(tween.t1); tween = null; controls.update();
  }
  needsRender = true;
}

// ---------- цикл: рендер только когда что-то изменилось ----------
let needsRender = true, frames = 0;
let animT = 0, animTarget = 0, playing = false;
const btnOpen = document.getElementById('btnOpen');
let isOpen = false;

function toggleDoor() {
  if (playing) return;
  playing = true;
  animTarget = isOpen ? T_TOTAL : T_OPEN_END;
  btnOpen.disabled = true;
  btnOpen.textContent = isOpen ? 'Закрываю…' : 'Открываю…';
  hideHint();
}
btnOpen.addEventListener('click', toggleDoor);

let emaDt = 16, lastRender = 0, lastAdjust = 0, lastActive = 0;
const lastCam = new THREE.Vector3();
function setPixelRatioNow(v) {
  if (Math.abs(v - pixelRatio) < 0.001) return;
  pixelRatio = v;
  renderer.setPixelRatio(v);
  composer.setPixelRatio(v);
  composer.setSize(vw, vh);
  renderer.setSize(vw, vh, false);
  needsRender = true;
}
// во время движения подстраиваем плотность пикселей под скорость устройства (в покое всегда полное качество)
function adaptQuality(now) {
  if (now - lastAdjust < 900) return;
  if (emaDt > 34 && prMove > PR_MOVE_MIN) { prMove = Math.max(PR_MOVE_MIN, prMove - 0.125); lastAdjust = now; setPixelRatioNow(prMove); }
  else if (emaDt < 19 && prMove < PR_MOVE_MAX) { prMove = Math.min(PR_MOVE_MAX, prMove + 0.125); lastAdjust = now; setPixelRatioNow(prMove); }
}

let prev = performance.now();
function resize() {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (w === vw && h === vh) return;
  vw = w; vh = h;
  renderer.setSize(w, h, false);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  needsRender = true;
}
new ResizeObserver(resize).observe(canvas);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - prev) / 1000);
  prev = now;
  let moved = false;

  if (playing) {
    animT = Math.min(animTarget, animT + dt);
    applyPose(animT);
    renderer.shadowMap.needsUpdate = true;
    moved = true;
    if (animT >= animTarget) {
      playing = false;
      isOpen = !isOpen;
      if (!isOpen) { animT = 0; applyPose(0); }
      btnOpen.disabled = false;
      btnOpen.textContent = isOpen ? 'Закрыть дверь' : 'Открыть дверь';
      btnOpen.setAttribute('aria-pressed', String(isOpen));
    }
  }

  if (tween) {
    tween.t += dt;
    const k = Math.min(1, tween.t / tween.dur), e = k * k * (3 - 2 * k);
    camera.position.lerpVectors(tween.p0, tween.p1, e);
    controls.target.lerpVectors(tween.t0, tween.t1, e);
    if (k >= 1) tween = null;
    moved = true;
  }

  const changed = controls.update();
  // активностью считаем реальное смещение камеры (>0.6 мм за кадр), удержание пальца/мыши и анимацию;
  // затухающая инерция вращения (микроскопические сдвиги) активностью не считается
  const camMoved = camera.position.distanceToSquared(lastCam) > 3.6e-7;
  lastCam.copy(camera.position);
  if (dragging || moved || camMoved) {
    lastActive = now;
    if (pixelRatio !== prMove) setPixelRatioNow(prMove);              // движение: облегчённое разрешение
  } else if (pixelRatio !== PR_MAX && now - lastActive > 260) {
    setPixelRatioNow(PR_MAX);                                          // покой: возвращаем полное разрешение
  }
  if (changed || moved || needsRender) {
    const t0 = performance.now();
    composer.render();
    frames++;
    needsRender = false;
    if (lastRender && now - lastRender < 120) {
      emaDt = emaDt * 0.9 + (now - lastRender) * 0.1;      // интервал между кадрами при непрерывной отрисовке
      adaptQuality(now);
    } else {
      emaDt = Math.max(emaDt * 0.8, 16);
    }
    lastRender = now;
    void t0;
  } else {
    lastRender = 0;
  }
}

let dragging = false;                                           // палец/мышь удерживаются
controls.addEventListener('start', () => { dragging = true; hideHint(); });
controls.addEventListener('end', () => { dragging = false; });

// клик/тап по двери открывает или закрывает её
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let downX = 0, downY = 0, downT = 0;
canvas.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; downT = performance.now(); });
canvas.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6 || performance.now() - downT > 350) return;
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (ray.intersectObject(door, true).length) toggleDoor();
});

// ---------- интерфейс ----------
if (params.has('debug')) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:8px;top:96px;z-index:9;font:12px/1.4 monospace;background:rgba(0,0,0,.65);color:#9f9;padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre';
  document.body.appendChild(d);
  setInterval(() => {
    const i = renderer.info.render;
    d.textContent = `frame ${emaDt.toFixed(1)} ms (~${(1000 / Math.max(emaDt, 1)).toFixed(0)} fps)\npixelRatio ${pixelRatio}\ncalls ${i.calls}  tris ${i.triangles}\nGPU ${renderer.capabilities.maxTextureSize}px tex`;
  }, 500);
}
const hint = document.getElementById('hint');
function hideHint() { hint.classList.add('hide'); }
setTimeout(hideHint, 9000);

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
const btnLight = document.getElementById('btnLight');
btnLight.addEventListener('click', () => {
  btnLight.disabled = true;
  setTimeout(() => { applyPreset((presetIndex + 1) % PRESETS.length); btnLight.disabled = false; }, 30);
});
const btnSpin = document.getElementById('btnSpin');
btnSpin.addEventListener('click', () => {
  controls.autoRotate = !controls.autoRotate;
  controls.autoRotateSpeed = 1.6;
  btnSpin.classList.toggle('on', controls.autoRotate);
  btnSpin.setAttribute('aria-pressed', String(controls.autoRotate));
  needsRender = true;
});
const panel = document.getElementById('specs');
document.getElementById('btnInfo').addEventListener('click', () => panel.classList.toggle('open'));
document.getElementById('specsClose').addEventListener('click', () => panel.classList.remove('open'));

canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
canvas.addEventListener('webglcontextrestored', () => { needsRender = true; });

// ---------- старт ----------
applyPreset(0);
applyPose(0);
resize();
setView('outside');
camera.position.copy(tween.p1);               // первый кадр без пролёта камеры
controls.target.copy(tween.t1);
tween = null;
controls.update();
renderer.shadowMap.needsUpdate = true;
requestAnimationFrame(loop);
document.body.classList.add('ready');

// небольшой API для отладки/встраивания
window.doorViewer = {
  setView, toggleDoor,
  setPreset(i) { applyPreset(i); },
  invalidate() { renderer.shadowMap.needsUpdate = true; needsRender = true; },
  get preset() { return presetIndex; },
  composer, gtao,
  seek(t) { animT = Math.max(0, Math.min(T_TOTAL, t)); applyPose(animT); renderer.shadowMap.needsUpdate = true; needsRender = true; },
  get frames() { return frames; },
  get busy() { return playing || !!tween; },
  get dragging() { return dragging; },
  get prMove() { return prMove; },
  get pixelRatio() { return pixelRatio; },
  camera, controls, renderer, scene,
};
