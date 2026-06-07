const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('<h1>ChatApp Running!</h1><p>Database URL: ' + (process.env.DATABASE_URL ? 'SET' : 'NOT SET') + '</p><p>Port: ' + process.env.PORT + '</p>');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
});
