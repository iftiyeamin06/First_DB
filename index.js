const express = require('express');
const cors = require('cors');
const db = require('./DB/database'); 

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// 1. Fetch all categories
app.get('/categories', (req, res) => {
    db.query('SELECT * FROM categories', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 2. Create a new category
app.post('/categories', (req, res) => {
    const { name, prefix } = req.body;
    const upperPrefix = prefix.toUpperCase();
    
    // Check if prefix already exists
    db.query('SELECT id FROM categories WHERE prefix = ?', [upperPrefix], (err, existing) => {
        if (err) return res.status(500).json({ error: err.message });
        if (existing.length > 0) {
            return res.status(400).json({ error: `The prefix "${upperPrefix}" is already in use by another category.` });
        }

        const sql = 'INSERT INTO categories (name, prefix) VALUES (?, ?)';
        db.query(sql, [name, upperPrefix], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Category created!', id: result.insertId });
        });
    });
});
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
      res.json({
            totalItems: results[0].totalItems || 0,
            totalValue: parseFloat(results[0].totalValue || 0),
            lowStockCount: results[0].lowStockCount || 0
        }); 
    });
});
// NEW: ADMIN LOGIN
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const sql = 'SELECT * FROM admin_users WHERE username = ? AND password = ?';
    db.query(sql, [username, password], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length > 0) {
            // In a real app, use JWT. For this simple DB project, we return a success "token"
            res.json({ success: true, token: 'secret-admin-token', username: results[0].username });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    });
});

// NEW: ADMIN ADVANCED STATS (Protected)
app.get('/admin/stats', (req, res) => {
    const token = req.headers['authorization'];
    if (token !== 'secret-admin-token') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const queries = {
        categoryCount: 'SELECT COUNT(*) as count FROM categories',
        outOfStock: 'SELECT COUNT(*) as count FROM products WHERE stock = 0',
        topValueProducts: 'SELECT name, (price * stock) as total_value FROM products ORDER BY total_value DESC LIMIT 5',
        inventoryHealth: 'SELECT name, stock FROM products WHERE stock < 3'
    };

    const results = {};
    let completed = 0;
    const keys = Object.keys(queries);

    keys.forEach(key => {
        db.query(queries[key], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            results[key] = rows;
            completed++;
            if (completed === keys.length) {
                res.json(results);
            }
        });
    });
});

// 3. CREATE OR UPDATE PRODUCT (Upsert)
app.post('/products', (req, res) => {
    const { name, price, stock, category_id } = req.body;

    // 1. Check if product already exists by name
    db.query('SELECT id, stock FROM products WHERE name = ?', [name], (err, existing) => {
        if (err) return res.status(500).json({ error: err.message });

        if (existing.length > 0) {
            // UPDATE: Add new stock to existing stock and update price
            const newStock = Number(existing[0].stock) + Number(stock);
            const sql = 'UPDATE products SET price = ?, stock = ?, category_id = ? WHERE id = ?';
            db.query(sql, [price, newStock, category_id, existing[0].id], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ message: 'Product updated!', updated: true });
            });
        } else {
            // CREATE: Normal flow
            // 2. GET PREFIX
            db.query('SELECT prefix FROM categories WHERE id = ?', [category_id], (err, catResult) => {
                if (err || catResult.length === 0) return res.status(400).json({ error: "Invalid Category" });
                const prefix = catResult[0].prefix;

                // 3. GENERATE ITEM CODE (Count existing items in this category)
                db.query('SELECT COUNT(*) as count FROM products WHERE category_id = ?', [category_id], (err, countResult) => {
                    const itemCode = `${prefix}-${101 + countResult[0].count}`;

                    // 4. FINAL INSERT
                    const sql = 'INSERT INTO products (name, price, stock, category_id, item_code) VALUES (?, ?, ?, ?, ?)';
                    db.query(sql, [name, price, stock, category_id, itemCode], (err, result) => {
                        if (err) return res.status(500).json({ error: err.message });
                        res.json({ message: 'Product added!', itemCode });
                    });
                });
            });
        }
    });
});
// UPDATE
app.put('/products/:id', (req, res) => {
    const { name, price, stock } = req.body;
    const sql = 'UPDATE products SET name = ?, price = ?, stock = ? WHERE id = ?';
    db.query(sql, [name, price, stock, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Updated' });
    });
});

// DELETE
app.delete('/products/:id', (req, res) => {
    db.query('DELETE FROM products WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Deleted' });
    });
});

 

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
