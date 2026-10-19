App({
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
