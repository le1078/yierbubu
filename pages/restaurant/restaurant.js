// 小笨餐厅 · 独立页（分享 / 旧路径入口）
// 页面本身只做外壳，真正的界面与逻辑都在 components/restaurant 里，
// 与「小笨生活 · 餐厅」共用同一份组件，避免两套代码走样。
Page({
  onShareAppMessage() {
    return {
      title: '来小笨餐厅点餐吧！',
      path: '/pages/restaurant/restaurant'
    };
  }
});
