App({
  onError(err) {
    // 把未捕获异常打全，便于定位「基础库内部报错」到底从哪来
    console.error('[app] onError:', err && err.message, err && err.stack);
  },
  onUnhandledRejection(e) {
    console.error('[app] onUnhandledRejection:', e && e.reason);
  },
  onLaunch() {
    // 云开发初始化（小笨游戏大厅 - 联机对战用）
    if (wx.cloud) {
      wx.cloud.init({
        env: 'cloudbase-d4gqowrctd9dac09f',
        traceUser: true
      });
    }
  }
});
