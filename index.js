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
app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for simplicity in this local project
}));
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Limit payload size
app.use(express.static(__dirname)); // Serve static files from current directory

// Rate limiting
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 1000, 
    message: 'Too many requests'
});
app.use(limiter);

// Helper for logging
async function logAction(productId, type, details, qty = 0) {
    try {
        await db.query('INSERT INTO logs (product_id, action_type, details, quantity_changed) VALUES (?, ?, ?, ?)', 
            [productId, type, details, qty]);
    } catch (err) { console.error("Logging failed:", err); }
}

// Authentication middleware
const authenticate = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key');
        req.user = decoded;
        next();
    } catch (err) {
        res.status(403).json({ error: 'Invalid token' });
    }
};

// 0. Fetch logs
app.get('/logs', authenticate, async (req, res) => {
    try {
        const [results] = await db.query(`
            SELECT l.*, p.name as product_name, p.item_code 
            FROM logs l 
            LEFT JOIN products p ON l.product_id = p.id 
            ORDER BY l.timestamp DESC LIMIT 100
        `);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

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
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// 2. Create a new category
app.post('/categories', authenticate, async (req, res) => {
    const { name, prefix } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }
    const finalPrefix = prefix ? prefix.toUpperCase() : name.substring(0, 3).toUpperCase();
    try {
        const [result] = await db.query('INSERT INTO categories (name, prefix) VALUES (?, ?)', [name, finalPrefix]);
        res.json({ message: 'Category created!', id: result.insertId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});
// 1. GET ALL PRODUCTS
app.get('/products', async (req, res) => {
    try {
        const { search, category_id } = req.query;
        let sql = `
            SELECT p.*, c.name as category_name 
            FROM products p 
            LEFT JOIN categories c ON p.category_id = c.id
        `;
        let params = [];
        let conditions = [];

        if (search) {
            conditions.push('(p.name LIKE ? OR p.item_code LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }

        if (category_id && category_id !== 'all') {
            conditions.push('p.category_id = ?');
            params.push(category_id);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        
        sql += ' ORDER BY p.created_at DESC';

        const [results] = await db.query(sql, params);
        res.json(results);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error: ' + err.message });
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

        const [categoryBreakdown] = await db.query(`
            SELECT c.name, COALESCE(SUM(p.price * p.stock), 0) as value 
            FROM categories c 
            LEFT JOIN products p ON c.id = p.category_id 
            GROUP BY c.id, c.name
        `);

        res.json({
            totalItems: results[0].totalItems || 0,
            totalValue: parseFloat(results[0].totalValue || 0),
            lowStockCount: results[0].lowStockCount || 0,
            categoryBreakdown: categoryBreakdown.map(item => ({
                name: item.name,
                value: parseFloat(item.value || 0)
            }))
        });
    } catch (err) {
        console.error("STATS_FETCH_ERROR:", err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});
// NEW: ADMIN LOGIN
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    console.log(`Login attempt for user: ${username}`);
    try {
        const [rows] = await db.query('SELECT * FROM admin_users WHERE username = ?', [username]);
        if (rows.length === 0) {
            console.log('Login failed: User not found');
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const user = rows[0];
        
        // Robust password check: handle both hashed and plain text (for initial setup)
        let isValid = false;
        if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
            isValid = await bcrypt.compare(password, user.password);
        } else {
            isValid = (password === user.password);
            // Auto-migrate to hash if it was plain text
            if (isValid) {
                const hashedPassword = await bcrypt.hash(password, 10);
                await db.query('UPDATE admin_users SET password = ? WHERE id = ?', [hashedPassword, user.id]);
                console.log('User password migrated to hash');
            }
        }

        if (!isValid) {
            console.log('Login failed: Incorrect password');
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Generate JWT
        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET || 'secret-key', { expiresIn: '1h' });
        console.log('Login successful');
        res.json({ success: true, token, username: user.username });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// NEW: ADMIN ADVANCED STATS (Protected)
app.get('/admin/stats', authenticate, async (req, res) => {
    try {
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
        res.status(500).json({ error: 'Database error' });
    }
});

// 3. CREATE OR UPDATE PRODUCT (Upsert)
app.post('/products', authenticate, async (req, res) => {
    const { name, price, stock, category_id } = req.body;
    if (!name || !price || !stock || !category_id) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    
    const normalizedSearchName = name.replace(/\s+/g, '').toLowerCase();

    try {
        const [existing] = await db.query(
            'SELECT id, stock, price, name FROM products WHERE LOWER(REPLACE(name, " ", "")) = ?', 
            [normalizedSearchName]
        );

        if (existing.length > 0) {
            const product = existing[0];
            const newStock = Number(product.stock) + Number(stock);
            
            if (Number(price) !== Number(product.price)) {
                await db.query('UPDATE products SET price = ?, previous_price = ?, stock = ?, category_id = ? WHERE id = ?', 
                    [price, product.price, newStock, category_id, product.id]);
                await logAction(product.id, 'PRICE_CHANGE', `Price changed from $${product.price} to $${price} (during upsert)`);
            } else {
                await db.query('UPDATE products SET stock = ?, category_id = ? WHERE id = ?', 
                    [newStock, category_id, product.id]);
            }
            await logAction(product.id, 'INVENTORY_CHANGE', `Added ${stock} units via quick-entry`, stock);
            res.json({ message: `Existing product "${product.name}" updated!`, updated: true });
        } else {
            const [catResult] = await db.query('SELECT id, prefix FROM categories WHERE id = ?', [category_id]);
            if (catResult.length === 0) return res.status(400).json({ error: "Invalid Category" });
            
            const prefix = catResult[0].prefix;
            
            // More robust itemCode generation: Get max existing code suffix for this category
            const [maxResult] = await db.query(
                'SELECT MAX(CAST(SUBSTRING(item_code, LENGTH(?) + 2) AS UNSIGNED)) as maxVal FROM products WHERE category_id = ?',
                [prefix, category_id]
            );
            
            const maxVal = maxResult[0].maxVal !== null ? maxResult[0].maxVal : 0;
            const nextNum = String(maxVal + 1).padStart(3, '0');
            const itemCode = `${prefix}-${nextNum}`;

            const [result] = await db.query('INSERT INTO products (name, price, stock, category_id, item_code) VALUES (?, ?, ?, ?, ?)', [name, price, stock, category_id, itemCode]);
            await logAction(result.insertId, 'CREATE', `New product created with initial stock: ${stock}`, stock);
            res.json({ message: 'Product added!', itemCode });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// 4. STOCK IN (Update stock by item_code)
app.post('/stock-in', authenticate, async (req, res) => {
    const { item_code, quantity } = req.body;
    if (!item_code || !quantity) return res.status(400).json({ error: 'Item code and quantity are required' });
    try {
        const [existing] = await db.query('SELECT id, stock, name FROM products WHERE item_code = ?', [item_code]);
        if (existing.length === 0) return res.status(404).json({ error: 'Product not found' });
        
        const newStock = Number(existing[0].stock) + Number(quantity);
        await db.query('UPDATE products SET stock = ? WHERE id = ?', [newStock, existing[0].id]);
        await logAction(existing[0].id, 'STOCK_IN', `Received ${quantity} units of ${existing[0].name}`, quantity);
        res.json({ success: true, message: 'Stock updated!', newStock });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// UPDATE
app.put('/products/:id', authenticate, async (req, res) => {
    const { name, price, stock, category_id } = req.body;
    if (!name || !price || !stock) return res.status(400).json({ error: 'All fields are required' });
    try {
        const [existing] = await db.query('SELECT price, stock, category_id FROM products WHERE id = ?', [req.params.id]);
        if (existing.length > 0) {
            const oldPrice = existing[0].price;
            const oldStock = existing[0].stock;
            const oldCatId = existing[0].category_id;
            const stockDiff = Number(stock) - Number(oldStock);

            let sql = 'UPDATE products SET name = ?, price = ?, stock = ?';
            let params = [name, price, stock];

            if (category_id && Number(category_id) !== Number(oldCatId)) {
                sql += ', category_id = ?';
                params.push(category_id);
            }

            if (Number(price) !== Number(oldPrice)) {
                sql += ', previous_price = ?';
                params.push(oldPrice);
            }

            sql += ' WHERE id = ?';
            params.push(req.params.id);

            await db.query(sql, params);

            if (Number(price) !== Number(oldPrice)) {
                await logAction(req.params.id, 'PRICE_CHANGE', `Price edited from $${oldPrice} to $${price}`);
            }

            if (stockDiff !== 0) {
                await logAction(req.params.id, 'INVENTORY_CHANGE', `Manual stock adjustment: ${stockDiff > 0 ? '+' : ''}${stockDiff}`, stockDiff);
            }
        }
        res.json({ message: 'Updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// DELETE
app.delete('/products/:id', authenticate, async (req, res) => {
    try {
        const [existing] = await db.query('SELECT name FROM products WHERE id = ?', [req.params.id]);
        const prodName = existing.length > 0 ? existing[0].name : 'Unknown';
        await db.query('DELETE FROM products WHERE id = ?', [req.params.id]);
        await logAction(req.params.id, 'DELETE', `Product "${prodName}" was deleted`);
        res.json({ message: 'Deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});


 

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
