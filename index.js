const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./DB/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Limit payload size

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// 1. Fetch all categories
app.get('/categories', async (req, res) => {
    try {
        const { search } = req.query;
        let sql = 'SELECT * FROM categories';
        let params = [];

        if (search) {
            sql += ' WHERE name LIKE ? OR prefix LIKE ?';
            params.push(`%${search}%`, `%${search}%`);
        }

        const [results] = await db.query(sql, params);
        res.json(results);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. Create a new category
app.post('/categories', async (req, res) => {
    const { name, prefix } = req.body;
    if (!name || !prefix) {
        return res.status(400).json({ error: 'Name and prefix are required' });
    }
    const upperPrefix = prefix.toUpperCase();
    try {
        const [existing] = await db.query('SELECT id FROM categories WHERE prefix = ?', [upperPrefix]);
        if (existing.length > 0) {
            return res.status(400).json({ error: `The prefix "${upperPrefix}" is already in use by another category.` });
        }
        const [result] = await db.query('INSERT INTO categories (name, prefix) VALUES (?, ?)', [name, upperPrefix]);
        res.json({ message: 'Category created!', id: result.insertId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});
// 1. GET ALL PRODUCTS
app.get('/products', async (req, res) => {
    try {
        const { search, category_id } = req.query;
        let sql = 'SELECT * FROM products';
        let params = [];
        let conditions = [];

        if (search) {
            conditions.push('name LIKE ?');
            params.push(`%${search}%`);
        }

        if (category_id && category_id !== 'all') {
            conditions.push('category_id = ?');
            params.push(category_id);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        const [results] = await db.query(sql, params);
        res.json(results);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. GET STATS (The math engine)
app.get('/stats', async (req, res) => {
    try {
        const [results] = await db.query(`
            SELECT 
                COUNT(*) as totalItems,
                COALESCE(SUM(price * stock), 0) as totalValue,
                COUNT(CASE WHEN stock < 5 THEN 1 END) as lowStockCount
            FROM products
        `);
        res.json({
            totalItems: results[0].totalItems || 0,
            totalValue: parseFloat(results[0].totalValue || 0),
            lowStockCount: results[0].lowStockCount || 0
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});
// NEW: ADMIN LOGIN
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await db.query('SELECT * FROM admin_users WHERE username = ?', [username]);
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const user = rows[0];
        // Check password (assume hashed, but for backward compatibility check plain if not hashed)
        const isValid = user.password.startsWith('$2a$') ? await bcrypt.compare(password, user.password) : password === user.password;
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        // Generate JWT
        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET || 'secret-key', { expiresIn: '1h' });
        res.json({ success: true, token, username: user.username });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// NEW: ADMIN ADVANCED STATS (Protected)
app.get('/admin/stats', async (req, res) => {
    const token = req.headers['authorization'];
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    try {
        jwt.verify(token, process.env.JWT_SECRET || 'secret-key');
        const queries = {
            categoryCount: 'SELECT COUNT(*) as count FROM categories',
            outOfStock: 'SELECT COUNT(*) as count FROM products WHERE stock = 0',
            topValueProducts: 'SELECT name, (price * stock) as total_value FROM products ORDER BY total_value DESC LIMIT 5',
            inventoryHealth: 'SELECT name, stock FROM products WHERE stock < 3'
        };
        const results = {};
        for (const key in queries) {
            const [rows] = await db.query(queries[key]);
            results[key] = rows;
        }
        res.json(results);
    } catch (err) {
        res.status(403).json({ error: 'Invalid token' });
    }
});

// 3. CREATE OR UPDATE PRODUCT (Upsert)
app.post('/products', async (req, res) => {
    const { name, price, stock, category_id } = req.body;
    if (!name || !price || !stock || !category_id) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    try {
        // 1. Check if product already exists by name
        const [existing] = await db.query('SELECT id, stock FROM products WHERE name = ?', [name]);
        if (existing.length > 0) {
            // UPDATE: Add new stock to existing stock and update price
            const newStock = Number(existing[0].stock) + Number(stock);
            await db.query('UPDATE products SET price = ?, stock = ?, category_id = ? WHERE id = ?', [price, newStock, category_id, existing[0].id]);
            res.json({ message: 'Product updated!', updated: true });
        } else {
            // CREATE: Normal flow
            // 2. GET PREFIX
            const [catResult] = await db.query('SELECT prefix FROM categories WHERE id = ?', [category_id]);
            if (catResult.length === 0) {
                return res.status(400).json({ error: "Invalid Category" });
            }
            const prefix = catResult[0].prefix;
            // 3. GENERATE ITEM CODE (Count existing items in this category)
            const [countResult] = await db.query('SELECT COUNT(*) as count FROM products WHERE category_id = ?', [category_id]);
            const itemCode = `${prefix}-${101 + countResult[0].count}`;
            // 4. FINAL INSERT
            await db.query('INSERT INTO products (name, price, stock, category_id, item_code) VALUES (?, ?, ?, ?, ?)', [name, price, stock, category_id, itemCode]);
            res.json({ message: 'Product added!', itemCode });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});
// UPDATE
app.put('/products/:id', async (req, res) => {
    const { name, price, stock } = req.body;
    if (!name || !price || !stock) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    try {
        await db.query('UPDATE products SET name = ?, price = ?, stock = ? WHERE id = ?', [name, price, stock, req.params.id]);
        res.json({ message: 'Updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// DELETE
app.delete('/products/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM products WHERE id = ?', [req.params.id]);
        res.json({ message: 'Deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

 

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
