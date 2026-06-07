const lt = require('localtunnel');

(async () => {
  try {
    const tunnel = await lt({ port: 3001 });
    console.log('✅ 公网地址: ' + tunnel.url);
    console.log('📱 手机或任何浏览器都能打开!');
    tunnel.on('close', () => {
      console.log('⚠️ 隧道断开，5秒后重连...');
      setTimeout(main, 5000);
    });
  } catch(e) {
    console.error('连接失败，5秒后重试...', e.message);
    setTimeout(main, 5000);
  }
})();

// 保持进程不退出
setInterval(() => {}, 60000);
