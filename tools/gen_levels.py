# 马里奥关卡生成器：产出 levels.js。
#
# 为什么要生成器：手写 ASCII 地图极易出错（行数不一致、地面行错位、
# 坑宽超过跳跃极限 → 死关）。第 2 关初版就是 7~8 格宽的坑，
# 而实测走路起跳最远只有 5.4 格 —— 必死。生成器统一所有关卡的规格。
#
# 统一规格：
#   · 16 行高（row 0~15）
#   · 地面占 row 14~15
#   · start.row = 站立地面行（玩家脚底 y = start.row）
#   · 实心段 ≥ 7 格（留足助跑），坑宽 ≤ 3 格（跳跃极限 5.4 格）
#   · 管道高 2 格（row 12~13）
#   · 砖块 row 11 / 问号砖 row 10（玩家跳起刚好能顶到）
#   · 终点旗 row 13（走过去就碰到，不用跳）
#
# 用法：python tools/gen_levels.py
# 生成后跑 node tools/mario_level_test.js 验证可达性。

import io
import json
import os

W = 80
H = 16
GROUND_R0 = 14
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def blank():
    return [['.' for _ in range(W)] for _ in range(H)]


def put(g, r, c, ch):
    if 0 <= r < H and 0 <= c < W:
        g[r][c] = ch


def segs_of(width, seg_len, gap_len):
    """(实心段起点, 长度) 列表，段间留 gap_len 的坑"""
    out = []
    c = 0
    while c < width:
        ln = min(seg_len, width - c)
        out.append((c, ln))
        c += ln
        if c + gap_len <= width:
            c += gap_len
    return out


# 每关的 (段长, 坑宽, 名称)
LEVEL_PLAN = [
    (10, 2, '草原新手'),
    (9, 2, '管道迷阵'),
    (10, 2, '空中楼阁'),
    (11, 2, '冰窖迷踪'),
    (10, 2, '城堡决战'),
]


def build(kind):
    seg_len, gap_len, name = LEVEL_PLAN[kind - 1]
    g = blank()
    segs = segs_of(W, seg_len, gap_len)

    # 地面
    for (s, ln) in segs:
        for k in range(ln):
            put(g, GROUND_R0, s + k, '#')
            put(g, GROUND_R0 + 1, s + k, '#')

    # 管道（row 12~13，每两段一个）
    pipes = []
    for i, (s, ln) in enumerate(segs):
        if ln >= 7 and i % 2 == 1:
            c = s + 2
            # 管道只做 1 格高（row 13）。2 格高的管道对休闲玩法太难：
            # 机器人（也代表普通玩家）需要精准时机才能跳上，容易卡死。
            put(g, 13, c, 'P'); put(g, 13, c + 1, 'P')
            pipes.append(c)

    # 砖块 row 11 / 问号砖 row 11（玩家站地面(row14)跳起头顶到 row11~12，能顶到）
    #
    # 关键规则：砖块必须放在「实心段正上方」——即该列下方 3 格内要有地面。
    # 否则会出现悬空砖（玩家在坑上方顶不到砖，滞空被消耗后掉进坑），
    # 或者顶到砖时脚下的支撑突然消失。这是第 1 关初版过不去的主因。
    def has_ground_under(col):
        for r in range(GROUND_R0 - 3, GROUND_R0 + 1):
            if put_ok(g, col, r, '#'):
                return True
        return False

    def put_ok(gr, col, row, ch):
        if 0 <= row < H and 0 <= col < W and gr[row][col] == '.':
            gr[row][col] = ch
            return True
        return False

    bricks = []
    q_low = []
    for i, (s, ln) in enumerate(segs):
        if ln < 7:
            continue
        # 砖块放置规则（每条都是踩过坑换来的）：
        #  1) 只放在第 3 段及以后 —— 第 1 段是出生区，头顶有砖会把玩家顶死
        #  2) 放在段起点 +1（离段末的坑远）—— 顶砖后滞空，下落点比起跳点靠前，
        #     砖块紧邻坑的话玩家会正好掉进坑（实测第 1 关卡在 col21）
        #  3) 必须有地面支撑，且不能是问号砖（问号砖会被顶掉变成普通砖）
        if i >= 2 and ln >= 7:
            bc = s + 1
            if has_ground_under(bc) and has_ground_under(bc + 1):
                put(g, 11, bc, 'B'); put(g, 11, bc + 1, 'B')
                bricks.append(bc)
            # 问号砖放同段更靠里的位置（离坑至少 2 格）
            qc = s + 3
            if i % 2 == 1 and has_ground_under(qc) and has_ground_under(qc + 1):
                put(g, 11, qc, '?'); put(g, 11, qc + 1, '?')
                q_low.append(qc)

    # 悬浮平台 row 6
    plats = []
    if kind in (3, 4, 5):
        for i, (s, ln) in enumerate(segs):
            if i % 2 == 1 and ln >= 8:
                c = s + ln - 2
                for k in range(3):
                    put(g, 6, c + k, '=')
                plats.append((c, 6, 'h', 4, 1.6))

    # Boss 台（仅第 5 关）：中段放一排尖刺 + Boss
    boss = None
    if kind == 5:
        # 尖刺放在段中部（远离两端坑），Boss 在尖刺上方
        mid = segs[len(segs) // 2]
        bc = mid[0] + 4
        # 尖刺放 row 13（贴地），不与 row 11 的砖块重叠。
        # 放 row 12 时，玩家若正好跳起（顶砖）就会撞上尖刺必死。
        for k in range(2):
            put(g, 13, bc + k, 'S')
        boss = {'col': bc + 1, 'row': 11, 'hp': 3}

    # 终点旗 row 13（走过去就碰到）。
    # 放在最后一段起点 +1：段末可能紧邻坑或被截断，放中间会落到坑里
    last_s, last_ln = segs[-1]
    flag_col = last_s + 1
    if last_ln >= 2:
        put(g, 13, flag_col, 'F')

    rows = [''.join(r) for r in g]
    return rows, segs, pipes, bricks, q_low, plats, boss, flag_col, name


def make_spec(kind, segs, plats, boss):
    coins = []
    enemies = []
    items = []
    for i, (s, ln) in enumerate(segs):
        if i % 2 == 1 and ln >= 7:
            coins.append({'col': s + 4, 'row': 9})
    for i, (s, ln) in enumerate(segs):
        # 跳过前 2 段：出生区附近放敌人会「出生即撞死」
        if i % 2 == 0 and i >= 2 and ln >= 7:
            etype = 'goomba' if i % 4 == 0 else 'turtle'
            enemies.append({'type': etype, 'col': s + 4, 'row': 13, 'range': 2})
    for i, (s, ln) in enumerate(segs):
        if i % 3 == 1 and i >= 2 and ln >= 7:
            items.append({'type': 'mushroom', 'col': s + 6, 'row': 10})
    cps = []
    if len(segs) > 3:
        cps.append({'col': segs[len(segs) // 2][0] + 1, 'row': GROUND_R0})
    spec = {
        'name': LEVEL_PLAN[kind - 1][2],
        'start': {'col': 1, 'row': GROUND_R0},
        'coins': coins,
        'enemies': enemies,
        'items': items,
        'platforms': [{'col': p[0], 'row': p[1], 'axis': p[2], 'len': p[3], 'speed': p[4]} for p in plats],
        'checkpoints': cps,
    }
    if boss:
        spec['boss'] = boss
    return spec


def main():
    out = []
    out.append('// 马里奥关卡数据 —— 由 tools/gen_levels.py 生成，请勿手改')
    out.append('// 统一规格：16 行高；地面 row 14~15；start.row = 站立地面行（脚底 y）')
    out.append('// 实心段 ≥ 7 格、坑宽 ≤ 3 格（实测走路跳 5.4 格 / 奔跑跳 8.0 格）')
    out.append('// 管道 row 12~13；砖 row 11；问号砖 row 10；终点旗 row 13')
    out.append('')
    specs = []
    for kind in range(1, 6):
        rows, segs, pipes, bricks, q_low, plats, boss, flag_col, name = build(kind)
        out.append('const LEVEL_%d = [' % kind)
        for r in rows:
            out.append("  '" + r + "',")
        out.append('];')
        out.append('')
        specs.append(make_spec(kind, segs, plats, boss))

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
    io.open(path, 'w', encoding='utf-8').write('\n'.join(out))
    print('已生成 ' + path)


if __name__ == '__main__':
    main()
