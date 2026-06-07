const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send(`
    <h1>ChatApp 运行中!</h1>
    <p>Node: ${process.version}</p>
    <p>PORT: ${process.env.PORT}</p>
    <p>DATABASE_URL: ${process.env.DATABASE_URL ? '已设置' : '未设置'}</p>
    <p>时间: ${new Date().toLocaleString()}</p>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    env: {
      PORT: process.env.PORT,
      DATABASE_URL_SET: !!process.env.DATABASE_URL,
    },
    nodeVersion: process.version,
    uptime: process.uptime(),
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
