# -*- coding: utf-8 -*-
"""
Входная дверь с боковым остеклением и рифлёной панелью - Blender 4.x / 5.x (проверено на 5.0.1).

Состав модели (по фото-референсу):
  графитовое полотно 860x2050x75 мм: бортик по периметру, гладкая панель слева, 19 вертикальных планок справа,
  длинная ручка-скоба на 3 стойках; снаружи сверху чёрный квадратный замок под большой ключ, посередине поворотный барашек, снизу замок под мини-ключ, глазок,
  боковое остекление 340 мм (тёмное тонированное стекло, штапики), широкая плоская рама-наличник,
  2 чёрные петли справа (ось уходит вглубь, ствол в зазоре), засовы в трёх точках с ответными планками, уплотнитель,
  тыльная сторона: те же панели, рычажная ручка, барашек замка, глазок; стекло прозрачное с обеих сторон.
  Окружение: небольшая стена из деревянного сайдинга и бетонная площадка (как на фото).
  Материалы процедурные (картинки не нужны): порошковая краска, сайдинг, бетон, стекло, резина.
  Анимация (240 кадров, 24 к/с): отпереть -> открыть наружу -> пауза -> закрыть -> запереть.

Запуск в Blender:   Scripting -> Open -> Run Script
Из консоли:         blender -b -P door_ribbed.py -- --still 1 --view outside --out C:/tmp/door
                    blender -b -P door_ribbed.py -- --anim --out C:/tmp/door
                    blender -b -P door_ribbed.py -- --save C:/tmp/door.blend
Доп. ключи:         --samples 96   --res 1920x1080   --view outside | front | inside | handle | handle_in | hinge | peephole_in | ref

Все размеры в метрах. Меняй константы ниже и запускай заново: сцена пересоздаётся.
Координаты Blender: X вправо (с улицы), -Y = улица (камера), +Y = помещение, Z вверх.
"""
import bpy
import bmesh
import math
import os
import random
import sys
from mathutils import Vector

# ============================ ПАРАМЕТРЫ ============================
LEAF_W, LEAF_H, LEAF_T = 0.86, 2.05, 0.075          # полотно
GAP_HINGE, GAP_LOCK, GAP_FLOOR = 0.0185, 0.005, 0.065
HOFF, BARREL_R = 0.002, 0.0155
SASH_W, MULL_W = 0.34, 0.04                         # боковое остекление и стойка
FD, JW = 0.12, 0.05                                 # глубина коробки/стены, ширина профиля
CASING_W, CASING_T, SILL_H = 0.08, 0.014, 0.06      # наличник-рама и порог рамы
Z_LEAF = 0.034                                      # наружная плоскость полотна (вперёд от оси стены)
REL = 0.012                                         # высота рельефа (бортик, рёбра)

BW, GB = 0.020, 0.003                               # бортик и зазор до него
SMOOTH_END, SEAM = 0.200, 0.004
N_RIBS, RIB_GAP = 19, 0.0075

BAR_XE, BAR_Z0, BAR_Z1 = 0.128, 0.30, 1.71          # ручка-скоба
STANDOFF_Z = (0.46, 1.00, 1.54)
PLATE_XE, PLATE_A_Z, PLATE_B_Z, PLATE_C_Z = 0.062, 1.21, 1.03, 0.85   # сверху большой ключ, посередине щеколда, снизу мини-ключ
PEEP_Z = 1.55                                       # глазок
LEVER_XE, LEVER_Z, THUMB_Z = 0.070, 1.02, 0.80   # изнутри: ручка и барашек
BOLT_Z = (0.45, 1.00, 1.55)
HINGE_Z = (0.115, LEAF_H - 0.115)
OPEN_ANGLE = 105                                    # градусы

WALL_HALF, WALL_H, SIDING_ROWS = 1.30, 2.62, 11
SLAB_W, SLAB_D, SLAB_CZ = 3.8, 3.2, 0.6

COL_DOOR, COL_FRAME = "#43454A", "#62656A"          # графит полотна / светлее рама
SEED = 13
SAMPLES = 64
RES_X, RES_Y = 1600, 1200

# ====================== ПРОИЗВОДНЫЕ ВЕЛИЧИНЫ =======================
W_DOOR = LEAF_W + GAP_HINGE + GAP_LOCK
H_IN = LEAF_H + GAP_FLOOR + 0.005
W_IN = SASH_W + MULL_W + W_DOOR
X0 = -W_IN / 2
XS1 = X0 + SASH_W
XD0 = XS1 + MULL_W
XD1 = W_IN / 2
Z_WB = FD / 2                                       # тыльная плоскость стены
Z_WF = 0.036                                        # лицевая плоскость стены: наличник близко к полотну (зазор 1.6 см), петли видны с боков
Z_CASING = Z_WF + CASING_T
PIVOT_X = XD1 - GAP_HINGE - HOFF                    # ось петель (X)
SINK = BARREL_R + 0.0005                            # ось петли уходит вглубь: ствол целиком в зазоре
Z_PIV = Z_LEAF - SINK
PIVOT = Vector((PIVOT_X, -Z_PIV, GAP_FLOOR))        # в осях Blender

COLL = None
DOOR = None      # ось петель (вращается)
LEAF = None      # полотно: плоскость лица в y = 0
M = {}


# ============================ УТИЛИТЫ ==============================
def lin(c):
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def hexc(h):
    h = h.lstrip('#')
    return lin(tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)))


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.worlds):
        for item in list(coll):
            coll.remove(item)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)


def _finish(name, mesh, loc, rot, mat, parent, bevel=0.0, size=None):
    obj = bpy.data.objects.new(name, mesh)
    obj.location = loc
    obj.rotation_euler = rot
    COLL.objects.link(obj)
    if mat:
        obj.data.materials.append(mat)
    if parent:
        obj.parent = parent
    if bevel > 0 and size:
        b = min(bevel, min(size) * 0.45)
        if b > 0.0003:
            m = obj.modifiers.new("Bevel", 'BEVEL')
            m.width = b
            m.segments = 3 if b > 0.003 else 2
            m.limit_method = 'ANGLE'
    return obj


def make_box(name, size, loc, mat=None, bevel=0.0, parent=None, rot=(0, 0, 0)):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    bm.to_mesh(mesh)
    bm.free()
    return _finish(name, mesh, loc, rot, mat, parent, bevel, size)


def make_cyl(name, r, depth, loc, mat=None, rot=(0, 0, 0), parent=None, segs=40):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs,
                          radius1=r, radius2=r, depth=depth)
    bm.to_mesh(mesh)
    bm.free()
    for p in mesh.polygons:
        p.use_smooth = abs(p.normal.z) < 0.5
    return _finish(name, mesh, loc, rot, mat, parent)


def make_empty(name, loc, parent=None, size=0.05):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'ARROWS'
    e.empty_display_size = size
    e.location = loc
    COLL.objects.link(e)
    if parent:
        e.parent = parent
    return e


def wbox(name, mat, x0, x1, y0, y1, z0, z1, bevel=0.003):
    """Бокс неподвижной части. Аргументы в «веб-осях»: x вправо, y вверх, z на улицу -> оси Blender (x, -z, y)."""
    return make_box(name, (x1 - x0, z1 - z0, y1 - y0), ((x0 + x1) / 2, -(z0 + z1) / 2, (y0 + y1) / 2), mat, bevel)


def lx(xe):
    return xe - LEAF_W + HOFF


def lbox(name, mat, xe0, xe1, yy0, yy1, z0, z1, bevel=0.003, parent=None):
    """Бокс на полотне: xe от левой кромки (вид с улицы), yy вглубь от наружной плоскости, z от низа полотна."""
    return make_box(name, (xe1 - xe0, yy1 - yy0, z1 - z0),
                    (lx((xe0 + xe1) / 2), (yy0 + yy1) / 2, (z0 + z1) / 2), mat, bevel, parent or LEAF)


def lcyl_z(name, mat, r, depth, xe, yy, z, parent=None, segs=40):
    """Цилиндр, ось вдоль Y (перпендикулярно полотну)."""
    return make_cyl(name, r, depth, (lx(xe), yy, z), mat, rot=(math.radians(90), 0, 0), parent=parent or LEAF, segs=segs)


def key_rot(obj, axis, frame, value):
    obj.rotation_euler[axis] = value
    obj.keyframe_insert("rotation_euler", index=axis, frame=frame)


def key_loc(obj, axis, frame, value):
    obj.location[axis] = value
    obj.keyframe_insert("location", index=axis, frame=frame)


# ============================ МАТЕРИАЛЫ ============================
def new_material(name):
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs['BSDF'], out.inputs['Surface'])
    return mat, nt, b, out


def setp(b, names, value):
    for n in names:
        if n in b.inputs:
            b.inputs[n].default_value = value
            return True
    return False


def node(nt, kind, **props):
    n = nt.nodes.new(kind)
    for k, v in props.items():
        setattr(n, k, v)
    return n


def mix_mul(nt, fac):
    n = nt.nodes.new('ShaderNodeMix')
    n.data_type = 'RGBA'
    n.blend_type = 'MULTIPLY'
    n.inputs[0].default_value = fac
    return n.inputs[6], n.inputs[7], n.outputs[2]


def powder_coat(name, hex_color, seed, rough=0.5, bump=0.12):
    """Порошковая краска, сатин: очень мелкая шагрень и лёгкие вариации блеска."""
    rnd = random.Random(seed)
    mat, nt, b, out = new_material(name)
    tc = node(nt, 'ShaderNodeTexCoord')
    mp = node(nt, 'ShaderNodeMapping')
    mp.inputs['Location'].default_value = (rnd.uniform(0, 30), rnd.uniform(0, 30), rnd.uniform(0, 30))
    big = node(nt, 'ShaderNodeTexNoise')
    big.inputs['Scale'].default_value = 3.0
    big.inputs['Detail'].default_value = 3.0
    tone = node(nt, 'ShaderNodeMapRange')
    tone.inputs['To Min'].default_value = 0.93
    tone.inputs['To Max'].default_value = 1.06
    fine = node(nt, 'ShaderNodeTexNoise')
    fine.inputs['Scale'].default_value = 700.0
    fine.inputs['Detail'].default_value = 2.0
    bmp = node(nt, 'ShaderNodeBump')
    bmp.inputs['Strength'].default_value = bump
    bmp.inputs['Distance'].default_value = 0.0004
    rmap = node(nt, 'ShaderNodeMapRange')
    rmap.inputs['To Min'].default_value = rough - 0.08
    rmap.inputs['To Max'].default_value = rough + 0.08
    mA, mB, mOut = mix_mul(nt, 1.0)
    mA.default_value = (*hexc(hex_color), 1)
    lk = nt.links.new
    lk(tc.outputs['Object'], mp.inputs['Vector'])
    lk(mp.outputs['Vector'], big.inputs['Vector'])
    lk(mp.outputs['Vector'], fine.inputs['Vector'])
    lk(big.outputs['Fac'], tone.inputs['Value'])
    lk(tone.outputs['Result'], mB)
    lk(mOut, b.inputs['Base Color'])
    lk(fine.outputs['Fac'], bmp.inputs['Height'])
    lk(bmp.outputs['Normal'], b.inputs['Normal'])
    lk(fine.outputs['Fac'], rmap.inputs['Value'])
    lk(rmap.outputs['Result'], b.inputs['Roughness'])
    return mat


def plain(name, hex_color, rough, metal=0.0):
    mat, nt, b, out = new_material(name)
    setp(b, ['Base Color'], (*hexc(hex_color), 1))
    setp(b, ['Roughness'], rough)
    setp(b, ['Metallic'], metal)
    return mat


def black_matte():
    mat, nt, b, out = new_material("Black_matte")
    setp(b, ['Base Color'], (*hexc("#0C0C0D"), 1))
    setp(b, ['Roughness'], 0.46)
    tc = node(nt, 'ShaderNodeTexCoord')
    noise = node(nt, 'ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 500.0
    bmp = node(nt, 'ShaderNodeBump')
    bmp.inputs['Strength'].default_value = 0.1
    bmp.inputs['Distance'].default_value = 0.0002
    nt.links.new(tc.outputs['Object'], noise.inputs['Vector'])
    nt.links.new(noise.outputs['Fac'], bmp.inputs['Height'])
    nt.links.new(bmp.outputs['Normal'], b.inputs['Normal'])
    return mat


def black_gloss():
    mat, nt, b, out = new_material("Black_gloss")
    setp(b, ['Base Color'], (*hexc("#050506"), 1))
    setp(b, ['Roughness'], 0.16)
    setp(b, ['Coat Weight', 'Clearcoat'], 0.5)
    setp(b, ['Coat Roughness', 'Clearcoat Roughness'], 0.1)
    return mat


def chrome():
    mat, nt, b, out = new_material("Chrome")
    setp(b, ['Base Color'], (0.9, 0.91, 0.93, 1))
    setp(b, ['Metallic'], 1.0)
    setp(b, ['Roughness'], 0.04)
    return mat


def stainless():
    mat, nt, b, out = new_material("Stainless_brushed")
    setp(b, ['Base Color'], (0.64, 0.65, 0.66, 1))
    setp(b, ['Metallic'], 1.0)
    setp(b, ['Roughness'], 0.28)
    tc = node(nt, 'ShaderNodeTexCoord')
    mp = node(nt, 'ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (2.0, 700.0, 700.0)
    noise = node(nt, 'ShaderNodeTexNoise')
    noise.inputs['Detail'].default_value = 4.0
    bmp = node(nt, 'ShaderNodeBump')
    bmp.inputs['Strength'].default_value = 0.25
    bmp.inputs['Distance'].default_value = 0.0002
    nt.links.new(tc.outputs['Object'], mp.inputs['Vector'])
    nt.links.new(mp.outputs['Vector'], noise.inputs['Vector'])
    nt.links.new(noise.outputs['Fac'], bmp.inputs['Height'])
    nt.links.new(bmp.outputs['Normal'], b.inputs['Normal'])
    return mat


def rubber():
    mat, nt, b, out = new_material("Rubber")
    setp(b, ['Base Color'], (0.012, 0.012, 0.012, 1))
    setp(b, ['Roughness'], 0.8)
    return mat


def glass(name, tint_hex, rough, ior):
    """Стекло: пропускание + отражение; не даёт чёрных теней в Cycles (трюк с лучами теней)."""
    mat, nt, b, out = new_material(name)
    setp(b, ['Base Color'], (*hexc(tint_hex), 1))
    setp(b, ['Roughness'], rough)
    setp(b, ['IOR'], ior)
    setp(b, ['Transmission Weight', 'Transmission'], 1.0)
    lpath = node(nt, 'ShaderNodeLightPath')
    tr = node(nt, 'ShaderNodeBsdfTransparent')
    mix = node(nt, 'ShaderNodeMixShader')
    nt.links.new(lpath.outputs['Is Shadow Ray'], mix.inputs['Fac'])
    nt.links.new(b.outputs['BSDF'], mix.inputs[1])
    nt.links.new(tr.outputs['BSDF'], mix.inputs[2])
    nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])
    return mat


def wood_siding():
    """Сайдинг: волокна вдоль доски (вытянутый шум), у каждой доски свой оттенок и смещение узора."""
    mat, nt, b, out = new_material("Wood_siding")
    tc = node(nt, 'ShaderNodeTexCoord')
    oi = node(nt, 'ShaderNodeObjectInfo')
    rnd = node(nt, 'ShaderNodeMath', operation='MULTIPLY')
    rnd.inputs[1].default_value = 37.0
    comb = node(nt, 'ShaderNodeCombineXYZ')
    mp = node(nt, 'ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (1.3, 34.0, 34.0)       # волокна вдоль X
    streak = node(nt, 'ShaderNodeTexNoise')
    streak.inputs['Scale'].default_value = 1.0
    streak.inputs['Detail'].default_value = 5.0
    streak.inputs['Roughness'].default_value = 0.55
    fine = node(nt, 'ShaderNodeTexNoise')
    fine.inputs['Scale'].default_value = 90.0
    fine.inputs['Detail'].default_value = 2.0
    ramp = node(nt, 'ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.30
    ramp.color_ramp.elements[0].color = (*hexc("#8F6C4E"), 1)
    ramp.color_ramp.elements[1].position = 0.72
    ramp.color_ramp.elements[1].color = (*hexc("#B08F63"), 1)
    tone = node(nt, 'ShaderNodeMapRange')
    tone.inputs['To Min'].default_value = 0.88
    tone.inputs['To Max'].default_value = 1.08
    mA, mB, mOut = mix_mul(nt, 1.0)
    bmp = node(nt, 'ShaderNodeBump')
    bmp.inputs['Strength'].default_value = 0.25
    bmp.inputs['Distance'].default_value = 0.0015
    lk = nt.links.new
    lk(oi.outputs['Random'], rnd.inputs[0])
    lk(rnd.outputs['Value'], comb.inputs['X'])
    lk(rnd.outputs['Value'], comb.inputs['Y'])
    lk(comb.outputs['Vector'], mp.inputs['Location'])
    lk(tc.outputs['Object'], mp.inputs['Vector'])
    lk(mp.outputs['Vector'], streak.inputs['Vector'])
    lk(mp.outputs['Vector'], fine.inputs['Vector'])
    lk(streak.outputs['Fac'], ramp.inputs['Fac'])
    lk(ramp.outputs['Color'], mA)
    lk(oi.outputs['Random'], tone.inputs['Value'])
    lk(tone.outputs['Result'], mB)
    lk(mOut, b.inputs['Base Color'])
    lk(fine.outputs['Fac'], bmp.inputs['Height'])
    lk(bmp.outputs['Normal'], b.inputs['Normal'])
    setp(b, ['Roughness'], 0.78)
    return mat


def concrete():
    mat, nt, b, out = new_material("Concrete")
    tc = node(nt, 'ShaderNodeTexCoord')
    n1 = node(nt, 'ShaderNodeTexNoise')
    n1.inputs['Scale'].default_value = 4.0
    n1.inputs['Detail'].default_value = 6.0
    n2 = node(nt, 'ShaderNodeTexNoise')
    n2.inputs['Scale'].default_value = 220.0
    n2.inputs['Detail'].default_value = 8.0
    ramp = node(nt, 'ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (*hexc("#5F605E"), 1)
    ramp.color_ramp.elements[1].color = (*hexc("#7B7B78"), 1)
    bmp = node(nt, 'ShaderNodeBump')
    bmp.inputs['Strength'].default_value = 0.4
    bmp.inputs['Distance'].default_value = 0.002
    lk = nt.links.new
    lk(tc.outputs['Object'], n1.inputs['Vector'])
    lk(tc.outputs['Object'], n2.inputs['Vector'])
    lk(n1.outputs['Fac'], ramp.inputs['Fac'])
    lk(ramp.outputs['Color'], b.inputs['Base Color'])
    lk(n2.outputs['Fac'], bmp.inputs['Height'])
    lk(bmp.outputs['Normal'], b.inputs['Normal'])
    setp(b, ['Roughness'], 0.9)
    return mat


def build_materials():
    M['door'] = powder_coat("Graphite_door", COL_DOOR, SEED, rough=0.52)
    M['doorIn'] = powder_coat("Graphite_door_inside", "#45474B", SEED + 1, rough=0.52)
    M['frame'] = powder_coat("Graphite_frame", COL_FRAME, SEED + 2, rough=0.55)
    M['deep'] = plain("Door_body", "#17181A", 0.7)
    M['black'] = black_matte()
    M['blackGl'] = black_gloss()
    M['blackRim'] = plain("Black_rim", "#0A0A0B", 0.12, 0.7)
    M['void'] = plain("Void", "#000000", 1.0)
    M['chrome'] = chrome()
    M['steel'] = stainless()
    M['rubber'] = rubber()
    M['tint'] = glass("Glass_clear_outer", "#F1F6F4", 0.0, 1.52)    # прозрачное стекло с обеих сторон
    M['glass'] = glass("Glass_clear", "#F2F6F4", 0.0, 1.5)
    M['wood'] = wood_siding()
    M['concrete'] = concrete()
    M['slab'] = plain("Slab_side", "#7C7E81", 0.92)


# ============================ СБОРКА ===============================
def build_frame():
    zb, zf = -Z_WB, Z_WF - 0.002
    HT = H_IN + JW
    f = M['frame']
    # коробка (видны только внутренние грани проёма)
    wbox("Jamb_L", f, X0 - JW, X0, 0, H_IN, zb, zf, 0.002)
    wbox("Jamb_R", f, XD1, XD1 + JW, 0, H_IN, zb, zf, 0.002)
    wbox("Jamb_Head", f, X0 - JW, XD1 + JW, H_IN, HT, zb, zf, 0.002)
    wbox("Sill", f, X0, XD1, 0, SILL_H, zb, zf, 0.002)
    wbox("Mullion", f, XS1, XD0, SILL_H, H_IN, zb, 0.046, 0.0025)       # стойка чуть выступает вперёд

    # упорная полка для полотна с внутренней стороны + уплотнитель
    lz1 = zb + 0.018
    wbox("Lip_L", f, XD0, XD0 + 0.028, SILL_H, H_IN, zb, lz1, 0.002)
    wbox("Lip_R", f, XD1 - 0.028, XD1, SILL_H, H_IN, zb, lz1, 0.002)
    wbox("Lip_T", f, XD0, XD1, H_IN - 0.028, H_IN, zb, lz1, 0.002)
    r = M['rubber']
    wbox("Seal_L", r, XD0 + 0.010, XD0 + 0.020, SILL_H, H_IN - 0.028, lz1, lz1 + 0.007, 0.003)
    wbox("Seal_R", r, XD1 - 0.020, XD1 - 0.010, SILL_H, H_IN - 0.028, lz1, lz1 + 0.007, 0.003)
    wbox("Seal_T", r, XD0 + 0.010, XD1 - 0.010, H_IN - 0.020, H_IN - 0.010, lz1, lz1 + 0.007, 0.003)

    # наружный наличник-рама: широкая плоская рамка вокруг всей конструкции
    zc0, zc1, CW = Z_WF, Z_CASING, CASING_W
    wbox("Casing_L", f, X0 - CW, X0, 0, H_IN + CW, zc0, zc1, 0.002)
    wbox("Casing_R", f, XD1, XD1 + CW, 0, H_IN + CW, zc0, zc1, 0.002)
    wbox("Casing_T", f, X0, XD1, H_IN, H_IN + CW, zc0, zc1, 0.002)
    wbox("Casing_B", f, X0, XD1, 0, SILL_H, zc0, zc1, 0.002)
    tb, zt = 0.005, zc1 + 0.0025
    wbox("Bead_L", f, X0, X0 + tb, SILL_H, H_IN, zc0, zt, 0.0012)
    wbox("Bead_T", f, X0, XD1, H_IN - tb, H_IN, zc0, zt, 0.0012)
    # внутренний наличник
    zi0, zi1 = -Z_WB - CASING_T, -Z_WB
    wbox("CasingIn_L", f, X0 - CW, X0, 0, H_IN + CW, zi0, zi1, 0.002)
    wbox("CasingIn_R", f, XD1, XD1 + CW, 0, H_IN + CW, zi0, zi1, 0.002)
    wbox("CasingIn_T", f, X0, XD1, H_IN, H_IN + CW, zi0, zi1, 0.002)
    wbox("CasingIn_B", f, X0, XD1, 0, SILL_H, zi0, zi1, 0.002)


def build_sidelight():
    f = M['frame']
    y0, y1, zf, zb = GAP_FLOOR, H_IN - 0.005, 0.040, 0.0
    st, top, bot = 0.04, 0.05, 0.055
    wbox("Sash_L", f, X0, X0 + st, y0, y1, zb, zf, 0.002)
    wbox("Sash_R", f, XS1 - st, XS1, y0, y1, zb, zf, 0.002)
    wbox("Sash_T", f, X0 + st, XS1 - st, y1 - top, y1, zb, zf, 0.002)
    wbox("Sash_B", f, X0 + st, XS1 - st, y0, y0 + bot, zb, zf, 0.002)
    tb, zt = 0.004, zf + 0.002
    wbox("SashRim_L", f, X0, X0 + tb, y0, y1, zf, zt, 0.001)
    wbox("SashRim_R", f, XS1 - tb, XS1, y0, y1, zf, zt, 0.001)
    wbox("SashRim_T", f, X0, XS1, y1 - tb, y1, zf, zt, 0.001)
    wbox("SashRim_B", f, X0, XS1, y0, y0 + tb, zf, zt, 0.001)
    gx0, gx1, gy0, gy1 = X0 + st, XS1 - st, y0 + bot, y1 - top
    wbox("Glass_outer", M['tint'], gx0 - 0.008, gx1 + 0.008, gy0 - 0.008, gy1 + 0.008, 0.024, 0.030, 0)
    wbox("Glass_inner", M['glass'], gx0 - 0.008, gx1 + 0.008, gy0 - 0.008, gy1 + 0.008, 0.006, 0.012, 0)
    bw, bz0, bz1 = 0.014, 0.030, 0.043
    wbox("Gbead_T", f, gx0, gx1, gy1 - bw + 0.006, gy1 + 0.006, bz0, bz1, 0.0012)
    wbox("Gbead_B", f, gx0, gx1, gy0 - 0.006, gy0 + bw - 0.006, bz0, bz1, 0.0012)
    wbox("Gbead_L", f, gx0 - 0.006, gx0 + bw - 0.006, gy0, gy1, bz0, bz1, 0.0012)
    wbox("Gbead_R", f, gx1 - bw + 0.006, gx1 + 0.006, gy0, gy1, bz0, bz1, 0.0012)


def build_wall_and_floor():
    HT = H_IN + JW
    h = HT / SIDING_ROWS
    xl1, xr0 = X0 - JW, XD1 + JW
    rows = math.ceil(WALL_H / h)
    for r in range(rows):
        y0, y1 = r * h, min(WALL_H, (r + 1) * h)
        segs = ((-WALL_HALF, xl1), (xr0, WALL_HALF)) if y1 <= HT + 1e-6 else ((-WALL_HALF, WALL_HALF),)
        for i, (a, b) in enumerate(segs):
            wbox(f"Siding_{r}_{i}", M['wood'], a, b, y0, y1, -Z_WB, Z_WF, 0.0045)
    # бетонная площадка
    slab = make_box("Slab", (SLAB_W, SLAB_D, 0.07), (0, SLAB_CZ * -1, -0.035), M['concrete'], 0.002)
    slab.data.materials.append(M['slab'])


def build_panels(p, tag):
    """Панели одной стороны: бортик, гладкая панель у замковой кромки, 19 планок.
    Внутренняя сторона - те же панели на зеркальном родителе (одинаковые с обеих сторон)."""
    zi0, zi1 = BW + GB, LEAF_H - BW - GB
    xi0, xi1 = BW + GB, LEAF_W - BW - GB
    d = M['door']
    lbox(f"{tag}Ring_top", d, 0, LEAF_W, 0, REL, LEAF_H - BW, LEAF_H, 0.0018, p)
    lbox(f"{tag}Ring_bottom", d, 0, LEAF_W, 0, REL, 0, BW, 0.0018, p)
    lbox(f"{tag}Ring_left", d, 0, BW, 0, REL, BW + GB, LEAF_H - BW - GB, 0.0018, p)
    lbox(f"{tag}Ring_right", d, LEAF_W - BW, LEAF_W, 0, REL, BW + GB, LEAF_H - BW - GB, 0.0018, p)
    lbox(f"{tag}Smooth_panel", d, xi0, SMOOTH_END, 0, REL, zi0, zi1, 0.0022, p)
    xf0 = SMOOTH_END + SEAM
    pitch = (xi1 - xf0) / N_RIBS
    rw = pitch - RIB_GAP
    for k in range(N_RIBS):
        a = xf0 + k * pitch + RIB_GAP / 2
        lbox(f"{tag}Rib_{k + 1:02d}", d, a, a + rw, 0, REL, zi0, zi1, 0.0016, p)


def add_thumbturn(p, tag, z):
    """Поворотный барашек на квадратной накладке (вращается ключом); одинаковый снаружи и изнутри."""
    bk = M['black']
    lbox(f"{tag}Thumb_plate", bk, PLATE_XE - 0.018, PLATE_XE + 0.018, -0.009, 0.002, z - 0.024, z + 0.024, 0.003, p)
    turn = make_empty(f"{tag}Thumb_pivot", (lx(PLATE_XE), 0, z), p, 0.02)
    make_cyl(f"{tag}Thumb_hub", 0.0085, 0.012, (0, -0.015, 0), bk, rot=(math.radians(90), 0, 0), parent=turn, segs=28)
    make_box(f"{tag}Thumb_bar", (0.011, 0.009, 0.040), (0, -0.0255, 0), bk, 0.003, turn)
    return turn


def build_exterior_hw(p):
    """Наружная сторона: ручка-скоба, чёрный квадратный замок под большой ключ (верх), барашек (середина),
    замок под мини-ключ (низ), глазок."""
    bk, deep, chrome_ = M['black'], M['deep'], M['chrome']
    bar_w, bar_d, so = 0.032, 0.042, 0.052
    lbox("Out_Pull_bar", bk, BAR_XE - bar_w / 2, BAR_XE + bar_w / 2, -so - bar_d, -so, BAR_Z0, BAR_Z1, 0.0045, p)
    for i, z in enumerate(STANDOFF_Z):
        lbox(f"Out_Standoff_{i + 1}", bk, BAR_XE - 0.011, BAR_XE + 0.011, -so, 0.002, z - 0.022, z + 0.022, 0.0025, p)
        lcyl_z(f"Out_Standoff_rose_{i + 1}", bk, 0.015, 0.003, BAR_XE, -0.0005, z, parent=p, segs=36)

    # A (верх): КВАДРАТНЫЙ замок в чёрном цвете: резиновая прокладка, глянцевый ободок,
    # выпуклая подушкой накладка и замочная скважина с бородкой
    ax, az = PLATE_XE, PLATE_A_Z
    make_box("Out_Lock_gasket", (0.068, 0.003, 0.068), (lx(ax), -0.0005, az), M['rubber'], 0.0045, p)
    make_box("Out_Lock_rim", (0.062, 0.0075, 0.062), (lx(ax), -0.0030, az), M['blackRim'], 0.0055, p)
    make_box("Out_Lock_face", (0.052, 0.0115, 0.052), (lx(ax), -0.0066, az), M['blackGl'], 0.0095, p)
    for n, (w, h, dx) in enumerate(((0.020, 0.0034, 0.0), (0.0045, 0.0085, 0.0022), (0.0030, 0.0060, -0.0050))):
        make_box(f"Out_Keyhole_{n}", (w, 0.0012, h), (lx(ax) + dx, -0.0128, az), M['void'], 0.0003, p)

    # B (середина): поворотный барашек (копия внутреннего)
    turn_out = add_thumbturn(p, "Out_", PLATE_B_Z)

    # C (низ): замок под МИНИ-ключ - маленькая круглая скважина, поворачивается ключом
    cX, cZ = PLATE_XE, PLATE_C_Z
    lbox("Out_Plate_minikey", bk, cX - 0.019, cX + 0.019, -0.009, 0.002, cZ - 0.021, cZ + 0.021, 0.003, p)
    lcyl_z("Out_Minikey_ring", chrome_, 0.0078, 0.0016, cX, -0.0092, cZ, parent=p, segs=32)
    mini = make_empty("Out_Minikey_pivot", (lx(cX), 0, cZ), p, 0.02)
    make_cyl("Out_Minikey_disc", 0.0058, 0.0018, (0, -0.0100, 0), M['blackGl'], rot=(math.radians(90), 0, 0), parent=mini, segs=28)
    make_box("Out_Minikey_slit", (0.0016, 0.0010, 0.0078), (0, -0.0112, 0), deep, 0.0004, mini)

    # глазок: хромированный окуляр с тёмной линзой (на гладкой панели над замками)
    lcyl_z("Out_Peephole_ring", chrome_, 0.0105, 0.0055, PLATE_XE, -0.0028, PEEP_Z, parent=p, segs=40)
    lcyl_z("Out_Peephole_lens", M['blackGl'], 0.0066, 0.0066, PLATE_XE, -0.0035, PEEP_Z, parent=p, segs=32)
    return {"mini": mini, "turn_out": turn_out}


def build_interior_hw(p):
    """Внутренняя сторона: ручка-рычаг, барашек замка, глазок."""
    bk = M['black']
    lcyl_z("In_Peephole_ring", M['chrome'], 0.0125, 0.0050, PLATE_XE, -0.0025, PEEP_Z, parent=p, segs=40)
    lcyl_z("In_Peephole_body", bk, 0.0092, 0.0120, PLATE_XE, -0.0080, PEEP_Z, parent=p, segs=32)
    lcyl_z("In_Peephole_cover", M['blackGl'], 0.0060, 0.0022, PLATE_XE, -0.0145, PEEP_Z, parent=p, segs=28)

    lbox("In_Lever_rose", bk, LEVER_XE - 0.025, LEVER_XE + 0.025, -0.008, 0.002, LEVER_Z - 0.025, LEVER_Z + 0.025, 0.004, p)
    lever = make_empty("In_Lever_pivot", (lx(LEVER_XE), 0, LEVER_Z), p, 0.03)
    make_cyl("In_Lever_base", 0.019, 0.007, (0, -0.0115, 0), bk, rot=(math.radians(90), 0, 0), parent=lever, segs=36)
    make_cyl("In_Lever_neck", 0.0095, 0.028, (0, -0.029, 0), bk, rot=(math.radians(90), 0, 0), parent=lever, segs=28)
    make_box("In_Lever_arm", (0.150, 0.016, 0.022), (0.062, -0.049, 0), bk, 0.006, lever)

    turn = add_thumbturn(p, "In_", THUMB_Z)
    return {"lever": lever, "turn": turn}


def build_leaf():
    y_body_end = LEAF_T - REL
    d = M['door']
    # тёмное тело (видно в пазах обеих сторон) + окрашенные торцы
    lbox("Body", M['deep'], 0, LEAF_W, REL, y_body_end, 0, LEAF_H, 0.003)
    lbox("Edge_lock", d, -0.0005, 0.0015, 0, LEAF_T, 0, LEAF_H, 0.0008)
    lbox("Edge_hinge", d, LEAF_W - 0.0015, LEAF_W + 0.0005, 0, LEAF_T, 0, LEAF_H, 0.0008)
    lbox("Edge_top", d, 0, LEAF_W, 0, LEAF_T, LEAF_H - 0.0015, LEAF_H + 0.0005, 0.0008)
    lbox("Edge_bottom", d, 0, LEAF_W, 0, LEAF_T, -0.0005, 0.0015, 0.0008)

    # лицевая сторона и внутренняя (зеркальная копия панелей), у каждой своя фурнитура
    build_panels(LEAF, "Out_")
    ext = build_exterior_hw(LEAF)
    mirror = make_empty("Inside_mirror", (0, LEAF_T, 0), LEAF, 0.05)
    mirror.scale = (1, -1, 1)
    build_panels(mirror, "In_")
    inn = build_interior_hw(mirror)

    # ---- засовы на торце замковой стороны (выдвигаются в стойку) ----
    bolts = []
    for i, z in enumerate(BOLT_Z):
        b = make_box(f"Bolt_{i + 1}", (0.040, 0.014, 0.030), (lx(0.0) - 0.007, LEAF_T * 0.42, z), M['chrome'], 0.002, LEAF)
        bolts.append(b)
    lbox("Lock_faceplate", M['black'], -0.0014, 0.0014, 0.040 - 0.014, 0.040 + 0.014, BOLT_Z[0] - 0.05, BOLT_Z[2] + 0.05, 0.0006)

    # ---- петли: ось уходит вглубь, ствол целиком спрятан в зазоре между полотном и коробкой ----
    for i, hz in enumerate(HINGE_Z):
        y = GAP_FLOOR + hz
        wbox(f"Hinge_frameplate_{i + 1}", M['black'], XD1 - 0.0045, XD1, y - 0.075, y + 0.075, Z_PIV - 0.024, Z_PIV + 0.024, 0.001)
        for j, dy in enumerate((-0.055, 0.0, 0.055)):
            make_cyl(f"Hinge_knuckle_{i + 1}_{j + 1}", BARREL_R, 0.050, (PIVOT_X, -Z_PIV, y + dy), M['black'], segs=48)
        make_cyl(f"Hinge_pin_{i + 1}", 0.0062, 0.172, (PIVOT_X, -Z_PIV, y), M['steel'], segs=20)
        for s_ in (-1, 1):
            make_cyl(f"Hinge_cap_{i + 1}_{s_}", BARREL_R + 0.0006, 0.007, (PIVOT_X, -Z_PIV, y + s_ * 0.0885), M['black'], segs=48)

    # ---- ответные планки в стойке для засовов ----
    for i, z in enumerate(BOLT_Z):
        yy = GAP_FLOOR + z
        zz = Z_LEAF - LEAF_T * 0.42
        wbox(f"Strike_{i + 1}", M['black'], XD0, XD0 + 0.003, yy - 0.04, yy + 0.04, zz - 0.016, zz + 0.016, 0.0008)
        wbox(f"Strike_hole_{i + 1}", M['deep'], XD0, XD0 + 0.0042, yy - 0.0175, yy + 0.0175, zz - 0.0075, zz + 0.0075, 0.0004)
    parts = {"bolts": bolts}
    parts.update(ext)
    parts.update(inn)
    return parts


# ============================ АНИМАЦИЯ ============================
def animate(parts):
    """240 кадров, 24 к/с (10 с): отпереть -> нажать ручку -> открыть -> закрыть -> запереть."""
    fps = 24

    def f(t):
        return int(round(t * fps)) + 1

    angle = math.radians(OPEN_ANGLE)
    # полотно открывается наружу (в сторону -Y): положительный угол вокруг Z
    for t, v in ((0, 0), (1.9, 0), (4.5, angle), (5.6, angle), (8.0, 0), (10, 0)):
        key_rot(DOOR, 2, f(t), v)
    # мини-ключ и барашки (снаружи и изнутри) поворачиваются вместе
    for t, v in ((0, 0), (0.4, 0), (1.2, math.pi / 2), (8.3, math.pi / 2), (9.1, 0), (10, 0)):
        key_rot(parts["mini"], 1, f(t), -v)
        key_rot(parts["turn_out"], 1, f(t), v)
        key_rot(parts["turn"], 1, f(t), v)
    # засовы замка на торце втягиваются в полотно (в сторону петель, +X локально)
    for b in parts["bolts"]:
        x0 = b.location[0]
        for t, v in ((0, 0), (0.7, 0), (1.4, 0.027), (8.3, 0.027), (9.0, 0), (10, 0)):
            key_loc(b, 0, f(t), x0 + v)
    # внутренняя ручка нажимается при открывании
    for t, v in ((0, 0), (1.5, 0), (1.9, 0.5), (2.6, 0.5), (3.0, 0), (10, 0)):
        key_rot(parts["lever"], 1, f(t), v)


# ============================ СЦЕНА ============================
def aim(obj, target):
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def setup_world(sc):
    """Освещает небо (ярко-голубое, но слабое), а камера видит мягкий серый градиент (как фон сайта)."""
    w = bpy.data.worlds.new("World")
    sc.world = w
    try:
        w.use_nodes = True
    except Exception:
        pass
    nt = w.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputWorld')
    sky_bg = nt.nodes.new('ShaderNodeBackground')
    sky_bg.inputs['Strength'].default_value = 0.30
    cam_bg = nt.nodes.new('ShaderNodeBackground')
    cam_bg.inputs['Strength'].default_value = 1.0
    mix = nt.nodes.new('ShaderNodeMixShader')
    lpath = nt.nodes.new('ShaderNodeLightPath')
    tcoord = nt.nodes.new('ShaderNodeTexCoord')
    grad = nt.nodes.new('ShaderNodeValToRGB')
    grad.color_ramp.elements[0].position = 0.15
    grad.color_ramp.elements[0].color = (0.44, 0.46, 0.49, 1)
    grad.color_ramp.elements[1].position = 0.85
    grad.color_ramp.elements[1].color = (0.86, 0.88, 0.91, 1)
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    lk = nt.links.new
    lk(tcoord.outputs['Window'], sep.inputs['Vector'])
    lk(sep.outputs['Y'], grad.inputs['Fac'])
    lk(grad.outputs['Color'], cam_bg.inputs['Color'])
    lk(lpath.outputs['Is Camera Ray'], mix.inputs['Fac'])
    lk(sky_bg.outputs['Background'], mix.inputs[1])
    lk(cam_bg.outputs['Background'], mix.inputs[2])
    lk(mix.outputs['Shader'], out.inputs['Surface'])
    try:
        sky = nt.nodes.new('ShaderNodeTexSky')
        for t in ('MULTIPLE_SCATTERING', 'SINGLE_SCATTERING', 'NISHITA'):
            try:
                sky.sky_type = t
                break
            except TypeError:
                continue
        try:
            sky.sun_disc = False          # прямой свет даёт лампа Sun (мягкие тени)
        except Exception:
            pass
        sky.sun_elevation = math.radians(38)
        desat = nt.nodes.new('ShaderNodeHueSaturation')      # небо нейтральнее (без сильного синего оттенка)
        desat.inputs['Saturation'].default_value = 0.35
        lk(sky.outputs['Color'], desat.inputs['Color'])
        lk(desat.outputs['Color'], sky_bg.inputs['Color'])
    except Exception:
        sky_bg.inputs['Color'].default_value = (0.62, 0.68, 0.78, 1)


def setup_scene(view, samples, res):
    sc = bpy.context.scene
    sc.frame_start, sc.frame_end = 1, 241
    sc.render.fps = 24
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    # нейтральная тональная кривая: сохраняет цвета (AgX по умолчанию заметно обесцвечивает)
    for vt in ('Khronos PBR Neutral', 'Standard'):
        try:
            sc.view_settings.view_transform = vt
            break
        except TypeError:
            continue
    sc.view_settings.exposure = -0.15
    setup_world(sc)

    # мягкое солнце (широкий угол = мягкие тени, как при лёгкой облачности)
    sun = bpy.data.lights.new("Sun", 'SUN')
    sun.energy = 3.2
    sun.angle = math.radians(9)
    so = bpy.data.objects.new("Sun", sun)
    so.location = (3.2, -5.4, 5.2)
    COLL.objects.link(so)
    aim(so, (0, 0, 1.0))

    # свет со стороны помещения (чтобы тыльная сторона не уходила в чёрное)
    room = bpy.data.lights.new("Room", 'AREA')
    room.energy, room.size = 380, 3.0
    ro = bpy.data.objects.new("Room", room)
    ro.location = (-1.8, 3.4, 2.4)
    COLL.objects.link(ro)
    aim(ro, (0, 0, 1.0))

    views = {   # (позиция камеры, цель, фокусное мм)
        'outside': ((2.35, -3.70, 1.40), (0.05, -0.05, 1.08), 36),
        'ref':     ((1.75, -2.55, 1.30), (0.0, 0.0, 1.08), 40),
        'front':   ((0.15, -4.60, 1.15), (0.0, 0.0, 1.08), 44),
        'inside':  ((-2.35, 3.70, 1.40), (0.0, 0.05, 1.08), 36),
        'handle':  ((-0.62, -0.88, 1.12), (-0.14, -0.04, 1.06), 40),
        'handle_in': ((-0.62, 0.88, 1.12), (-0.14, 0.04, 1.06), 40),
        'lock_top': ((-0.35, -0.50, 1.25), (-0.18, 0.0, 1.21), 50),
        'hinge_front': ((PIVOT_X, -0.55, 2.0), (PIVOT_X, -Z_PIV, 1.99), 50),
        'hinge':   ((PIVOT_X + 0.55, -0.80, 1.95), (PIVOT_X - 0.02, -Z_PIV, 1.97), 45),
        'peephole_in': ((0.05, 0.75, 1.50), (-0.18, 0.0, 1.50), 42),
    }
    loc, tgt, lens = views.get(view, views['outside'])
    cd = bpy.data.cameras.new("Camera")
    cd.lens = lens
    cam = bpy.data.objects.new("Camera", cd)
    cam.location = loc
    COLL.objects.link(cam)
    aim(cam, tgt)
    sc.camera = cam
    return sc


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    o = {"still": None, "anim": False, "save": None, "samples": SAMPLES, "res": (RES_X, RES_Y),
         "view": "outside", "out": os.path.join(os.path.expanduser("~"), "door_render", "door")}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--still":
            o["still"] = int(argv[i + 1]); i += 1
        elif a == "--anim":
            o["anim"] = True
        elif a == "--samples":
            o["samples"] = int(argv[i + 1]); i += 1
        elif a == "--res":
            w, h = argv[i + 1].lower().split("x")
            o["res"] = (int(w), int(h)); i += 1
        elif a in ("--out", "--save", "--view"):
            o[a[2:]] = argv[i + 1]; i += 1
        i += 1
    return o


def main():
    global COLL, DOOR, LEAF
    opts = parse_args()
    clear_scene()
    COLL = bpy.data.collections.new("Door_ribbed")
    bpy.context.scene.collection.children.link(COLL)

    build_materials()
    DOOR = make_empty("Door_pivot", PIVOT, None, 0.1)
    LEAF = make_empty("Door_leaf", (0, -SINK, 0), DOOR, 0.06)

    build_frame()
    build_sidelight()
    build_wall_and_floor()
    parts = build_leaf()
    animate(parts)

    sc = setup_scene(opts["view"], opts["samples"], opts["res"])
    sc.frame_set(1)
    bpy.context.view_layer.update()

    out_dir = os.path.dirname(opts["out"])
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    if opts["save"]:
        bpy.ops.wm.save_as_mainfile(filepath=opts["save"])
    if opts["still"] is not None:
        sc.frame_set(opts["still"])
        sc.render.filepath = opts["out"] + ".png"
        bpy.ops.render.render(write_still=True)
    if opts["anim"]:
        sc.render.image_settings.file_format = 'FFMPEG'
        sc.render.ffmpeg.format = 'MPEG4'
        sc.render.ffmpeg.codec = 'H264'
        sc.render.filepath = opts["out"] + "_"
        bpy.ops.render.render(animation=True)
    print("Дверь собрана. Пробел в таймлайне запускает анимацию.")


main()
