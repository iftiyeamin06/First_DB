require('dotenv').config();
console.log("Password Loaded:", process.env.DB_PASSWORD ? "YES" : "NO");
const express = require('express');

const mysql = require('mysql2');
const app = express();
const port = 3000;

// Middleware to parse JSON bodies (essential for CRUD)
app.use(express.json());

// 1. Setup Database Connection
const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: process.env.DB_PASSWORD, 
  database: 'my_store'
});

connection.connect(err => {
  if (err) {
    console.error('Error connecting to the database: ' + err.stack);
    return;
  }
  console.log('Connected to MySQL as id ' + connection.threadId);
});

// 2. Your first "Read" (GET) Route
app.get('/', (req, res) => {
  res.send('Welcome to My Store API! Go to /products to see the data.');
});
app.get('/products', (req, res) => {
  connection.query('SELECT * FROM products', (err, results) => {
    if (err) {
      res.status(500).send('Database error');
    } else {
      res.json(results);
    }
  });
});

// Add a new product
app.post('/products', (req, res) => {
  // Destructure the data from the request body
  const { name, price, stock, category } = req.body;

  const sql = 'INSERT INTO products (name, price, stock, category) VALUES (?, ?, ?, ?)';
  
  // The [values] array replaces the "?" safely (to prevent SQL injection)
  connection.query(sql, [name, price, stock, category], (err, result) => {
    if (err) {
      console.error(err);
      res.status(500).send('Error saving to database');
    } else {
      res.status(201).json({ 
        message: 'Product added successfully!', 
        id: result.insertId 
      });
    }
  });
});

// UPDATE a product's price or stock
app.put('/products/:id', (req, res) => {
  const { id } = req.params; // Grabs the ID from the URL
  const {name, price, stock, category } = req.body; // Grabs new data from the body

  const sql = 'UPDATE products SET name = ?, price = ?, stock = ?, category = ? WHERE id = ?';
  
  connection.query(sql, [name, price, stock, category, id], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    
    res.json({ message: 'Product updated successfully' });
  });
});

// DELETE a product
app.delete('/products/:id', (req, res) => {
  const { id } = req.params;

  const sql = 'DELETE FROM products WHERE id = ?';

  connection.query(sql, [id], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    
    res.json({ message: 'Product deleted permanently' });
  });
});
app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
