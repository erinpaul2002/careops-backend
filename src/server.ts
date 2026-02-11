import express from 'express';

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON
app.use(express.json());

// Basic route
app.get('/', (req, res) => {
  res.send('Hello from CareOps Backend!');
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});