// 小笨游戏大厅：数据驱动，新增游戏只改 GAMES 数组 + 加分包页面
const GAMES = [
  {
    id: 'gomoku',
    icon: '⚫',
    name: '小笨五子棋',
    desc: '联机 · 同屏 · 人机 三种玩法',
    tags: ['联机', 'AI', '对战'],
    path: '/subpackages/games/gomokuai/gomokuai',
    online: true
  },
  {
    id: 'xiangqi',
    icon: '♟️',
    name: '小笨中国象棋',
    desc: '联机/同屏/人机 三种玩法',
    tags: ['联机', 'AI', '对战'],
    path: '/subpackages/games/xiangqi/xiangqi',
    online: true
  },
  {
    id: 'mario',
    icon: '🍄',
    name: '小笨马里奥',
    desc: '双人联机 · 五关闯关 + Boss战',
    tags: ['联机', '闯关', 'Boss'],
    path: '/subpackages/games/mario/mario',
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
