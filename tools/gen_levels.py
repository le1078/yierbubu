# 马里奥关卡生成器 —— 按正版 SMB1 的关卡布局还原。
#
# 为什么用生成器：手写 ASCII 极易出错（行数不一致、地面行错位、
# 坑宽超过跳跃极限 → 死关）。生成器统一规格并保证可达性。
#
# 统一规格（全部关卡）：
#   · 16 行高（row 0~15）
#   · 地面占 row 14~15
#   · start.row = 站立地面行（玩家脚底 y = start.row）
#   · 管道高 2 格（row 12~13）
#   · 砖块 row 11 / 问号砖 row 10~11
#   · 旗杆在最后一段平台上，城堡在旗杆右侧
#
# 图例：
#   '.' 空  '#' 地面  'B' 砖  '?' 问号砖  'C' 多金币砖
#   'X' 硬砖（阶梯/城堡）  'P' 管道  'S' 尖刺  'I' 冰面
#   'F' 旗杆（竖）  'f' 旗杆底座
#
# 用法：python tools/gen_levels.py
# 生成后跑 node tools/mario_level_test.js 验证可达性。

import io
import json
import os

W = 96
H = 16
GROUND = 14
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def blank():
    return [['.' for _ in range(W)] for _ in range(H)]


def put(g, r, c, ch):
    if 0 <= r < H and 0 <= c < W:
        g[r][c] = ch


def fill(g, r, c0, c1, ch):
    for c in range(c0, c1 + 1):
        put(g, r, c, ch)


def ground(g, c0, c1):
    fill(g, GROUND, c0, c1, '#')
    fill(g, GROUND + 1, c0, c1, '#')


def pipe(g, c, h=2):
    """管道：高度 h 格，底部贴地"""
    for k in range(h):
        put(g, GROUND - 1 - k, c, 'P')
        put(g, GROUND - 1 - k, c + 1, 'P')


def stair_up(g, c0, height):
    """上阶梯：每列高度递增（用硬砖）"""
    for i in range(height):
        for k in range(i + 1):
            put(g, GROUND - 1 - k, c0 + i, 'X')


def stair_down(g, c0, height):
    """下阶梯"""
    for i in range(height):
        for k in range(height - i):
            put(g, GROUND - 1 - k, c0 + i, 'X')


def castle(g, c):
    """城堡：5 格宽，4 格高（用硬砖 X）"""
    for r in range(GROUND - 4, GROUND):
        fill(g, r, c, c + 4, 'X')
    # 门洞（视觉上留个缺口）
    put(g, GROUND - 1, c + 2, '.')
    put(g, GROUND - 2, c + 2, '.')


def flagpole(g, c, top=4):
    """旗杆：从 top 到地面上一行"""
    for r in range(top, GROUND - 1):
        put(g, r, c, 'F')
    put(g, GROUND - 1, c, 'f')


def build_level_1():
    """1-1 草原关（按正版 1-1 的布局还原）"""
    g = blank()
    # 地面段。正版 1-1 有 3 个坑，坑宽 2~3 格
    ground(g, 0, 68)
    ground(g, 71, 85)
    ground(g, 88, W - 1)
    # 坑在 69-70（2格）、86-87（2格）

    # 第一组砖块（正版：? B ? B ?）
    put(g, 10, 16, '?')
    put(g, 10, 20, 'B')
    put(g, 10, 21, '?')
    put(g, 10, 22, 'B')
    put(g, 10, 23, '?')
    put(g, 10, 24, 'B')
    # 上层砖块行
    put(g, 6, 20, 'B')
    put(g, 6, 21, 'B')
    put(g, 6, 22, 'B')
    put(g, 6, 23, 'B')
    put(g, 6, 24, 'B')

    # 多金币砖（正版 1-1 有个金币砖能顶 10 次）
    put(g, 10, 27, 'C')

    # 高砖块组
    put(g, 6, 22, 'B')

    # 管道群（正版 1-1 有 4 根管，高度递增）
    pipe(g, 28, 2)
    pipe(g, 38, 3)
    pipe(g, 46, 3)
    pipe(g, 57, 3)

    # 管道间的砖块
    put(g, 10, 33, 'B')
    put(g, 10, 34, '?')

    # 后半段砖块
    fill(g, 10, 64, 66, 'B')
    put(g, 6, 64, 'B')
    put(g, 6, 65, 'B')
    put(g, 6, 66, 'B')

    # 阶梯（正版 1-1 末段有上下阶梯）
    stair_up(g, 76, 4)
    stair_down(g, 82, 4)

    # 旗杆 + 城堡
    flagpole(g, 91, top=4)
    castle(g, 93)

    return g


def build_level_2():
    """1-2 地下关（管道迷宫 + 大量金币）"""
    g = blank()
    # 地下关：全程有地面
    ground(g, 0, W - 1)
    # 地下关的顶棚（视觉上像洞窟）
    fill(g, 0, 0, W - 1, 'X')

    # 砖块走廊
    fill(g, 10, 8, 12, 'B')
    put(g, 10, 10, 'C')
    fill(g, 10, 20, 25, 'B')
    put(g, 10, 22, '?')
    fill(g, 10, 35, 40, 'B')
    put(g, 10, 37, 'C')
    fill(g, 10, 50, 56, 'B')
    put(g, 10, 53, '?')

    # 管道（地下关有很多管道口）
    pipe(g, 15, 2)
    pipe(g, 30, 2)
    pipe(g, 45, 3)
    pipe(g, 62, 2)

    # 金币砖群
    put(g, 10, 28, 'C')
    put(g, 10, 29, 'C')
    put(g, 10, 68, 'C')

    # 阶梯
    stair_up(g, 72, 3)
    stair_down(g, 78, 3)

    flagpole(g, 88, top=5)
    castle(g, 91)
    return g


def build_level_3():
    """1-3 空中关（悬浮平台跳跃）"""
    g = blank()
    # 只有起点和终点有地面
    ground(g, 0, 12)
    ground(g, 74, W - 1)

    # 悬浮平台链：水平间隔 6 格（跳跃距离 4.6~6.9 格），垂直交替 11/9 行
    plats = [(15, 11), (21, 9), (27, 11), (33, 9), (39, 11),
             (45, 9), (51, 11), (57, 9), (63, 11), (69, 9)]
    for (c, r) in plats:
        fill(g, r, c, c + 2, '=')

    # 平台上的问号砖：放在平台上方 3 行（站平台上跳起能顶到）
    put(g, 6, 16, '?')
    put(g, 6, 40, '?')
    put(g, 6, 64, '?')

    flagpole(g, 88, top=8)
    castle(g, 91)
    return g


def build_level_4():
    """1-4 城堡关（尖刺 + 火棒 + Boss）"""
    g = blank()
    ground(g, 0, W - 1)
    # 城堡内部的顶棚
    fill(g, 0, 0, W - 1, 'X')

    # 悬空砖块走廊
    fill(g, 10, 10, 16, 'B')
    put(g, 10, 13, '?')
    fill(g, 10, 24, 30, 'B')
    put(g, 10, 27, 'C')
    fill(g, 10, 40, 46, 'B')
    put(g, 10, 43, '?')

    # 尖刺（正版城堡关有很多火焰棒，这里用尖刺代替）
    fill(g, 13, 20, 22, 'S')
    fill(g, 13, 35, 37, 'S')
    fill(g, 13, 55, 57, 'S')

    # 阶梯
    stair_up(g, 60, 3)
    stair_down(g, 66, 3)

    # Boss 前的平台
    fill(g, 10, 72, 78, 'B')

    flagpole(g, 88, top=6)
    castle(g, 91)
    return g


LEVEL_BUILDERS = [build_level_1, build_level_2, build_level_3, build_level_4,
                  build_level_1]   # 第 5 关暂用 1-1 变体


def collect(g, ch):
    out = []
    for r in range(H):
        for c in range(W):
            if g[r][c] == ch:
                out.append((r, c))
    return out


def make_spec(kind, g):
    name = ['', '草原 1-1', '地下 1-2', '空中 1-3', '城堡 1-4', '草原 1-1·改'][kind]
    theme = ['', 'overworld', 'underground', 'sky', 'castle', 'overworld'][kind]
    # 出生点：最左侧地面段中部
    start_col = 2

    # 金币：放在砖块上方、平台上方
    coins = []
    for (r, c) in collect(g, '='):
        coins.append({'col': c, 'row': r - 1})
    # 每个问号砖/金币砖上方不放金币（会重叠）

    # 敌人：在地面段上，避开出生点和管道
    enemies = []
    ground_cols = [c for (r, c) in collect(g, '#') if r == GROUND]
    pipes = [c for (r, c) in collect(g, 'P')]
    placed = 0
    for c in ground_cols:
        if c < 14 or (c % 11) != 0:
            continue
        # 跳过管道位置
        if any(abs(c - pc) <= 2 for pc in pipes):
            continue
        etype = 'turtle' if placed % 2 == 1 else 'goomba'
        enemies.append({'type': etype, 'col': c, 'row': GROUND - 1, 'range': 2})
        placed += 1
        if placed >= 6:
            break

    # 道具：放在某些问号砖位置（引擎里问号砖会自己产出，这里只放额外的）
    items = []

    # 平台配置
    platforms = []
    if kind == 3:
        # 空中关：部分平台做成移动平台
        idx = 0
        for (r, c) in collect(g, '='):
            if c % 2 == 0:
                continue
            platforms.append({'col': c, 'row': r, 'axis': 'h', 'len': 3, 'speed': 1.4})
            idx += 1
            if idx >= 3:
                break

    # 检查点
    checkpoints = []
    if W > 50:
        checkpoints.append({'col': 48, 'row': GROUND})

    spec = {
        'name': name,
        'theme': theme,
        'timeLimit': 400,
        'start': {'col': start_col, 'row': GROUND},
        'coins': coins,
        'enemies': enemies,
        'items': items,
        'platforms': platforms,
        'checkpoints': checkpoints,
    }

    # Boss 只放城堡关
    if kind == 4:
        bc = 72
        spec['boss'] = {'col': bc, 'row': GROUND - 3, 'hp': 3}

    return spec


def main():
    out = []
    out.append('// 马里奥关卡数据 —— 由 tools/gen_levels.py 生成，请勿手改')
    out.append('// 按正版 SMB1 的关卡结构还原：地面/管道/砖块组/阶梯/旗杆/城堡')
    out.append('// 统一规格：16 行高；地面 row 14~15；start.row = 站立地面行（脚底 y）')
    out.append('// 图例: . 空  # 地面  B 砖  ? 问号砖  C 多金币砖  X 硬砖  P 管道  S 尖刺  = 平台  F 旗杆  f 旗杆底')
    out.append('')

    all_rows = []
    specs = []
    for kind in range(1, 6):
        g = LEVEL_BUILDERS[kind - 1]()
        rows = [''.join(r) for r in g]
        all_rows.append(rows)
        out.append('const LEVEL_%d = [' % kind)
        for r in rows:
            out.append("  '" + r + "',")
        out.append('];')
        out.append('')
        specs.append(make_spec(kind, g))

    out.append('const LEVEL_SPECS = [')
    for s in specs:
        out.append('  ' + json.dumps(s, ensure_ascii=False, indent=2).replace('\n', '\n  ') + ',')
    out.append('];')
    out.append('')
    out.append('module.exports = {')
    out.append('  LEVEL_1, LEVEL_2, LEVEL_3, LEVEL_4, LEVEL_5,')
    out.append('  LEVEL_SPECS,')
    out.append('  LEVELS: [LEVEL_1, LEVEL_2, LEVEL_3, LEVEL_4, LEVEL_5]')
    out.append('};')

    path = os.path.join(ROOT, 'subpackages/games/mario/levels.js')
    io.open(path, 'w', encoding='utf-8').write(chr(10).join(out))
    print('已生成 ' + path)
    for i, s in enumerate(specs):
        print('  第 %d 关 %s: %d 敌人, %d 金币' % (i+1, s['name'], len(s['enemies']), len(s['coins'])))


if __name__ == '__main__':
    main()
