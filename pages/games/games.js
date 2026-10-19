// 小笨游戏大厅：数据驱动，新增游戏只改 GAMES 数组 + 加分包页面
const GAMES = [
  {
    id: 'gomoku',
    icon: '⚫',
    name: '小笨五子棋',
    desc: '双人联机 · 房间对战',
    tags: ['联机', '对战'],
    path: '/subpackages/games/gomoku/gomoku',
    online: true
  },
  {
    id: 'coming1',
    icon: '🐍',
    name: '小笨贪吃蛇',
    desc: '单机 · 制作中',
    tags: ['敬请期待'],
    path: '',
    online: false,
    soon: true
  },
  {
    id: 'coming2',
    icon: '🧩',
    name: '小笨 2048',
    desc: '单机 · 制作中',
    tags: ['敬请期待'],
    path: '',
    online: false,
    soon: true
  }
];

Page({
  data: {
    games: GAMES
  },

  enterGame(e) {
    const g = e.currentTarget.dataset.game;
    if (!g || !g.path) {
      wx.showToast({ title: '制作中，敬请期待～', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: g.path });
  }
});
