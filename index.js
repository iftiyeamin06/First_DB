const express = require('express');
const cors = require('cors');
const db = require('./DB/database'); 

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// 1. GET ALL PRODUCTS
app.get('/products', (req, res) => {
  db.query('SELECT * FROM products', (err, results) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(results);
  });
});

// 2. GET STATS (The math engine)
app.get('/stats', (req, res) => {
    const sql = `
        SELECT 
            COUNT(*) as totalItems,
            COALESCE(SUM(price * stock), 0) as totalValue,
            COUNT(CASE WHEN stock < 5 THEN 1 END) as lowStockCount
        FROM products
    `;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results[0]); 
    });
});

// 3. CREATE PRODUCT
app.post('/products', (req, res) => {
  const { name, price, stock, category } = req.body;
  if (!price || isNaN(price)) {
      return res.status(400).json({ error: "Price must be a valid number!" });
  }

  const sql = 'INSERT INTO products (name, price, stock, category) VALUES (?, ?, ?, ?)';
  db.query(sql, [name, price, stock, category || 'General'], (err, result) => {
    if (err) return res.status(500).send('Error saving to database');
    res.status(201).json({ message: 'Product added!', id: result.insertId });
  });
});

// 4. UPDATE PRODUCT
app.put('/products/:id', (req, res) => {
    const { id } = req.params;
    const data = req.body;
    const fields = [];
    const values = [];

    for (let key in data) {
        fields.push(`${key} = ?`);
        values.push(data[key]);
    }

    if (fields.length === 0) return res.status(400).json({ error: "No data provided" });

    const sql = `UPDATE products SET ${fields.join(', ')} WHERE id = ?`;
    values.push(id);

    db.query(sql, values, (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Updated successfully' });
    });
});

// 5. DELETE PRODUCT
app.delete('/products/:id', (req, res) => {
  db.query('DELETE FROM products WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Deleted' });
  });
});

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});